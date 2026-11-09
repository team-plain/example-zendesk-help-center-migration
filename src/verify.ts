import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from './config';
import { ScriptError } from './errors';
import { loadMapping } from './mapping';
import { runMigration } from './migrate';
import { buildPlan } from './plan';
import type { Logger, Mapping, PlannedAction } from './types';
import { authorizationHeader, fetchHelpCenter, readFixture } from './zendesk';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturePath = resolve(root, 'fixtures/help-center.json');

const silent: Logger = { info() {}, warn() {}, error() {} };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function emptyMapping(): Mapping {
  return {
    version: 1,
    helpCenterId: 'hc_dry_run',
    zendeskSubdomain: 'example',
    locale: 'en-us',
    updatedAt: '1970-01-01T00:00:00.000Z',
    categories: {},
    sections: {},
    articles: {},
  };
}

function baseConfig(overrides: Partial<ReturnType<typeof parseConfig>> = {}) {
  return {
    plainApiKey: 'plainApiKey_test',
    plainHelpCenterId: 'hc_dry_run',
    plainApiUrl: 'http://plain.test/graphql',
    zendeskSubdomain: 'example',
    zendeskEmail: null,
    zendeskApiToken: null,
    zendeskLocale: 'en-us',
    categoryIds: null,
    mappingPath: resolve(root, 'zendesk-plain-mapping.json'),
    fixturePath,
    dryRun: true,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const center = readFixture(fixturePath);
  assertPlan(center);
  assertFilteredPlan(center);
  await assertZendeskPaginationAndAuth();
  await assertOffsetPagination();
  await assertForeignPaginationHostRejected();
  await assertDryRunWritesNothing();
  await assertIdempotentPlainWrites();
  assertConfigValidation();
  const cli = assertCliDryRun();
  const live = await assertPublicZendeskFetch();

  console.log(
    JSON.stringify(
      {
        ok: true,
        fixture: {
          categories: center.categories.length,
          sections: center.sections.length,
          articles: center.articles.length,
        },
        cli,
        live,
      },
      null,
      2,
    ),
  );
}

function assertPlan(center: ReturnType<typeof readFixture>): void {
  const mapping = emptyMapping();
  mapping.articles['1000'] = 'hca_existing';
  const { actions, summary } = buildPlan({ center, mapping, categoryIds: null });

  assertEqual(summary.create, 8, 'creates');
  assertEqual(summary.update, 1, 'updates');
  assertEqual(summary.skip, 2, 'skips');
  assertEqual(summary.dropped.categories, 0, 'dropped categories');

  const welcome = article(actions, 1000);
  assertEqual(welcome.action, 'update', 'welcome action');
  assertEqual(welcome.plainId, 'hca_existing', 'welcome plain id');
  assertEqual(welcome.status, 'PUBLISHED', 'welcome status');
  assertEqual(welcome.slug, '1000-welcome', 'welcome slug');
  assertEqual(welcome.sectionId, 100, 'welcome section');
  assert(
    welcome.contentHtml.includes('https://example.zendesk.com/hc/article_attachments/1/pic.png'),
    'image URL should stay on Zendesk',
  );

  const draft = article(actions, 1001);
  assertEqual(draft.status, 'DRAFT', 'draft status');
  assertEqual(draft.action, 'create', 'draft action');

  const empty = article(actions, 1002);
  assertEqual(empty.contentHtml, '<p></p>', 'empty body');
  assertEqual(empty.status, 'PUBLISHED', 'empty body is still published');

  const ungrouped = article(actions, 1004);
  assertEqual(ungrouped.sectionId, null, 'ungrouped section');

  const advanced = group(actions, 'section', 101);
  assertEqual(advanced.parent?.kind, 'section', 'nested section parent kind');
  assertEqual(advanced.parent?.zendeskId, 100, 'nested section parent id');

  const basics = group(actions, 'section', 100);
  assertEqual(basics.parent?.kind, 'category', 'basics parent kind');
  assertEqual(basics.parent?.zendeskId, 10, 'basics parent id');
  assertEqual(basics.description, 'First steps', 'section description');

  const billing = group(actions, 'category', 20);
  assertEqual(billing.description, null, 'blank description');
  assertEqual(billing.parent, null, 'category parent');

  const lost = actions.find((action) => action.kind === 'article' && action.zendeskId === 1003);
  assert(lost?.action === 'skip', 'article in a skipped section is skipped');
  const other = actions.find((action) => action.kind === 'section' && action.zendeskId === 300);
  assert(other?.action === 'skip', 'section with a missing category is skipped');
}

function assertFilteredPlan(center: ReturnType<typeof readFixture>): void {
  const { actions, summary } = buildPlan({
    center,
    mapping: emptyMapping(),
    categoryIds: [10],
  });
  assertEqual(summary.dropped.categories, 1, 'filtered categories');
  assertEqual(summary.dropped.sections, 2, 'filtered sections');
  assertEqual(summary.dropped.articles, 3, 'filtered articles');
  assertEqual(summary.create, 5, 'filtered creates');
  const ids = new Set(actions.map((action) => action.zendeskId));
  for (const id of [20, 200, 300, 1002, 1003, 1004]) {
    assert(!ids.has(id), `filtered id ${id} should be omitted`);
  }
  assert(ids.has(10) && ids.has(100) && ids.has(101) && ids.has(1000) && ids.has(1001), 'kept the category 10 tree');
}

async function assertZendeskPaginationAndAuth(): Promise<void> {
  let categoryCalls = 0;
  const authorizations: string[] = [];
  const expected = authorizationHeader('agent@example.com', 'api-token');
  assert(expected?.startsWith('Basic '), 'basic auth header');

  const fetchImpl: typeof fetch = async (url, init) => {
    const href = String(url);
    const headerMap = init?.headers as Record<string, string>;
    authorizations.push(headerMap.Authorization ?? '');
    if (new URL(href).hostname !== 'example.zendesk.com') {
      throw new Error(`unexpected host ${href}`);
    }
    if (href.includes('/categories')) {
      categoryCalls += 1;
      if (categoryCalls === 1) {
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      }
      if (!href.includes('page%5Bafter%5D') && !href.includes('page[after]')) {
        return jsonResponse(200, {
          categories: [
            {
              id: 1,
              name: 'One',
              description: 'A',
              html_url: 'https://example.zendesk.com/hc/en-us/categories/1-One',
              position: 0,
            },
          ],
          meta: { has_more: true, after_cursor: 'cursor-1' },
          links: {
            next: 'https://example.zendesk.com/api/v2/help_center/en-us/categories.json?page%5Bsize%5D=100&page%5Bafter%5D=cursor-1',
          },
        });
      }
      return jsonResponse(200, {
        categories: [
          {
            id: 2,
            name: 'Two',
            description: '',
            html_url: 'https://example.zendesk.com/hc/en-us/categories/2-Two',
            position: 1,
          },
        ],
        meta: { has_more: false },
        links: {},
      });
    }
    if (href.includes('/sections')) {
      return jsonResponse(200, {
        sections: [
          {
            id: 5,
            name: 'Sec',
            description: null,
            category_id: 1,
            parent_section_id: null,
            position: 0,
            html_url: 'https://example.zendesk.com/hc/en-us/sections/5-Sec',
          },
        ],
        meta: { has_more: false },
      });
    }
    if (href.includes('/articles')) {
      return jsonResponse(200, {
        articles: [
          {
            id: 9,
            title: 'Hi',
            body: '<p>Hi</p>',
            draft: false,
            section_id: 5,
            position: 0,
            html_url: 'https://example.zendesk.com/hc/en-us/articles/9-Hi',
          },
          {
            id: 8,
            title: 'No flag',
            body: '<p>x</p>',
            section_id: 5,
            position: 1,
            html_url: 'https://example.zendesk.com/hc/en-us/articles/8-No-flag',
          },
        ],
        meta: { has_more: false },
      });
    }
    throw new Error(`unexpected ${href}`);
  };

  const center = await fetchHelpCenter({
    subdomain: 'example',
    locale: 'en-us',
    email: 'agent@example.com',
    apiToken: 'api-token',
    fetchImpl,
    logger: silent,
  });

  assertEqual(categoryCalls, 3, 'category requests including the 429 retry');
  assert(authorizations.every((header) => header === expected), 'token auth on every Zendesk request');
  assertEqual(center.categories.map((category) => category.id).join(','), '1,2', 'both category pages');
  const { actions } = buildPlan({ center, mapping: emptyMapping(), categoryIds: null });
  assertEqual(article(actions, 9).status, 'PUBLISHED', 'explicit draft false');
  assertEqual(article(actions, 8).status, 'DRAFT', 'missing draft flag stays unpublished');
}

async function assertOffsetPagination(): Promise<void> {
  const authorizations: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const href = String(url);
    const headerMap = init?.headers as Record<string, string> | undefined;
    authorizations.push(headerMap?.Authorization ?? '');
    if (href.includes('page=2')) {
      return jsonResponse(200, {
        categories: [{ id: 4, name: 'Four', description: null, position: 1 }],
        next_page: null,
      });
    }
    if (href.includes('/categories')) {
      return jsonResponse(200, {
        categories: [{ id: 3, name: 'Three', description: 'C', position: 0 }],
        next_page: 'https://example.zendesk.com/api/v2/help_center/en-us/categories.json?page=2',
      });
    }
    const resource = href.includes('/sections') ? 'sections' : 'articles';
    return jsonResponse(200, { [resource]: [], next_page: null });
  };

  const center = await fetchHelpCenter({
    subdomain: 'example',
    locale: 'en-us',
    email: null,
    apiToken: null,
    fetchImpl,
    logger: silent,
    maxPages: 5,
  });
  assertEqual(center.categories.map((category) => category.name).join(','), 'Three,Four', 'offset pages');
  assert(authorizations.every((header) => header === ''), 'public read sends no Authorization header');
}

