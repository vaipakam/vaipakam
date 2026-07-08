import { defineConfig } from 'vitest/config';

/**
 * @vaipakam/lib unit tests. Colocated `src/*.test.ts` files run in the
 * Node environment — everything under test (viem ABI encode/decode, the
 * error normaliser, the chainId → platform map) is pure and framework-
 * agnostic, so no jsdom / worker runtime is needed. Network-touching
 * helpers (`batchCalls`) are exercised against a stubbed `PublicClient`,
 * so the suite makes no real RPC calls and stays deterministic.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
