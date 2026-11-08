import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `viem` imported from `packages/lib` (the shared governance decoder that
 * `src/eventAlerts.ts` uses) resolves to this Worker's own copy. This Worker
 * is outside the pnpm workspace, so CI installs nothing above
 * `packages/lib`. Same rule as `paths` in tsconfig.json and `alias` in
 * wrangler.jsonc.
 */
export default defineConfig({
  resolve: {
    alias: { viem: fileURLToPath(new URL('./node_modules/viem', import.meta.url)) },
  },
});
