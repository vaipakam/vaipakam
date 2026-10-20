/**
 * The keeper's Anvil scenarios (#2496) — run with `pnpm run e2e:anvil`, never
 * by the default `vitest run` (whose config includes `test/**` only).
 *
 * Global setup (`harness/globalSetup.ts`) builds the chain once: the
 * repository's CURRENT contracts deployed from source onto a bare anvil and
 * configured as a canonical reward deployment. Each scenario then runs on its
 * own node started from that state.
 *
 * The one seam: the keeper resolves its chains and Diamond addresses from
 * `@vaipakam/contracts/deployments`, which imports a static
 * `./deployments.json`. The plugin below redirects THAT import (and only
 * that one, from `packages/contracts/src/deployments.ts`) to the bundle
 * global setup wrote, whose 84532 entry is the local Diamond — the same
 * redirect the connected app's e2e build makes (`apps/app/vite.config.ts`).
 * No keeper code is changed or mocked to point it at the node.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '.state', 'deployments.json');

function scenarioDeploymentsBundle(): Plugin {
  return {
    name: 'keeper-e2e-deployments-bundle',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== './deployments.json' || !importer) return null;
      const from = importer.split('?')[0].replace(/\\/g, '/');
      if (!from.endsWith('/packages/contracts/src/deployments.ts')) return null;
      return BUNDLE;
    },
  };
}

export default defineConfig({
  plugins: [scenarioDeploymentsBundle()],
  test: {
    root: path.resolve(HERE, '..'),
    environment: 'node',
    include: ['e2e/scenarios/**/*.scenario.ts'],
    globalSetup: [path.join(HERE, 'harness', 'globalSetup.ts')],
    // One scenario at a time: each spawns its own node, and the keeper's
    // epoch fence and submission queue are process-wide.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15 * 60_000,
    hookTimeout: 20 * 60_000,
    server: {
      deps: {
        // Transform the workspace contracts package so the redirect above
        // applies to its deployments import.
        inline: [/packages\/contracts/, '@vaipakam/contracts'],
      },
    },
  },
});
