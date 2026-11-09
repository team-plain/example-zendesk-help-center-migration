import { ScriptError } from './errors';
import type { Logger } from './types';

const MAX_ATTEMPTS = 6;
const MAX_WAIT_MS = 60_000;

type RequestJsonOptions = {
  fetchImpl: typeof fetch;
  url: string;
  init?: RequestInit;
  logger: Logger;
  what: string;
  /** GETs can retry 5xx and network errors. Mutations only retry 429 so a lost response cannot duplicate a create. */
  retryServerErrors: boolean;
  timeoutMs?: number;
};

export type JsonResponse = {
  status: number;
  headers: Headers;
  body: unknown;
};

export async function requestJson(options: RequestJsonOptions): Promise<JsonResponse> {
  const { fetchImpl, url, logger, what, retryServerErrors } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const init = options.init ?? {};
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (retryServerErrors && attempt < MAX_ATTEMPTS - 1) {
        const waitMs = retryDelayMs(attempt, null);
        logger.warn(`${what} failed (${errorMessage(error)}). Retrying in ${waitMs}ms.`);
        await sleep(waitMs);
        continue;
      }
      throw new ScriptError(`${what} failed: ${errorMessage(error)}`);
    }

    const text = await response.text();
    const body = parseBody(text);
    const retryableStatus =
      response.status === 429 || (retryServerErrors && response.status >= 500 && response.status <= 599);

    if (retryableStatus && attempt < MAX_ATTEMPTS - 1) {
      const waitMs = retryDelayMs(attempt, response.headers.get('retry-after'));
      logger.warn(`${what} returned ${response.status}. Retrying in ${waitMs}ms.`);
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      throw new ScriptError(`${what} returned ${response.status}: ${snippet(text)}`);
    }

    return { status: response.status, headers: response.headers, body };
  }

  throw new ScriptError(`${what} failed: ${errorMessage(lastError)}`);
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_WAIT_MS);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), MAX_WAIT_MS);
    }
  }
  return Math.min(500 * 2 ** attempt, MAX_WAIT_MS);
}

function snippet(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact === '') return 'empty body';
  return compact.length > 300 ? `${compact.slice(0, 300)}…` : compact;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
