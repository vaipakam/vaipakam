/**
 * The keeper's single-chain Anvil scenarios (#2496) — run with
 * `pnpm run e2e:anvil` (which runs these, then the two-chain scenarios of
 * `vitest.mesh.config.ts`), never by the default `vitest run` (whose config
 * includes `test/**` only).
 *
 * Global setup (`harness/globalSetup.ts`) builds the chain once: the
 * repository's CURRENT contracts deployed from source onto a bare anvil and
 * configured as a canonical reward deployment. Each scenario then runs on its
 * own node started from that state.
 *
 * The one seam (`bundleRedirect.ts`): the keeper's deployments import is
 * redirected to the bundle global setup wrote, whose 84532 entry is the
 * local Diamond.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { scenarioDeploymentsBundle } from './bundleRedirect';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '.state', 'deployments.json');

export default defineConfig({
  plugins: [scenarioDeploymentsBundle(BUNDLE)],
  test: {
    root: path.resolve(HERE, '..'),
    environment: 'node',
    include: ['e2e/scenarios/**/*.scenario.ts'],
    globalSetup: [path.join(HERE, 'harness', 'globalSetup.ts')],
    setupFiles: [path.join(HERE, 'harness', 'setup.ts')],
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
