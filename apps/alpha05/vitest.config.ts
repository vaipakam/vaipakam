import { defineConfig } from 'vitest/config';

/**
 * Unit tests for alpha05's pure logic: the shared modules (eligibility,
 * transaction outcomes, copy tiers) and the word-budget guard's rule. A
 * `node` environment; a test that must drive a React hook opts into the
 * DOM per file with `// @vitest-environment jsdom`.
 *
 * Playwright specs will live under `e2e/` as `*.spec.ts` and are not
 * matched here, so the two runners stay separate.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});
