import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
// slow/fragile on CI runners. The e2e webServer sets APP_E2E=1 to
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
    'Create apps/app/.env.local before building for deploy.';
  if (process.env.REQUIRE_INDEXER_ORIGIN) {
    throw new Error(`[deploy-env guard] ${msg}`);
  }
  console.warn(`\n[deploy-env guard] WARNING: ${msg}\n`);
}

// E2E ONLY (#2334): serve the deployments bundle the e2e global setup wrote
// instead of the committed one. The e2e chain is the repository's current
// contracts deployed from source onto a local anvil, so its addresses exist
// only in that generated file (`e2e/.state/deployments.json`, gitignored);
// the committed bundle's 84532 entry is the live testnet, which is exactly
// what the suite must not read. Exactly one module imports the bundle —
// `packages/contracts/src/deployments.ts` — so this redirects that one
// import and nothing else. Registered only when APP_E2E is set; no other
// dev, build or deploy path sees it.
//
// Playwright starts this server BEFORE global setup runs, and vite
// pre-transforms the entry's imports as soon as the readiness probe loads
// the page, so the first load of this module can arrive before the file
// exists. It therefore WAITS until the bundle is stamped with this run's id
// (`APP_E2E_RUN_ID`, minted by the Playwright config) — which also means a
// file left by an earlier run is never served. A bundle that never arrives
// is an error, never a fallback to the committed one: a silent fallback
// would point the app at the live testnet while every harness helper
// points at the local chain.
function e2eDeploymentsBundle(): Plugin {
  const stateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e', '.state');
  const bundle = path.join(stateDir, 'deployments.json');
  const stamp = path.join(stateDir, 'deployments.run-id');
  const WAIT_MS = 20 * 60_000;
  const stampedForThisRun = (runId: string): boolean => {
    try {
      return fs.readFileSync(stamp, 'utf8').trim() === runId;
    } catch {
      return false;
    }
  };
  return {
    name: 'vaipakam-e2e-deployments-bundle',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './deployments.json' || !importer) return null;
      const from = importer.split('?')[0].replace(/\\/g, '/');
      if (!from.endsWith('/packages/contracts/src/deployments.ts')) return null;
      return bundle;
    },
    async load(id) {
      if (id !== bundle) return null;
      const runId = process.env.APP_E2E_RUN_ID;
      if (!runId) {
        this.error('APP_E2E_RUN_ID is unset — start the e2e app through Playwright, whose config mints it.');
      }
      const deadline = Date.now() + WAIT_MS;
      while (!stampedForThisRun(runId)) {
        if (Date.now() > deadline) {
          this.error(
            `${bundle} was not written for this run within ${WAIT_MS / 60_000} minutes. ` +
              'The e2e global setup writes it after deploying the fixture chain; the ' +
              'app does not fall back to the committed bundle.',
          );
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      return fs.readFileSync(bundle, 'utf8');
    },
  };
}

export default defineConfig(({ mode, command }) => {
  checkIndexerOrigin(mode, command);
  return {
  plugins: process.env.APP_E2E
    ? [e2eDeploymentsBundle(), react()]
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
