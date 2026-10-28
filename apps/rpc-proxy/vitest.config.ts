import { defineConfig } from 'vitest/config';

/**
 * apps/rpc-proxy unit tests. Node environment: the handler under test uses
 * only `fetch`, `Request` and `Response`, which Node 20+ provides on
 * `globalThis`, so the suite needs no workerd runtime. Upstream calls are
 * answered by a stub `fetch`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