async function assertForeignPaginationHostRejected(): Promise<void> {
  const fetchImpl: typeof fetch = async (url) => {
    const href = String(url);
    if (!href.includes('/categories')) throw new Error(href);
    return jsonResponse(200, {
      categories: [{ id: 1, name: 'One', description: null, position: 0 }],
      meta: { has_more: true },
      links: { next: 'https://evil.example/next' },
    });
  };

  try {
    await fetchHelpCenter({
      subdomain: 'example',
      locale: 'en-us',
      email: null,
      apiToken: null,
      fetchImpl,
      logger: silent,
    });
    throw new Error('expected the foreign pagination host to be rejected');
  } catch (error) {
    assert(error instanceof ScriptError, 'foreign host raises ScriptError');
    assert(error.message.includes('evil.example'), error.message);
  }
}

async function assertDryRunWritesNothing(): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), 'zd-plain-dry-'));
  const mappingPath = resolve(directory, 'mapping.json');
  let plainCalled = false;
  let zendeskCalled = false;
  const captured = capture();
  const stats = await runMigration({
    config: baseConfig({ mappingPath, dryRun: true, plainApiKey: null }),
    logger: captured.logger,
    fetchImpl: async () => {
      zendeskCalled = true;
      throw new Error('fixture run must not call Zendesk');
    },
    plainFetch: async () => {
      plainCalled = true;
      throw new Error('dry-run must not call Plain');
    },
  });

  assertEqual(stats.dryRun, true, 'dry-run flag');
  assertEqual(stats.failed, 0, 'dry-run failures');
  assertEqual(stats.created, 9, 'dry-run creates');
  assert(!plainCalled, 'Plain was called during dry-run');
  assert(!zendeskCalled, 'Zendesk was called while a fixture was set');
  assert(!existsSync(mappingPath), 'dry-run created a mapping file');
  assert(captured.lines.some((line) => line.includes('dry-run create article 1000')), 'dry-run lists the article');
  assert(
    captured.lines.some((line) => line.includes('No Plain requests were made.')),
    'dry-run says it made no Plain requests',
  );
}

