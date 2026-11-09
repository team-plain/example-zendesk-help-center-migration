import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { ScriptError } from './errors';
import type { Mapping } from './types';

export type MappingIdentity = {
  helpCenterId: string;
  zendeskSubdomain: string;
  locale: string;
};

export function loadMapping(path: string, identity: MappingIdentity): Mapping {
  if (!existsSync(path)) {
    return {
      version: 1,
      helpCenterId: identity.helpCenterId,
      zendeskSubdomain: identity.zendeskSubdomain,
      locale: identity.locale,
      updatedAt: new Date().toISOString(),
      categories: {},
      sections: {},
      articles: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScriptError(`Could not read mapping file ${path}: ${message}`);
  }
  if (!isRecord(parsed)) throw new ScriptError(`Mapping file ${path} is not a JSON object`);
  if (parsed.version !== 1) throw new ScriptError(`Mapping file ${path} has an unsupported version`);

  const helpCenterId = requiredString(parsed.helpCenterId, 'helpCenterId');
  const zendeskSubdomain = requiredString(parsed.zendeskSubdomain, 'zendeskSubdomain');
  const locale = requiredString(parsed.locale, 'locale');
  if (helpCenterId !== identity.helpCenterId) {
    throw new ScriptError(
      `Mapping file is for help center ${helpCenterId}, not ${identity.helpCenterId}. Use a different MAPPING_FILE.`,
    );
  }
  if (zendeskSubdomain !== identity.zendeskSubdomain) {
    throw new ScriptError(
      `Mapping file is for Zendesk subdomain ${zendeskSubdomain}, not ${identity.zendeskSubdomain}.`,
    );
  }
  if (locale !== identity.locale) {
    throw new ScriptError(
      `Mapping file is for locale ${locale}, not ${identity.locale}. Use one mapping file per locale.`,
    );
  }

  return {
    version: 1,
    helpCenterId,
    zendeskSubdomain,
    locale,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    categories: readIdMap(parsed.categories, 'categories'),
    sections: readIdMap(parsed.sections, 'sections'),
    articles: readIdMap(parsed.articles, 'articles'),
  };
}

export function saveMapping(path: string, mapping: Mapping): void {
  const next: Mapping = { ...mapping, updatedAt: new Date().toISOString() };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, path);
  mapping.updatedAt = next.updatedAt;
}

function readIdMap(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) throw new ScriptError(`Mapping ${label} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) throw new ScriptError(`Mapping ${label} key "${key}" is not a Zendesk id`);
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ScriptError(`Mapping ${label}.${key} is not a Plain id`);
    }
    out[key] = id;
  }
  return out;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScriptError(`Mapping ${label} is missing`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
