# apps/alpha05 verification coverage matrix

One row per user-facing feature, keyed by the matrix row ids the feature
carries (`docs/internal/alpha05/feature-matrix.md`, private). Every
behaviour-changing PR to `apps/alpha05` updates this file in the same diff.
Tiers follow `apps/app/e2e/COVERAGE.md`: **CI-Anvil** (a Playwright spec
under `e2e/tests/`, run on every PR by `.github/workflows/alpha05-e2e.yml`
against the repository's current contracts deployed from source onto a local
Anvil, with `e2e/lib/indexer-stub.mjs` standing in for the indexer and the
RPC proxy) and **Live-only** (a committed driver run after the deploy, with
the reason it cannot run on Anvil).

| Rows | Feature | CI-Anvil | Live-only |
| --- | --- | --- | --- |
| — | Shell: every page-map route answers; the primary navigation is derived from the page map by mode; a page not built yet says so and links the current app for the same job; the build line names the commit | `01-shell.spec.ts` | a load of the deployed Worker after each deploy (the build line must name the merged commit) |
| RB-HELP | The one help panel: opens from any "Why?" on the tier-C explanation of the same key family, deep-links the guide page of the reader's mode, closes from its control, Escape and the scrim, and returns focus | `01-shell.spec.ts` | — |
| ACC-01, ACC-03 | Wallet control: connect; the connected identity as address and network, with its "Why?"; an unsupported network as a tier-A notice whose remedy is a switch to a served network, driven through the wallet | `02-wallet.spec.ts` | WalletConnect and the Coinbase connector cannot be driven on Anvil: a connect through each on the deployed Worker, recorded in the route PR that first signs |
| RB-FUNDS, deployments | Capability line: the routed functions of the protocol contract are READ before any action is offered; the line states the count or that it could not be read | `02-wallet.spec.ts` | — |
| RB-RAILS, ACC-65 | World rail stamp: block and age of the index; stale (half an hour) as a tier-A notice; unreadable as "unavailable, not empty"; an index describing another protocol contract as unknown; the push rail's state named (refused → "unavailable, polling"); Refresh re-reads | `03-rails.spec.ts` | push LIVE needs the deployed indexer's Durable Object: a stamp reading "Push live." on the deployed Worker, recorded after each indexer or alpha05 deploy |
