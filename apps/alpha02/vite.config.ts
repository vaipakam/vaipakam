import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { execSync } from 'node:child_process';

// Stamp the commit + build time into the bundle (shown on the Help page)
// so a tester can always tell which build they're looking at.
process.env.VITE_BUILD_HASH = (() => {
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
})();
process.env.VITE_BUILD_TIME = new Date().toISOString();

// The Cloudflare plugin boots a workerd sandbox with the dev server —
// unnecessary for the fork-tier e2e (plain SPA serving is enough) and
// slow/fragile on CI runners. The e2e webServer sets ALPHA02_E2E=1 to
// serve without it; every normal dev/build/deploy path is unchanged.

// Deploy-env guard (live-review incident 2026-07-14): a production
// build WITHOUT `VITE_INDEXER_ORIGIN` compiles and deploys cleanly but
// silently ships the app in its all-chain fallback posture — no
// indexer book, no push rail, no config snapshot. CI/preview builds
// legitimately lack operator env, so a bare `vite build` only WARNS;
// the `deploy` script sets REQUIRE_INDEXER_ORIGIN=1 so the operator
// path hard-fails instead. (`loadEnv`, not `process.env`: Vite reads
// .env.local itself and does not populate process.env at config time.)
function checkIndexerOrigin(mode: string, command: string): void {
  if (command !== 'build') return;
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (env.VITE_INDEXER_ORIGIN || process.env.VITE_INDEXER_ORIGIN) return;
  const msg =
    'VITE_INDEXER_ORIGIN is not set — this build will run WITHOUT the ' +
    'indexer (no offer book feed, no push rail, no config snapshot). ' +
    'Create apps/alpha02/.env.local before building for deploy.';
  if (process.env.REQUIRE_INDEXER_ORIGIN) {
    throw new Error(`[deploy-env guard] ${msg}`);
  }
  console.warn(`\n[deploy-env guard] WARNING: ${msg}\n`);
}

export default defineConfig(({ mode, command }) => {
  checkIndexerOrigin(mode, command);
  return {
  plugins: process.env.ALPHA02_E2E
    ? [react()]
    : [react(), cloudflare()],
  build: {
    rollupOptions: {
      output: {
        // UX-005 — split the big, rarely-changing dependency groups out
        // of the entry chunk so the boot payload shrinks (2.4 MB → 118
        // kB) and vendor code stays cacheable across app deploys and
        // downloads in PARALLEL with the entry (faster than one serial
        // file). Note: main.tsx statically imports the wallet providers,
        // so wallet-vendor is still on the critical path to first
        // interactive paint — the boot splash in index.html covers that
        // download; deferring the providers so the shell paints first is
        // the larger refactor tracked in #1170 (Codex #1169 r1).
        // Authored as a function (not the object form) because the
        // Cloudflare plugin narrows `output.manualChunks` to the
        // function signature.
        manualChunks(id: string) {
          // UX2-008 — isolate the combined Diamond ABI (all 60+ facet
          // JSONs spread into `DIAMOND_ABI_VIEM`, ~761 kB uncompressed)
          // into its OWN chunk. It's imported by always-on shell code
          // (sanctions screening, indexer sync) so it can't be deferred
          // off first paint without lazy-loading security machinery, but
          // splitting it out (a) shrinks the every-deploy entry chunk by
          // the ABI's whole weight, (b) lets it download in PARALLEL with
          // the entry instead of inflating it, and (c) makes it a stable,
          // long-cached file — the ABIs only change on a contract deploy,
          // so its hash survives ordinary app deploys and every in-app
          // route navigation reuses it from cache. Same rationale as the
          // vendor splits below (UX-005). Matched before the node_modules
          // branch because the workspace package resolves via a symlink,
          // not under node_modules.
          if (/[\\/]packages[\\/]contracts[\\/]src[\\/]abis[\\/]/.test(id)) {
            return 'contract-abis';
          }
          if (id.includes('node_modules')) {
            if (
              /[\\/]node_modules[\\/](wagmi|viem|connectkit|@tanstack[\\/]react-query|@wagmi)[\\/]/.test(
                id,
              )
            ) {
              return 'wallet-vendor';
            }
            if (
              /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
                id,
              )
            ) {
              return 'react-vendor';
            }
          }
          return undefined;
        },
      },
    },
  },
};
});
