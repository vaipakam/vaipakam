import { defineConfig } from 'vite';
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
export default defineConfig({
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
});