async function assertIdempotentPlainWrites(): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), 'zd-plain-apply-'));
  const mappingPath = resolve(directory, 'mapping.json');
  const calls: { operationName: string; input: Record<string, unknown>; url: string; authorization: string }[] = [];
  let hits = 0;

  const plainFetch: typeof fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('core-api.uk.plain.com')) throw new Error('refusing the real Plain API');
    hits += 1;
    if (hits === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
    const body = JSON.parse(String(init?.body)) as {
      operationName: string;
      variables: { input: Record<string, unknown> };
    };
    const headers = init?.headers as Record<string, string>;
    calls.push({
      operationName: body.operationName,
      input: body.variables.input,
      url: href,
      authorization: headers.Authorization ?? '',
    });
    const input = body.variables.input;
    if (body.operationName === 'CreateHelpCenterArticleGroup') {
      return jsonResponse(200, {
        data: {
          createHelpCenterArticleGroup: {
            helpCenterArticleGroup: { id: `hcag_${input.slug}` },
            error: null,
          },
        },
      });
    }
    if (body.operationName === 'UpdateHelpCenterArticleGroup') {
      return jsonResponse(200, {
        data: {
          updateHelpCenterArticleGroup: {
            helpCenterArticleGroup: { id: input.helpCenterArticleGroupId },
            error: null,
          },
        },
      });
    }
    if (body.operationName === 'UpsertHelpCenterArticle') {
      const id = typeof input.helpCenterArticleId === 'string' ? input.helpCenterArticleId : `hca_${input.slug}`;
      return jsonResponse(200, {
        data: { upsertHelpCenterArticle: { helpCenterArticle: { id }, error: null } },
      });
    }
    throw new Error(`unexpected ${body.operationName}`);
  };

  const config = baseConfig({ mappingPath, dryRun: false, plainApiUrl: 'http://plain.test/graphql' });
  const first = await runMigration({ config, logger: silent, plainFetch });
  assertEqual(first.failed, 0, 'first apply failures');
  assertEqual(first.created, 9, 'first apply creates');

  const createGroups = calls.filter((call) => call.operationName === 'CreateHelpCenterArticleGroup');
  const updateGroups = calls.filter((call) => call.operationName === 'UpdateHelpCenterArticleGroup');
  const upserts = calls.filter((call) => call.operationName === 'UpsertHelpCenterArticle');
  assertEqual(createGroups.length, 5, 'group creates');
  assertEqual(updateGroups.length, 3, 'description updates');
  assertEqual(upserts.length, 4, 'article upserts');
  assert(calls.every((call) => call.url === 'http://plain.test/graphql'), 'Plain URL');
  assert(
    calls.every((call) => call.authorization === 'Bearer plainApiKey_test'),
    'Plain bearer token',
  );

  const nested = createGroups.find((call) => call.input.slug === '101-advanced');
  assertEqual(nested?.input.parentHelpCenterArticleGroupId, 'hcag_100-basics', 'nested parent id');
  const top = createGroups.find((call) => call.input.slug === '10-getting-started');
  assert(!('parentHelpCenterArticleGroupId' in (top?.input ?? {})), 'top-level group omits parent');
  assert(!('description' in (top?.input ?? {})), 'create group has no description field');

  for (const call of createGroups) assertKeys(call.input, ['helpCenterId', 'name', 'slug', 'parentHelpCenterArticleGroupId']);
  for (const call of updateGroups) {
    assertKeys(call.input, ['helpCenterArticleGroupId', 'name', 'description']);
  }

  const welcome = upserts.find((call) => call.input.slug === '1000-welcome');
  assert(
    String(welcome?.input.contentHtml).includes('https://example.zendesk.com/hc/article_attachments/1/pic.png'),
    'upsert keeps the Zendesk image URL',
  );
  assertEqual(welcome?.input.helpCenterArticleGroupId, 'hcag_100-basics', 'article group id');
  assertEqual(welcome?.input.status, 'PUBLISHED', 'published article');
  assert(!('helpCenterArticleId' in (welcome?.input ?? {})), 'create omits article id');

  const draft = upserts.find((call) => call.input.slug === '1001-coming-soon');
  assertEqual(draft?.input.status, 'DRAFT', 'draft upsert');
  const empty = upserts.find((call) => call.input.slug === '1002-empty-body');
  assertEqual(empty?.input.contentHtml, '<p></p>', 'empty html placeholder');
  const ungrouped = upserts.find((call) => call.input.slug === '1004-ungrouped');
  assertEqual(ungrouped?.input.helpCenterArticleGroupId, null, 'ungrouped article');
  for (const call of upserts) {
    assertKeys(call.input, [
      'helpCenterId',
      'helpCenterArticleId',
      'helpCenterArticleGroupId',
      'title',
      'contentHtml',
      'slug',
      'status',
    ]);
    for (const banned of ['description', 'icon', 'labelTypeIds', 'isFeatured', 'isPopularTopic']) {
      assert(!(banned in call.input), `article input included ${banned}`);
    }
  }

  const mapping = loadMapping(mappingPath, {
    helpCenterId: 'hc_dry_run',
    zendeskSubdomain: 'example',
    locale: 'en-us',
  });
  assertEqual(mapping.articles['1000'], 'hca_1000-welcome', 'mapping stores the article id');
  assertEqual(mapping.sections['101'], 'hcag_101-advanced', 'mapping stores the nested group');
  assertEqual(mapping.sections['300'], undefined, 'skipped section is not mapped');
  assertEqual(mapping.articles['1003'], undefined, 'skipped article is not mapped');

  const before = calls.length;
  const second = await runMigration({ config, logger: silent, plainFetch });
  assertEqual(second.failed, 0, 'second apply failures');
  assertEqual(second.created, 0, 'second apply creates');
  assertEqual(second.updated, 9, 'second apply updates');
  const again = calls.slice(before);
  assert(
    again.every((call) => call.operationName !== 'CreateHelpCenterArticleGroup'),
    're-run created a group',
  );
  const secondUpserts = again.filter((call) => call.operationName === 'UpsertHelpCenterArticle');
  assertEqual(secondUpserts.length, 4, 're-run upserts');
  assert(
    secondUpserts.every((call) => typeof call.input.helpCenterArticleId === 'string'),
    're-run updates by Plain id',
  );
  assertEqual(
    secondUpserts.find((call) => call.input.slug === '1000-welcome')?.input.helpCenterArticleId,
    'hca_1000-welcome',
    'welcome id reused',
  );
}

