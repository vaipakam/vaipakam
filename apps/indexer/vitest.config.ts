import { defineConfig } from 'vitest/config';

// Minimal node-environment vitest setup (mirrors apps/keeper) for the
// indexer's pure logic — the #757 webhook auth/parse boundary and the
// Phase B invalidation-key mapping. No Worker runtime, no RPC, no D1:
// everything under test is a side-effect-free export.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
