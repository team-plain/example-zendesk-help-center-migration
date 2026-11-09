import { parseConfig } from './config';
import { loadDotEnv } from './env';
import { ScriptError } from './errors';
import { runMigration } from './migrate';

loadDotEnv(process.cwd());

try {
  const config = parseConfig(process.argv.slice(2), process.env, process.cwd());
  const stats = await runMigration({ config });
  if (stats.failed > 0) process.exitCode = 1;
} catch (error) {
  if (error instanceof ScriptError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
}
