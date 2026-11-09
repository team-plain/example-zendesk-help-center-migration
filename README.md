# Zendesk Help Center → Plain

Copies a Zendesk Help Center into an existing Plain help center.

Zendesk categories become top-level article groups. Sections become nested article groups (a section with a parent section is nested under that group; otherwise it sits under its category). Articles become help center articles. The article body is Zendesk's HTML, sent as Plain `contentHtml`, which Plain renders directly. There is no markdown field on `upsertHelpCenterArticle`.

Plain's public docs describe creating articles with the API, and a Markdown importer that support hands out on request. None of the public `team-plain` repositories include a Zendesk Help Center migration. This script is that migration.

The Plain help center itself (name, subdomain, branding) is created in the Plain app. This script only writes groups and articles into one you already have.

## What is migrated

| Zendesk | Plain |
| --- | --- |
| Category | Article group, no parent |
| Section | Article group, parent = parent section, or the category when there is no parent section |
| Article title | `title` |
| Article HTML body | `contentHtml` |
| Public URL slug (`…/articles/123-title`) | `slug` |
| Category and section description | Article group `description` |
| `draft: false` | `PUBLISHED` |
| `draft: true`, or a missing `draft` flag | `DRAFT` |

Running it again updates those records instead of creating new ones. The mapping file (`zendesk-plain-mapping.json` by default) stores each Zendesk id next to the Plain id it created. Keep that file. One file per Plain help center, Zendesk subdomain, and locale.

## What is not migrated

- Attachments and images. `src` and `href` values are left as Zendesk wrote them, so files stay hosted on Zendesk. If those URLs require a Zendesk login, they will not load for Plain readers.
- Article comments, votes, subscriptions, and redirects.
- User segments and permission groups. Visibility follows the Plain help center's own access settings.
- Zendesk labels. Plain label types are workspace ids, not Zendesk label names, so they are not guessed.
- The sidebar order. `updateHelpCenterIndex` replaces the whole navigation tree, so this script does not call it. New groups are created in Zendesk `position` order. An existing Plain sidebar is left alone.
- Article group parent and slug on later runs. `UpdateHelpCenterArticleGroupInput` only accepts `name`, `description`, and `icon`. Moving a section in Zendesk after the first import does not reparent the Plain group. Article group membership does update, because `upsertHelpCenterArticle` accepts `helpCenterArticleGroupId`.
- Other locales. Set `ZENDESK_LOCALE` and use a separate mapping file per locale. The same Zendesk article id is shared across translations, so one mapping file must not be reused for two locales.
- Content blocks. If Zendesk leaves `body` empty, the article is imported as an empty paragraph. The content-block API is not called.
- The help center container, custom domains, themes, and search tuning.

Article descriptions are not set. Zendesk articles have no description field, and a re-run does not clear a description you later add in Plain.

## Plain API key

Create a machine user under **Settings → Machine users**, add an API key, and grant:

- `helpCenter:edit` — create and update article groups (`createHelpCenterArticleGroup`, `updateHelpCenterArticleGroup`) and articles (`upsertHelpCenterArticle`)

No other Plain permission is used. The script does not read existing Plain content. It trusts the mapping file.

## Zendesk access

- **Public help center:** leave `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN` unset. Zendesk returns the articles an anonymous reader can see. Drafts are not included.
- **Drafts or restricted articles:** set both. The script sends HTTP basic auth as `{email}/token:{api_token}`, which is Zendesk's API token format. The email is the agent's email, not the token. Create the token in Admin Center → Apps and integrations → Zendesk API.

Requests that come back `429` are retried using the `Retry-After` header, up to 6 attempts, waiting at most 60 seconds. Zendesk reads also retry `5xx` and network errors. Plain creates are not retried on `5xx`: the write may already have landed, and a second create would duplicate a group. Re-run after a failure. Anything already in the mapping file is updated.

Category filters are applied after the three list endpoints return. Filtered-out articles are still downloaded from Zendesk; they are not sent to Plain.

## Run

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
PLAIN_API_KEY=plainApiKey_...
PLAIN_HELP_CENTER_ID=hc_...
ZENDESK_SUBDOMAIN=acme
ZENDESK_EMAIL=agent@acme.com
ZENDESK_API_TOKEN=...
ZENDESK_LOCALE=en-us
```

`ZENDESK_SUBDOMAIN` is the subdomain only (`acme` in `acme.zendesk.com`).

Preview, then import:

```bash
npm run dry-run
npm start
```

Those are `npx tsx src/index.ts --dry-run` and `npx tsx src/index.ts`. The script reads `.env` from the current directory. Values already exported in the shell win.

Import two categories only:

```bash
ZENDESK_CATEGORY_IDS=123,456 npm run dry-run
```

Use another mapping file (do this for a second locale or a second help center):

```bash
npx tsx src/index.ts --mapping ./acme-en-us.json
```

Dry-run prints every create, update, and skip and does not call Plain or write the mapping file. A real run writes the mapping file after each successful create, so an interrupted run can continue.

```bash
npx tsx src/index.ts --help
```

## Check the script

```bash
npm run check
```

`npm run typecheck` is `tsc --noEmit`. `npm run verify` plans the fixture in `fixtures/help-center.json`, retries a mocked Zendesk `429`, runs two applies against a fake Plain API (the second run only updates), and fetches one page from the public Zendesk help center at `support.zendesk.com`. It never calls `https://core-api.uk.plain.com`.
