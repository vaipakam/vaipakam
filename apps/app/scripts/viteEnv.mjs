/**
 * Read a `VITE_*` value the way the app will see it, from a build script.
 *
 * Vite populates `import.meta.env` from the `.env*` files; a plain Node
 * script sees none of them. So a `process.env`-only read in a prebuild
 * step silently uses defaults while the browser bundle beside it uses
 * the configured values — and the two then describe different
 * deployments without anything saying so. `generate-seo.mjs` had exactly
 * that shape: it read `VITE_APP_PUBLIC_ORIGIN` from `process.env`, so a
 * `.env.production` origin never reached the sitemap it wrote.
 *
 * A DELIBERATE DUPLICATE of `apps/www/scripts/viteEnv.mjs`, for the same
 * reason `src/lib/protocolConsoleVisibility.ts` duplicates its www
 * counterpart: #1854 made these two independent trees that share no
 * source, and a package to hold nine lines would couple the build graphs
 * that split separated. The two copies are expected to agree; neither
 * imports the other.
 *
 * VITE'S OWN LOADER, not a regex over the files. Matching `NAME=value`
 * per line is most of dotenv and not all of it — an inline comment comes
 * through as part of the value, and `${VAR}` interpolation comes through
 * unexpanded. Either makes the prebuild read a DIFFERENT value than the
 * bundle beside it, which is the failure this module exists to prevent.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Mode is `production`: this runs ahead of the production build whose
 * bundle it must agree with. `loadEnv` layers `.env`, `.env.local`,
 * `.env.production` and `.env.production.local` in Vite's precedence and
 * lets a real `process.env` value win over all of them.
 */
let cached;

export function readViteEnv(name) {
  cached ??= loadEnv('production', APP_DIR, 'VITE_');
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
