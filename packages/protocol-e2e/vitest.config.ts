/**
 * The protocol's two-chain Anvil scenarios (#848). Run with
 * `pnpm --filter @vaipakam/protocol-e2e run e2e:anvil`; there is no default
 * `vitest run` that picks them up by accident.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: HERE,
    environment: 'node',
    include: ['scenarios/**/*.scenario.ts'],
    globalSetup: [path.join(HERE, 'src', 'globalSetup.ts')],
    setupFiles: [path.join(HERE, 'src', 'setup.ts')],
    // One scenario at a time: each spawns its own pair of nodes.
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
