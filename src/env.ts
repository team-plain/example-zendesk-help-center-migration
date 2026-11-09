import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ScriptError } from './errors';

/**
 * Load `.env` without a dependency. Existing process env wins so a shell
 * export is never overwritten by a stale file.
 */
export function loadDotEnv(cwd: string, filename = '.env'): void {
  const path = resolve(cwd, filename);
  if (!existsSync(path)) return;

  const text = readFileSync(path, 'utf8');
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const equals = stripped.indexOf('=');
    if (equals <= 0) {
      throw new ScriptError(`${filename}:${index + 1} is not KEY=VALUE`);
    }

    const key = stripped.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ScriptError(`${filename}:${index + 1} has an invalid name`);
    }

    let value = stripped.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
