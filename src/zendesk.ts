import { readFileSync } from 'node:fs';

import { ScriptError } from './errors';
import { requestJson } from './http';
import type { Logger, ZendeskArticle, ZendeskCategory, ZendeskHelpCenter, ZendeskSection } from './types';

const PAGE_SIZE = 100;

export type FetchHelpCenterOptions = {
  subdomain: string;
  locale: string;
  email: string | null;
  apiToken: string | null;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  pageSize?: number;
  maxPages?: number;
  fixturePath?: string | null;
};

export async function fetchHelpCenter(options: FetchHelpCenterOptions): Promise<ZendeskHelpCenter> {
  if (options.fixturePath) {
    return readFixture(options.fixturePath);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const host = `${options.subdomain}.zendesk.com`;
  const auth = authorizationHeader(options.email, options.apiToken);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'zendesk-to-plain-help-center',
  };
  if (auth) headers.Authorization = auth;

  const categories = await listAll<ZendeskCategory>({
    host,
    locale: options.locale,
    resource: 'categories',
    pageSize,
    maxPages: options.maxPages,
    headers,
    fetchImpl,
    logger,
    parse: parseCategory,
  });
  const sections = await listAll<ZendeskSection>({
    host,
    locale: options.locale,
    resource: 'sections',
    pageSize,
    maxPages: options.maxPages,
    headers,
    fetchImpl,
    logger,
    parse: parseSection,
  });
  const articles = await listAll<ZendeskArticle>({
    host,
    locale: options.locale,
    resource: 'articles',
    pageSize,
    maxPages: options.maxPages,
    headers,
    fetchImpl,
    logger,
    parse: parseArticle,
  });

  return { categories, sections, articles };
}

export function authorizationHeader(email: string | null, apiToken: string | null): string | null {
  if (!email || !apiToken) return null;
  const token = Buffer.from(`${email}/token:${apiToken}`).toString('base64');
  return `Basic ${token}`;
}

type ListOptions<T> = {
  host: string;
  locale: string;
  resource: 'categories' | 'sections' | 'articles';
  pageSize: number;
  maxPages: number | undefined;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  logger: Logger;
  parse: (value: unknown, index: number) => T;
};

async function listAll<T>(options: ListOptions<T>): Promise<T[]> {
  const items: T[] = [];
  const seenUrls = new Set<string>();
  let url: string | null =
    `https://${options.host}/api/v2/help_center/${encodeURIComponent(options.locale)}/${options.resource}.json?page%5Bsize%5D=${options.pageSize}`;
  let pages = 0;
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;

  while (url) {
    if (pages >= maxPages) break;
    if (seenUrls.has(url)) {
      throw new ScriptError(`Zendesk pagination for ${options.resource} repeated ${url}`);
    }
    seenUrls.add(url);
    pages += 1;

    const response = await requestJson({
      fetchImpl: options.fetchImpl,
      url,
      init: { method: 'GET', headers: options.headers },
      logger: options.logger,
      what: `Zendesk ${options.resource} page ${pages}`,
      retryServerErrors: true,
    });

    const body = asRecord(response.body, `Zendesk ${options.resource} page ${pages}`);
    const rawItems = body[options.resource];
    if (!Array.isArray(rawItems)) {
      throw new ScriptError(`Zendesk ${options.resource} response has no ${options.resource} array`);
    }
    for (const [index, raw] of rawItems.entries()) {
      items.push(options.parse(raw, index));
    }
    options.logger.info(`fetched ${items.length} Zendesk ${options.resource}`);
    url = nextPageUrl(url, body, options.host);
  }

  return items;
}

/**
 * Cursor links are absolute URLs. Stay on the configured Zendesk host.
 */
