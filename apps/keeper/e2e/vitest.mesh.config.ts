/**
 * The keeper's TWO-chain Anvil scenarios (#2516) — a canonical reward chain
 * and a mirror joined by a local CCIP lane (`mesh/fixture.ts`). Run by
 * `pnpm run e2e:anvil` after the single-chain scenarios (`vitest.config.ts`),
 * or alone with `pnpm run e2e:anvil:mesh`; never by the default `vitest run`.
 *
 * A config of its own, not a second include of the single-chain one: the
 * keeper's deployments import is redirected (`bundleRedirect.ts`) to ONE
 * bundle per run, and this one's 84532 entry is the mesh's canonical Diamond,
 * with an 11155111 entry for the mirror beside it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { scenarioDeploymentsBundle } from './bundleRedirect';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '.state', 'mesh', 'deployments.json');

export default defineConfig({
  plugins: [scenarioDeploymentsBundle(BUNDLE)],
  test: {
    root: path.resolve(HERE, '..'),
    environment: 'node',
    include: ['e2e/mesh/scenarios/**/*.scenario.ts'],
    globalSetup: [path.join(HERE, 'mesh', 'globalSetup.ts')],
    // One scenario at a time: each spawns its own pair of nodes, and the
    // keeper's epoch fence and submission queue are process-wide.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20 * 60_000,
    hookTimeout: 30 * 60_000,
    server: {
      deps: {
        inline: [/packages\/contracts/, '@vaipakam/contracts'],
      },
    },
  },
});
