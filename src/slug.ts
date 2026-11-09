/** Plain's article and group inputs take a slug string. Zendesk puts the public slug in `html_url`. */
export function slugFromHelpCenterUrl(
  htmlUrl: string | null,
  id: number,
  label: string,
): string {
  const fromUrl = pathSlug(htmlUrl);
  if (fromUrl) return fromUrl;
  const text = slugify(label);
  return text ? `${id}-${text}` : String(id);
}

export function claimSlug(preferred: string, id: number, used: Set<string>): string {
  const trimmed = preferred.slice(0, 180).replace(/-+$/g, '');
  const base = trimmed || String(id);
  const candidates = [base];
  if (base !== String(id) && !base.endsWith(`-${id}`)) {
    candidates.push(`${base}-${id}`.slice(0, 180).replace(/-+$/g, ''));
  }
  candidates.push(`zd-${id}`);

  for (const candidate of candidates) {
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  const last = `zd-${id}-${used.size}`;
  used.add(last);
  return last;
}

/**
 * `contentHtml` is a non-null string and is rendered as HTML.
 * An empty Zendesk body still has to be valid HTML.
 */
export function toContentHtml(body: string | null): string {
  if (body == null || body.trim() === '') return '<p></p>';
  return body;
}

function pathSlug(htmlUrl: string | null): string | null {
  if (!htmlUrl) return null;
  let segment: string | undefined;
  try {
    segment = new URL(htmlUrl).pathname.split('/').filter(Boolean).pop();
  } catch {
    return null;
  }
  if (!segment) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const cleaned = slugify(decoded);
  return cleaned || null;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}
