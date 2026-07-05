# alpha02 harness seed — verbatim scripts from the testnet review campaigns

These are the ACTUAL Playwright/viem scripts that drove the flows in
[`../Alpha02RegressionFlows.md`](../Alpha02RegressionFlows.md) against
live Base Sepolia during the 2026-06/07 review campaigns (PRs #887,
#943, #982, #991). They are checked in **verbatim as a preservation
snapshot** — the working copies lived in an ephemeral cloud-session
scratchpad and would otherwise be lost. They are NOT wired to CI and
will not run as-is from this directory.

## What's here

- `driver.mjs` — the harness core: chain configs, `clientsFor(chainId)`
  (viem public + per-role wallet clients), and `launch({ role })` which
  boots Chromium with an **injected EIP-1193 wallet** for the given dev
  wallet role (auto-approves prompts, so flows drive unattended).
  Reads `SITE_URL` (deploy or branch-preview URL) and the wallet
  roster.
- `verify.mjs` — `DIAMOND` address, per-facet `abiOf(name)` loaders,
  and the assembled `DIAMOND_ABI` used for on-chain verification reads
  and revert decoding.
- `s01…s13b`, `s-*.mjs` — one scenario per file, named in
  `Alpha02RegressionFlows.md`'s Script column. Each is: drive the UI →
  assert visible copy/state → read the chain → print a verdict.

## What they require (deliberately not in the repo)

- `../testnet-wallets/wallets.json` — four funded dev-wallet keys
  (`lender`, `borrower`, `newLender`, `newBorrower`). Operator-held;
  NEVER commit keys.
- `SITE_URL` env — the alpha02 deployment to drive (production or a
  Cloudflare branch preview).
- Some scripts import a session-local `proxy-setup.mjs` (sandbox
  egress plumbing) — delete that import when running outside such an
  environment.
- Hardcoded artifacts of their campaign runs: specific loan/offer ids
  (`#11`, `#21`, `#22`), Base Sepolia addresses, minted-token amounts.
  Promotion to a real suite means parameterising these (each scenario
  should CREATE the state it needs — see the flows doc's take on
  seeding).

## Promotion path (the intended future)

Port into `apps/alpha02/e2e/` as a two-tier Playwright suite:

1. **Deterministic tier** against an Anvil fork of Base Sepolia
   (`anvil --fork-url …`): CI-able, seeds its own offers/loans, uses
   `evm_increaseTime` for the flows that today require waiting out
   real cooldowns, maturities, and grace windows.
2. **Live smoke tier** against a branch preview + real Base Sepolia
   with the dev wallets: a small subset (connect, one accept, one
   repay, one claim, faucet) run before testnet deploys, tolerant of
   shared mutable state.

Until that lands, these files + the flows doc are the regression
procedure: pick the touched surfaces, adapt the matching scripts, run
them against the branch preview.