function nextPageUrl(current: string, body: Record<string, unknown>, expectedHost: string): string | null {
  const meta = isRecord(body.meta) ? body.meta : null;
  const links = isRecord(body.links) ? body.links : null;
  let next: string | null = null;

  if (meta) {
    if (meta.has_more !== true) return null;
    if (typeof links?.next === 'string' && links.next !== '') next = links.next;
    else if (typeof meta.after_cursor === 'string' && meta.after_cursor !== '') {
      const built = new URL(current);
      built.searchParams.set('page[after]', meta.after_cursor);
      next = built.toString();
    } else {
      return null;
    }
  } else if (typeof body.next_page === 'string' && body.next_page !== '') {
    next = body.next_page;
  } else {
    return null;
  }

  const resolved = new URL(next, current);
  if (resolved.protocol !== 'https:' || resolved.hostname !== expectedHost) {
    throw new ScriptError(`Refusing to follow Zendesk pagination onto ${resolved.hostname}`);
  }
  return resolved.toString();
}

export function readFixture(path: string): ZendeskHelpCenter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScriptError(`Could not read fixture ${path}: ${message}`);
  }
  const body = asRecord(parsed, 'fixture');
  return {
    categories: readArray(body.categories, 'categories', parseCategory),
    sections: readArray(body.sections, 'sections', parseSection),
    articles: readArray(body.articles, 'articles', parseArticle),
  };
}

function readArray<T>(value: unknown, name: string, parse: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) throw new ScriptError(`Fixture ${name} must be an array`);
  return value.map((item, index) => parse(item, index));
}

function parseCategory(value: unknown, index: number): ZendeskCategory {
  const record = asRecord(value, `categories[${index}]`);
  const id = readId(record.id, `categories[${index}].id`);
  return {
    id,
    name: requiredName(readStringField(record.name, `categories[${index}].name`), `Category ${id}`),
    description: blankToNull(readStringField(record.description, `categories[${index}].description`)),
    htmlUrl: readStringField(record.html_url, `categories[${index}].html_url`),
    position: readPosition(record.position),
  };
}

function parseSection(value: unknown, index: number): ZendeskSection {
  const record = asRecord(value, `sections[${index}]`);
  const id = readId(record.id, `sections[${index}].id`);
  return {
    id,
    name: requiredName(readStringField(record.name, `sections[${index}].name`), `Section ${id}`),
    description: blankToNull(readStringField(record.description, `sections[${index}].description`)),
    htmlUrl: readStringField(record.html_url, `sections[${index}].html_url`),
    categoryId: readOptionalId(record.category_id, `sections[${index}].category_id`),
    parentSectionId: readOptionalId(record.parent_section_id, `sections[${index}].parent_section_id`),
    position: readPosition(record.position),
  };
}

function parseArticle(value: unknown, index: number): ZendeskArticle {
  const record = asRecord(value, `articles[${index}]`);
  const id = readId(record.id, `articles[${index}].id`);
  const title =
    readStringField(record.title, `articles[${index}].title`) ??
    readStringField(record.name, `articles[${index}].name`);
  return {
    id,
    title: requiredName(title, `Article ${id}`),
    body: readStringField(record.body, `articles[${index}].body`),
    draft: readOptionalBoolean(record.draft, `articles[${index}].draft`),
    htmlUrl: readStringField(record.html_url, `articles[${index}].html_url`),
    sectionId: readOptionalId(record.section_id, `articles[${index}].section_id`),
    position: readPosition(record.position),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ScriptError(`${label} is not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: unknown, label: string): number {
  const id = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new ScriptError(`${label} must be a positive id`);
  }
  return id;
}

function readOptionalId(value: unknown, label: string): number | null {
  if (value == null) return null;
  return readId(value, label);
}

function readStringField(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new ScriptError(`${label} must be a string`);
  return value;
}

function readPosition(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

function readOptionalBoolean(value: unknown, label: string): boolean | null {
  if (value == null) return null;
  if (typeof value !== 'boolean') throw new ScriptError(`${label} must be a boolean`);
  return value;
}

function requiredName(value: string | null, fallback: string): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? fallback : trimmed;
}

function blankToNull(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
