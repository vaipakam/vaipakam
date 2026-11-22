/**
 * The deploy rehearsal's off-chain stage (#3894) — run by the rehearsal
 * driver, once per fork, with `pnpm run rehearsal:offchain`; never by the
 * default `vitest run` or the Anvil scenarios.
 *
 * The one seam is the scenarios' own (`bundleRedirect.ts`): the keeper's and
 * the indexer's deployments import is redirected to the bundle the rehearsal
 * exported into its scratch folder, found from `VAIPAKAM_REHEARSAL_ROOT` by
 * the same rule the indexer's local database entry applies. A missing or
 * misplaced root stops the run here, before any test loads.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { scenarioDeploymentsBundle } from './bundleRedirect';
// @ts-expect-error — plain ESM script, no type declarations.
import { rehearsalPaths, rehearsalRoot } from '../../indexer/scripts/deploy-shared-d1.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = rehearsalRoot(process.env.VAIPAKAM_REHEARSAL_ROOT) as { ok: true; root: string } | { ok: false; message: string };
if (!root.ok) throw new Error(`rehearsal: ${root.message}`);
const { deploymentsPath } = rehearsalPaths(root.root) as { deploymentsPath: string };

export default defineConfig({
  plugins: [scenarioDeploymentsBundle(deploymentsPath)],
  test: {
    root: path.resolve(HERE, '..'),
    environment: 'node',
    include: ['e2e/rehearsal/**/*.rehearsal.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30 * 60_000,
    server: {
      deps: {
        // Transform the workspace contracts package so the redirect above
        // applies to its deployments import.
        inline: [/packages\/contracts/, '@vaipakam/contracts'],
      },
    },
  },
});
