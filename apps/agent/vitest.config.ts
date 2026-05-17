import { defineConfig } from 'vitest/config';

/**
 * apps/agent unit tests. Runs in the Node environment — the diag
 * erasure logic under test (HMAC keying via Web Crypto, EIP-191
 * signature recovery via viem, request parsing) is all available on
 * `globalThis` in Node 20+, so the suite does not need Miniflare /
 * the workerd runtime. D1 is exercised through a small in-memory
 * fake in the test file.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
