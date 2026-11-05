# apps/alpha05 verification coverage matrix

One row per user-facing feature, keyed by the matrix row ids the feature
carries (`docs/internal/alpha05/feature-matrix.md`, private). Every
behaviour-changing PR to `apps/alpha05` updates this file in the same diff.
Tiers follow `apps/app/e2e/COVERAGE.md`: **CI-Anvil** (a Playwright spec run
on every PR against the repository's current contracts on a local Anvil) and
**Live-only** (a committed driver run after the deploy, with the reason it
cannot run on Anvil).

| Rows | Feature | CI-Anvil | Live-only |
| --- | --- | --- | --- |
| — | Scaffold: every page-map route answers; a page not built yet says so and links the current app; the capability line states reading, read or unreadable | not yet: the e2e tier lands with the Home PR | a manual load of the deployed Worker after the first deploy, recorded in the PR |
