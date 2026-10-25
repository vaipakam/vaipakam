/**
 * The indexer origin this build reads, from `VITE_INDEXER_ORIGIN`, in ONE
 * place for every reader (#43): the pages' live config read
 * (`useProtocolConfig`), the build script that writes the machine-readable
 * exports (`scripts/generate-llms.mjs`), and the build's own
 * Content-Security-Policy, whose `connect-src` allows exactly this origin
 * (`vite.config.ts`). Each passes its own environment, `import.meta.env`
 * in the browser and Vite's `loadEnv` in a build step, so they agree on the
 * value and on the rule that turns it into an origin.
 *
 * Trailing slashes are stripped, and that is not cosmetic. The Worker
 * dispatches on `/^\/config\/(\d+)$/`, so an origin configured as
 * `https://host/` would build `https://host//config/84532`, miss the
 * route, and 404, after which the pages quietly serve bundled defaults:
 * a site that looks fine and is never live, with no error anywhere.
 */
export const DEFAULT_INDEXER_ORIGIN = 'https://indexer.vaipakam.com';

export function indexerOrigin(configured: string | undefined): string {
  return (configured ?? DEFAULT_INDEXER_ORIGIN).replace(/\/+$/, '');
}
