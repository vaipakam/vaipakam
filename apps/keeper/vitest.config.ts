import { defineConfig } from 'vitest/config';

// #642 / #222 — minimal node-environment vitest setup for the keeper's pure
// logic (no Worker runtime, no RPC). Test files live under `test/`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
