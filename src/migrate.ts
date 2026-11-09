import type { Config } from './config';
import { ScriptError } from './errors';
import { loadMapping, saveMapping } from './mapping';
import { PlainClient, type CreateGroupInput } from './plain';
import { buildPlan } from './plan';
import type {
  ArticleAction,
  GroupAction,
  Logger,
  Mapping,
  ParentRef,
  PlannedAction,
} from './types';
import { consoleLogger } from './types';
import { fetchHelpCenter } from './zendesk';

export type RunStats = {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
};

export async function runMigration(options: {
  config: Config;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  plainFetch?: typeof fetch;
}): Promise<RunStats> {
  const logger = options.logger ?? consoleLogger;
  const { config } = options;
  const prefix = config.dryRun ? 'dry-run ' : '';

  if (config.fixturePath) logger.info(`${prefix}reading fixture ${config.fixturePath}`);

  const center = await fetchHelpCenter({
    subdomain: config.zendeskSubdomain,
    locale: config.zendeskLocale,
    email: config.zendeskEmail,
    apiToken: config.zendeskApiToken,
    fixturePath: config.fixturePath,
    fetchImpl: options.fetchImpl,
    logger,
  });

  const mapping = loadMapping(config.mappingPath, {
    helpCenterId: config.plainHelpCenterId,
    zendeskSubdomain: config.zendeskSubdomain,
    locale: config.zendeskLocale,
  });

  const { actions, summary } = buildPlan({
    center,
    mapping,
    categoryIds: config.categoryIds,
  });

  const dropped = config.categoryIds
    ? ` (dropped ${summary.dropped.categories} categories, ${summary.dropped.sections} sections, ${summary.dropped.articles} articles)`
    : '';
  logger.info(
    `${prefix}${config.zendeskSubdomain} ${config.zendeskLocale}: ${summary.source.categories} categories, ${summary.source.sections} sections, ${summary.source.articles} articles${dropped}`,
  );
  logger.info(`${prefix}mapping ${config.mappingPath}${config.dryRun ? ' (not written)' : ''}`);

  for (const action of actions) logger.info(formatAction(action, prefix));

  if (config.dryRun) {
    logger.info(
      `${prefix}done: would create ${summary.create}, update ${summary.update}, skip ${summary.skip}. No Plain requests were made.`,
    );
    return {
      dryRun: true,
      created: summary.create,
      updated: summary.update,
      skipped: summary.skip,
      failed: 0,
    };
  }

  if (!config.plainApiKey) {
    throw new ScriptError('PLAIN_API_KEY is required');
  }

  const plain = new PlainClient({
    apiKey: config.plainApiKey,
    apiUrl: config.plainApiUrl,
    fetchImpl: options.plainFetch,
    logger,
  });

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const action of actions) {
    if (action.action === 'skip') continue;
    try {
      if (action.kind === 'article') {
        await applyArticle(action, plain, mapping, config, logger);
      } else {
        await applyGroup(action, plain, mapping, config, logger);
      }
      if (action.action === 'create') created += 1;
      else updated += 1;
    } catch (error) {
      failed += 1;
      logger.error(`failed ${action.kind} ${action.zendeskId}: ${errorMessage(error)}`);
    }
  }

  logger.info(
    `done: created ${created}, updated ${updated}, skipped ${summary.skip}, failed ${failed}`,
  );

  return { dryRun: false, created, updated, skipped: summary.skip, failed };
}

async function applyGroup(
  action: GroupAction,
  plain: PlainClient,
  mapping: Mapping,
  config: Config,
  logger: Logger,
): Promise<void> {
  const table = action.kind === 'category' ? mapping.categories : mapping.sections;

  if (action.action === 'update') {
    if (!action.plainId) throw new ScriptError('update is missing a Plain id');
    await plain.updateArticleGroup({
      helpCenterArticleGroupId: action.plainId,
      name: action.name,
      description: action.description,
    });
    return;
  }

  const parentId = resolveParentId(action, mapping, logger);
  const input: CreateGroupInput = {
    helpCenterId: config.plainHelpCenterId,
    name: action.name,
    slug: action.slug,
  };
  if (parentId) input.parentHelpCenterArticleGroupId = parentId;

  const plainId = await plain.createArticleGroup(input);
  table[String(action.zendeskId)] = plainId;
  // Persist before the description update so a lost response cannot create a second group.
  saveMapping(config.mappingPath, mapping);

  if (action.description) {
    await plain.updateArticleGroup({
      helpCenterArticleGroupId: plainId,
      name: action.name,
      description: action.description,
    });
  }
}

async function applyArticle(
  action: ArticleAction,
  plain: PlainClient,
  mapping: Mapping,
  config: Config,
  logger: Logger,
): Promise<void> {
  let helpCenterArticleGroupId: string | null = null;
  if (action.sectionId != null) {
    const groupId = mapping.sections[String(action.sectionId)];
    if (!groupId) {
      throw new ScriptError(`section ${action.sectionId} has no Plain article group`);
    }
    helpCenterArticleGroupId = groupId;
  }

  const plainId = await plain.upsertArticle({
    helpCenterId: config.plainHelpCenterId,
    ...(action.plainId ? { helpCenterArticleId: action.plainId } : {}),
    helpCenterArticleGroupId,
    title: action.title,
    contentHtml: action.contentHtml,
    slug: action.slug,
    status: action.status,
  });
  mapping.articles[String(action.zendeskId)] = plainId;
  saveMapping(config.mappingPath, mapping);
  logger.info(`saved article ${action.zendeskId} -> ${plainId}`);
}

function resolveParentId(action: GroupAction, mapping: Mapping, logger: Logger): string | null {
  if (!action.parent) return null;
  const direct = lookup(mapping, action.parent);
  if (direct) return direct;

  if (action.parent.kind === 'section' && action.categoryZendeskId != null) {
    const categoryId = mapping.categories[String(action.categoryZendeskId)];
    if (categoryId) {
      logger.warn(
        `${action.kind} ${action.zendeskId} parent section ${action.parent.zendeskId} is not created; nesting under category ${action.categoryZendeskId}`,
      );
      return categoryId;
    }
  }

  throw new ScriptError(
    `parent ${action.parent.kind} ${action.parent.zendeskId} has no Plain id`,
  );
}

function lookup(mapping: Mapping, parent: ParentRef): string | undefined {
  const table = parent.kind === 'category' ? mapping.categories : mapping.sections;
  return table[String(parent.zendeskId)];
}

function formatAction(action: PlannedAction, prefix: string): string {
  if (action.action === 'skip') {
    return `${prefix}skip ${action.kind} ${action.zendeskId} "${oneLine(action.title)}" - ${action.reason}`;
  }
  if (action.kind === 'article') {
    const dest = action.plainId ? ` ${action.plainId}` : '';
    const group = action.sectionId == null ? 'group=none' : `group=section:${action.sectionId}`;
    return `${prefix}${action.action} article ${action.zendeskId}${dest} "${oneLine(action.title)}" slug=${action.slug} status=${action.status} ${group} html=${Buffer.byteLength(action.contentHtml)}B`;
  }
  const dest = action.plainId ? ` ${action.plainId}` : '';
  const parent =
    action.action === 'update'
      ? 'parent=unchanged'
      : action.parent
        ? `parent=${action.parent.kind}:${action.parent.zendeskId}`
        : 'parent=none';
  const description = action.description ? 'description=set' : 'description=none';
  return `${prefix}${action.action} ${action.kind} ${action.zendeskId}${dest} "${oneLine(action.name)}" slug=${action.slug} ${parent} ${description}`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
