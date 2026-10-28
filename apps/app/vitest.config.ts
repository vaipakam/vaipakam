import { defineConfig } from 'vitest/config';

/**
 * Unit tests for app's pure logic (#1111). A `node` environment by
 * default, with no React-Testing-Library harness — most of the suite covers
 * framework-free helpers + copy composition.
 *
 * A test that must drive a React HOOK opts into the DOM per file with a
 * `// @vitest-environment jsdom` first line and uses the small
 * `src/test/renderHook.ts` (React's own `act` and a root, no extra
 * dependency). The first is the forced close-out's submission lifecycle
 * (#2090), whose effect ordering and query-cache interaction cannot be
 * asserted any other way. Keep it per file: the rest of the suite gains
 * nothing from a DOM and pays for one.
 *
 * Playwright e2e specs live under `e2e/` and are NOT picked up here — they
 * are `*.spec.ts` under `e2e/tests/`, which neither glob below matches, so
 * `vitest run` and `playwright test` stay separate.
 *
 * The second and third globs cover pure helpers extracted OUT of the
 * harness so they can be regression-tested. `e2e/live/redact.mjs` is the
 * first: it keeps provider credentials out of drive output that gets pasted
 * into public PR threads, and it shipped with three key shapes unmasked
 * because it was only ever checked by a throwaway script (#1529 review
 * round 20). `e2e/lib/anvil.ts` joined post-#1979 for the same reason: its
 * fork-usability classifier decides whether a CI failure is retried as a
 * flake or reported as real, and the permissive direction silently
 * launders bugs. Driver logic worth trusting belongs here, not in a
 * scratch file.
 *
 * Only `*.test.ts` under `e2e/lib/` is matched — the Playwright specs are
 * `*.spec.ts` under `e2e/tests/`, so the two runners stay separate.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'e2e/live/**/*.test.mjs',
      'e2e/lib/**/*.test.ts',
    ],
  },
});
