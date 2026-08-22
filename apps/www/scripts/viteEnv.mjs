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
 * VITE'S OWN LOADER, not a regex over the files (Codex #1895 r2). The
 * first version matched `NAME=value` per line and stripped surrounding
 * quotes, which is most of dotenv and not all of it: an inline comment
 * came through as part of the value, and `VITE_INDEXER_ORIGIN=https://${
 * INDEXER_HOST}` came through unexpanded. Either one makes the prebuild
 * read a DIFFERENT value than the browser bundle beside it — the exact
 * failure this module exists to prevent, reintroduced by the mechanism
 * meant to prevent it. `loadEnv` is what Vite itself calls, so there is
 * one parser and no second interpretation of the same file.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `loadEnv` reads and parses on every call. These scripts ask for a
 * handful of names during one process, so the answer is resolved once.
 *
 * Mode is `production`: these scripts run from `prebuild`, ahead of the
 * production build whose bundle they must agree with. `loadEnv` layers
 * `.env`, `.env.local`, `.env.production` and `.env.production.local` in
 * Vite's own precedence and lets a real `process.env` value win over all
 * of them — the same order the previous hand-rolled list described, now
 * enforced by the implementation that defines it.
 */
let cached;

export function readViteEnv(name) {
  cached ??= loadEnv('production', APP_DIR, 'VITE_');
  // `loadEnv` returns only prefixed names, so anything else is a caller
  // bug rather than a missing configuration — say so instead of handing
  // back `undefined` and letting a default stand in for it.
  if (!name.startsWith('VITE_')) {
    throw new Error(
      `readViteEnv('${name}'): only VITE_-prefixed names reach the browser ` +
        `bundle, so reading any other name here cannot agree with it.`,
    );
  }
  // Vite treats an unset variable as absent; an empty string is a real,
  // deliberate value and is returned as one.
  return cached[name];
}
