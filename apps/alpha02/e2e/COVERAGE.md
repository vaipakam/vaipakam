# alpha02 verification coverage matrix

One row per user-facing feature. Every behaviour-changing PR to
`apps/alpha02` updates this file in the same diff (like release-note
fragments and functional specs): add the feature's row, or extend an
existing one, stating WHERE it is verified.

**Tiers**

- **CI-Anvil** — automatic, every PR: a spec under `e2e/tests/` run by
  the `fork-tier scenarios` GitHub job against an Anvil fork of Base
  Sepolia. This is the DEFAULT tier; a feature lands here unless it
  genuinely cannot.
- **Live-only** — a committed driver under `e2e/live/`, run manually
  after the production deploy (the CLAUDE.md live-review DoD) and as a
  batch regression via `e2e/live/run-live-batch.mjs` before testnet
  releases. A live-only row MUST state its reason — typically a
  dependency Anvil cannot honestly fake (deployed Cloudflare Worker,
  Telegram, third-party API, real build-env wiring).

A feature may appear in both tiers (CI-Anvil for the flow mechanics,
live for the deployed-service half).

| Feature | Tier | Where | Live-only reason |
| --- | --- | --- | --- |
| Wallet connect + network gate | CI-Anvil | `tests/01-connect.spec.ts` | — |
| Post lending offer (details → review → sign → on-chain) | CI-Anvil | `tests/02-post-offer.spec.ts` | — |
| Accept offer → loan initiation | CI-Anvil | `tests/03-accept-loan.spec.ts` | — |
| Repay loan | CI-Anvil | `tests/04-repay.spec.ts` | — |
| Cancel offer + cooldown | CI-Anvil | `tests/05-cancel-cooldown.spec.ts` | — |
| Faucet mint + watch-asset | CI-Anvil | `tests/06-faucet.spec.ts` | — |
| Write-path kill switch (#1056) | CI-Anvil | `tests/07-kill-switch.spec.ts` | — (build-env flag reproducible with a second dev server) |
| Pre-sign dry-run footer (#1058/#1059) | CI-Anvil + live | `tests/08-dryrun-footer.spec.ts` + `live/live-dryrun-review.mjs` | Live half re-checks the REAL RPC's revert-data shape — the #1059 bug was invisible on Anvil-adjacent assumptions and only surfaced live. |
| Kill-switch zero-regression sweep | Live-only | `live/live-killswitch-regression.mjs` | Verifies the PRODUCTION build has no flows disabled — a property of the deployed Cloudflare build env, not of the code. |
| Telegram alert rails — LINK flow with wallet signature (#1055/#1056) | Live-only | `live/live-alerts-link.mjs` | Needs the deployed agent Worker (CORS origin gate, D1, signature verification) and the Telegram bot — no Anvil equivalent. |
| Telegram alert rails — unlink + signed due-date opt-out (#1056) | **Gap** | not yet driven; verified manually in PR #1056 (curl matrix in the thread) | Extend `live-alerts-link.mjs` with the unlink click and the opt-out toggle on next touch of the alerts surface. |
| GoPlus token security screen (#1049) | Live-only | scratch drives recorded in PR #1049 (8-check suite); re-commit under `live/` on next touch | Verdicts come from GoPlus's live API; CI would need a mock that proves nothing about real field shapes. |
| VPFI vault deposit/withdraw dry run | **Gap** | not yet driven; the footer LOGIC is covered by `tests/08-dryrun-footer.spec.ts` on the offer path, but no test opens `/vpfi` | Add a `/vpfi` drive to 08 (or a 09) on next touch of the VPFI surface. |

**Gap rows** are allowed but must name the follow-up ('extend X on next touch of Y') — an honest gap beats a false claim; the matrix only works if it never lies.

**When adding a row**: prefer CI-Anvil. If claiming live-only, write
the one-sentence reason — "easier" is not a reason. If a live-only
feature later grows an Anvil-fakeable core (as the alerts CARD's
fail-closed rendering could), split the row.
