import { defineConfig } from 'vitest/config';

/**
 * Unit tests for alpha02's pure logic (#1111). Deliberately a `node`
 * environment with NO jsdom/React-Testing-Library harness — the current suite
 * covers framework-free helpers + copy composition, which is all the
 * dynamic-faucet-label regression needs. Component-render tests can add a
 * jsdom project later if a case genuinely requires the DOM.
 *
 * Playwright e2e specs live under `e2e/` and are NOT picked up here (only
 * `src/**` is included), so `vitest run` and `playwright test` stay separate.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
