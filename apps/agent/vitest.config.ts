import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * apps/agent unit tests. Runs in the Node environment — the diag
 * erasure logic under test (HMAC keying via Web Crypto, EIP-191
 * signature recovery via viem, request parsing) is all available on
 * `globalThis` in Node 20+, so the suite does not need Miniflare /
 * the workerd runtime. D1 is exercised through a small in-memory
 * fake in the test file.
 *
 * `cloudflare:workers` exists only inside workerd, so it resolves to a stub
 * that carries the `DurableObject` base class (#1722). The Telegram state
 * object's logic is tested through its store, never through the stub.
 */
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./test/helpers/cloudflareWorkersStub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