function assertConfigValidation(): void {
  const env = {
    PLAIN_HELP_CENTER_ID: 'hc_dry_run',
    ZENDESK_SUBDOMAIN: 'Example.zendesk.com',
    DRY_RUN: '1',
  };
  const config = parseConfig([], env, root);
  assertEqual(config.zendeskSubdomain, 'example', 'subdomain normalized');
  assertEqual(config.zendeskLocale, 'en-us', 'default locale');
  assertEqual(config.dryRun, true, 'DRY_RUN');

  expectThrow(() =>
    parseConfig([], { ...env, ZENDESK_EMAIL: 'agent@example.com' }, root),
  );
  expectThrow(() =>
    parseConfig([], { PLAIN_HELP_CENTER_ID: 'hc', ZENDESK_SUBDOMAIN: 'not a host', DRY_RUN: '1' }, root),
  );
}

function assertCliDryRun(): { exitCode: number; articleLine: string } {
  const directory = mkdtempSync(resolve(tmpdir(), 'zd-plain-cli-'));
  const result = spawnSync(
    resolve(root, 'node_modules/.bin/tsx'),
    ['src/index', '--dry-run', '--fixture', fixturePath, '--mapping', resolve(directory, 'mapping.json')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAIN_API_KEY: 'plainApiKey_should_not_be_used',
        PLAIN_HELP_CENTER_ID: 'hc_dry_run',
        PLAIN_API_URL: 'http://127.0.0.1:9/graphql',
        ZENDESK_SUBDOMAIN: 'example',
        ZENDESK_EMAIL: '',
        ZENDESK_API_TOKEN: '',
        ZENDESK_LOCALE: 'en-us',
        ZENDESK_CATEGORY_IDS: '',
        ZENDESK_FIXTURE: '',
        DRY_RUN: '',
        MAPPING_FILE: '',
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`CLI dry-run exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  assert(result.stdout.includes('slug=1000-welcome'), 'CLI prints the article slug');
  assert(result.stdout.includes('No Plain requests were made.'), 'CLI dry-run makes no Plain requests');
  assert(!existsSync(resolve(directory, 'mapping.json')), 'CLI dry-run wrote a mapping file');
  const articleLine = result.stdout.split('\n').find((line) => line.includes('article 1000')) ?? '';
  return { exitCode: result.status ?? 1, articleLine };
}

async function assertPublicZendeskFetch(): Promise<{
  categories: number;
  sections: number;
  articles: number;
  firstCategory: string;
  firstArticleStatus: string;
}> {
  const center = await fetchHelpCenter({
    subdomain: 'support',
    locale: 'en-us',
    email: null,
    apiToken: null,
    pageSize: 30,
    maxPages: 1,
    logger: silent,
  });
  assert(center.categories.length > 0, 'public help center returned no categories');
  assert(center.sections.length > 0, 'public help center returned no sections');
  assert(center.articles.length > 0, 'public help center returned no articles');
  const { actions } = buildPlan({
    center,
    mapping: emptyMapping(),
    categoryIds: null,
  });
  const firstCategory = center.categories[0];
  assert(firstCategory, 'first category');
  const planned = actions.find(
    (action) => action.kind === 'category' && action.zendeskId === firstCategory.id,
  );
  assert(planned?.action === 'create' && planned.kind === 'category', 'public category maps to a create');
  const placed = actions.find(
    (action): action is Extract<PlannedAction, { kind: 'article'; action: 'create' | 'update' }> =>
      action.kind === 'article' && action.action !== 'skip',
  );
  const firstArticleStatus = placed?.status ?? 'unplaced-on-first-page';
  if (placed) {
    assert(
      placed.contentHtml.includes('<') || placed.contentHtml === '<p></p>',
      'content is html',
    );
  }
  return {
    categories: center.categories.length,
    sections: center.sections.length,
    articles: center.articles.length,
    firstCategory: firstCategory.name,
    firstArticleStatus,
  };
}

function group(actions: PlannedAction[], kind: 'category' | 'section', id: number) {
  const action = actions.find((item) => item.kind === kind && item.zendeskId === id);
  if (!action || action.action === 'skip' || action.kind === 'article') {
    throw new Error(`missing ${kind} ${id}`);
  }
  return action;
}

function article(actions: PlannedAction[], id: number) {
  const action = actions.find((item) => item.kind === 'article' && item.zendeskId === id);
  if (!action || action.kind !== 'article' || action.action === 'skip') {
    throw new Error(`missing article ${id}`);
  }
  return action;
}

function assertKeys(input: Record<string, unknown>, allowed: string[]): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(input)) {
    assert(allow.has(key), `unexpected GraphQL input field ${key}`);
  }
}

function expectThrow(run: () => void): void {
  try {
    run();
  } catch (error) {
    assert(error instanceof ScriptError, 'expected ScriptError');
    return;
  }
  throw new Error('expected config parsing to fail');
}

function capture(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push(message),
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
  };
}

await main();
