/**
 * Read a `VITE_*` value the way the app will see it, from a build script.
 *
 * Vite populates `import.meta.env` from the `.env*` files; a plain Node
 * script sees none of them. So a `process.env`-only read in a prebuild
 * step silently uses defaults while the browser bundle beside it uses
 * the configured values — and the two then describe different
 * deployments without anything saying so.
 *
 * `seo-routes.mjs` already had this reader for one flag (Codex #1309 r2).
 * `generate-llms.mjs` needed the same thing for the indexer origin and
 * the docs chain id (Codex #1895 r1), and a second copy of "how do we
 * read the app's environment" is exactly the drift that keeps costing
 * rounds — so it lives here once and both import it.
 *
 * Precedence is Vite's own for a production build, later file winning,
 * with a real `process.env` value overriding every file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Vite's production order: later files win. */
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

export function readViteEnv(name) {
  if (process.env[name] !== undefined) return process.env[name];
  let value;
  for (const file of ENV_FILES) {
    const p = resolve(APP_DIR, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || m[1] !== name) continue;
      value = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return value;
}
