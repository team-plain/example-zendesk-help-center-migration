import { resolve } from 'node:path';

import { ScriptError } from './errors';

export const PLAIN_API_URL_DEFAULT = 'https://core-api.uk.plain.com/graphql/v1';

export type Config = {
  plainApiKey: string | null;
  plainHelpCenterId: string;
  plainApiUrl: string;
  zendeskSubdomain: string;
  zendeskEmail: string | null;
  zendeskApiToken: string | null;
  zendeskLocale: string;
  categoryIds: number[] | null;
  mappingPath: string;
  fixturePath: string | null;
  dryRun: boolean;
};

export const HELP = `Migrate a Zendesk Help Center into an existing Plain help center.

Usage
  npx tsx src/index.ts [--dry-run] [--mapping file] [--fixture file]

Options
  --dry-run     Print creates and updates. Do not call Plain. Same as DRY_RUN=1.
  --mapping     Zendesk id to Plain id file. Default: ./zendesk-plain-mapping.json
  --fixture     Read categories, sections, and articles from a JSON file instead of Zendesk.
  --help        Show this help.

Environment
  PLAIN_API_KEY            Machine user key with helpCenter:edit. Required unless --dry-run.
  PLAIN_HELP_CENTER_ID     Help center to write into (hc_...). Required.
  PLAIN_API_URL            Optional. Default: ${PLAIN_API_URL_DEFAULT}
  ZENDESK_SUBDOMAIN        Subdomain of {subdomain}.zendesk.com. Required.
  ZENDESK_EMAIL            Agent email. Omit both email and token for a public help center.
  ZENDESK_API_TOKEN        Zendesk API token. Used as email/token basic auth.
  ZENDESK_LOCALE           Default en-us.
  ZENDESK_CATEGORY_IDS     Optional comma-separated category ids.
  MAPPING_FILE             Same as --mapping.
  ZENDESK_FIXTURE          Same as --fixture.
  DRY_RUN                  1 or true.
`;

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Config {
  let dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  let mappingPath = env.MAPPING_FILE?.trim() || 'zendesk-plain-mapping.json';
  let fixturePath = emptyToNull(env.ZENDESK_FIXTURE);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    }
    if (arg === '--mapping' || arg === '--fixture') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new ScriptError(`${arg} needs a file path`);
      }
      index += 1;
      if (arg === '--mapping') mappingPath = value;
      else fixturePath = value;
      continue;
    }
    throw new ScriptError(`Unknown argument ${arg ?? ''}. Run with --help.`);
  }

  const plainHelpCenterId = required(env.PLAIN_HELP_CENTER_ID, 'PLAIN_HELP_CENTER_ID');
  if (/\s/.test(plainHelpCenterId)) {
    throw new ScriptError('PLAIN_HELP_CENTER_ID must not contain whitespace');
  }

  const plainApiKey = emptyToNull(env.PLAIN_API_KEY);
  if (!dryRun && !plainApiKey) {
    throw new ScriptError('PLAIN_API_KEY is required. Pass --dry-run to preview without it.');
  }

  const zendeskSubdomain = normalizeSubdomain(required(env.ZENDESK_SUBDOMAIN, 'ZENDESK_SUBDOMAIN'));
  const zendeskEmail = emptyToNull(env.ZENDESK_EMAIL);
  const zendeskApiToken = emptyToNull(env.ZENDESK_API_TOKEN);
  if ((zendeskEmail == null) !== (zendeskApiToken == null)) {
    throw new ScriptError('Set both ZENDESK_EMAIL and ZENDESK_API_TOKEN, or leave both unset for a public read.');
  }

  return {
    plainApiKey,
    plainHelpCenterId,
    plainApiUrl: emptyToNull(env.PLAIN_API_URL) ?? PLAIN_API_URL_DEFAULT,
    zendeskSubdomain,
    zendeskEmail,
    zendeskApiToken,
    zendeskLocale: normalizeLocale(emptyToNull(env.ZENDESK_LOCALE) ?? 'en-us'),
    categoryIds: parseCategoryIds(env.ZENDESK_CATEGORY_IDS),
    mappingPath: resolve(cwd, mappingPath),
    fixturePath: fixturePath ? resolve(cwd, fixturePath) : null,
    dryRun,
  };
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') throw new ScriptError(`${name} is required`);
  return trimmed;
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function normalizeSubdomain(value: string): string {
  const subdomain = value.toLowerCase().replace(/\.zendesk\.com$/i, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    throw new ScriptError(
      'ZENDESK_SUBDOMAIN must be the subdomain only, for example "acme" from acme.zendesk.com',
    );
  }
  return subdomain;
}

function normalizeLocale(value: string): string {
  const locale = value.toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(locale)) {
    throw new ScriptError(`ZENDESK_LOCALE "${value}" is not a locale like en-us`);
  }
  return locale;
}

function parseCategoryIds(value: string | undefined): number[] | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return null;
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const part of trimmed.split(',')) {
    const token = part.trim();
    if (!/^[0-9]+$/.test(token)) {
      throw new ScriptError(`ZENDESK_CATEGORY_IDS contains "${token}", which is not an id`);
    }
    const id = Number(token);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ScriptError(`ZENDESK_CATEGORY_IDS contains an invalid id "${token}"`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
