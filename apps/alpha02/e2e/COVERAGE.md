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
| Friendly contract-error messages + tx-error diagnostics capture (borrow-error UX) | CI-Anvil (lib logic) + live | lib logic: `apps/defi/test/lib/decodeContractError.test.ts` (curated reachable-error copy, `humanizeErrorName` fallback, gas-trap only when no selector); alpha02 wiring verified live | The observable behaviour — a real revert (e.g. `MaxLendingAboveCeiling` from an under-collateralised borrow) rendering as plain-language copy in the dry-run footer + submit error instead of the raw selector, the reworded gas-trap message, and the failed tx landing in the diagnostics `lastError` sink / support report — needs a genuine on-chain revert the Anvil fork doesn't reproduce for this path. The decode/humanize logic itself is unit-tested in CI. |
| Kill-switch zero-regression sweep | Live-only | `live/live-killswitch-regression.mjs` | Verifies the PRODUCTION build has no flows disabled — a property of the deployed Cloudflare build env, not of the code. |
| Telegram alert rails — LINK flow with wallet signature (#1055/#1056) | Live-only | `live/live-alerts-link.mjs` | Needs the deployed agent Worker (CORS origin gate, D1, signature verification) and the Telegram bot — no Anvil equivalent. |
| Telegram alert rails — unlink + signed due-date opt-out (#1056) | **Gap** | not yet driven; verified manually in PR #1056 (curl matrix in the thread) | Extend `live-alerts-link.mjs` with the unlink click and the opt-out toggle on next touch of the alerts surface. |
| GoPlus token security screen (#1049) | **Gap** | evidence: the 8-check scratch drive recorded in PR #1049; no committed driver yet (the full suite performs on-chain writes, unfit for the auto-run batch untrimmed) | Commit a batch-safe, read-only screening drive under `live/` on next touch of the GoPlus surface. |
| Token-risk badges on book + guided match, flagged-offer exclusion (#1036 badges slice) | CI-Anvil | `tests/13-token-risk-badges.spec.ts` — GoPlus doesn't index testnets, so the spec spawns a dev server with the test-only `VITE_GOPLUS_EXTRA_CHAINS=84532` knob and route-mocks the GoPlus origin: block row → "Risk flagged" book badge + guided-match exclusion with the honest hidden-count note; warn row → "Caution", still listed; 500 → "Not screened", still listed; control on the standard server pins the no-badges-on-testnets posture. The mocked-origin caveat is inherent (the real API has no flagged token on demand); the classifier itself runs unmocked. | — |
| VPFI vault deposit/withdraw dry run | **Gap** | not yet driven; the footer LOGIC is covered by `tests/08-dryrun-footer.spec.ts` on the offer path, but no test opens `/vpfi` | Add a `/vpfi` drive to 08 (or a 09) on next touch of the VPFI surface. |
| Support drawer: connection health + report-issue (#1028 item 4) | CI-Anvil | `tests/09-diagnostics.spec.ts` | — (health rows against the fork + stub; the crash→report path is exercised by seeding the ErrorBoundary's sessionStorage sink — a deliberate render crash has no production trigger, per the live-review DoD exception) |
| Offer Book on-chain catch-up merge (#1029) | CI-Anvil | `tests/10-offer-book-catchup.spec.ts` | — (the always-live stub can't lag, so the spec uses the stub's PIN mode to freeze the cache while the fork advances — honest manufactured ingest lag; also ABI-drift-guards every terminal-event selector) |
| Copy/legal: mandated disclaimer + consent inline links (#1030) | CI-Anvil | `tests/11-copy-legal.spec.ts` | — |
| Permit2 signature approvals (#1038) | CI-Anvil | `tests/12-permit2.spec.ts`, against the REAL canonical Permit2 on the fork: single-transaction property (Permit2 approval seeded + Diamond-allowance shortfall), silent classic path for wallets WITHOUT a Permit2 approval (hard-zero typed-data requests), and classic fallback on refusal (fixture reject flag). Specs 02/03 do NOT exercise the permit path — their wallets hold no token→Permit2 approval, so they run (and keep covering) the classic sequence. The accept/rent/VPFI-deposit permit wirings share the identical gate+two-phase pattern but only the post path has a spec (see the VPFI gap row). | — |
| CoinGecko market-listing soft signal on pasted addresses (#1036 fallback layer) | **Gap** | not honestly assertable on the fork: testnets have no CoinGecko platform, so the notice is structurally absent there BY DESIGN (`platformForChain(84532) === null`) — asserting its absence would only re-prove the gate, and asserting its presence would need yet another chain-override knob for a soft, non-gating line | Assert on a mainnet-platform chain when one is deployed; until then the pure `reputationNotice` mapping is the reviewed surface and the line is dormant on testnets by intent. |
| ENS reverse-name display (#1030) | **Gap** | not honestly assertable: fork wallets have no mainnet ENS names, so CI can only observe the hex fallback (which every address-rendering spec already exercises) | Assert with an ENS-named wallet if the dev wallet set ever gains one; until then the live review eyeballs the pill/rows for no regression. |
| Support ticket capture — widget contract (#1040 phase 1) | CI-Anvil | `tests/14-support-ticket.spec.ts` — second dev server with `VITE_AGENT_ORIGIN` pointed at a spec-local stub speaking the Worker's HTTP shape: consented send carries the REDACTED diagnostics block + returns a ticket number + ticket-carrying mailto; no consent → no diagnostics in the POST; 503 → plain-words failure + mailto fallback; control on the standard build shows the honest not-configured state. The Worker handler itself is pinned by apps/agent vitest (`test/supportTicket.test.ts`: validation, durable-row-before-notify, 503 on D1 failure, ops-bot skip). | — |
| Support ticket capture — deployed Worker + D1 + ops-Telegram (#1040 phase 1) | Live-only | `live/live-support-ticket.mjs` — sends one clearly-marked probe ticket against the real Worker; PASSES on either honest terminal state (ticket number + ticket-carrying mailto when provisioned, plain-words unavailable + mailto before migration 0028 / secrets land) and FAILS on any dishonest state (silent success, failure without the mail escape, disclosure missing page/network). Ops-bot delivery is eyeballed in the operator chat during the post-deploy review (the driver can't read Telegram). | Needs the deployed agent Worker (real D1 migration, real ops-bot secrets) — the stub tier above deliberately fakes exactly these. |
| ENS lookups — explicit mainnet endpoints, session-static, never the library default | CI-Anvil | `tests/15-rpc-diet.spec.ts` — whole-run assertion that zero requests reach `eth.merkle.io` (viem's implicit chain-1 default; a hit means the ENS transport regressed to `http(undefined)`). Endpoint fallback order and the once-per-session cache are not separately CI-assertable (no mainnet on the fork harness); the always-safe hex fallback is exercised implicitly on every page that renders addresses. | Not separately live-driven — the live RPC audit's budget would catch an ENS lookup storm, and the failure mode is cosmetic (hex fallback). |
| RPC diet — no streamed chain polling (parked book visitor) | CI-Anvil | `tests/15-rpc-diet.spec.ts` — counts JSON-RPC methods over a 15s steady-state window on `/offers` with no WS configured (the harness's and production's posture): `eth_blockNumber` ≤ 2 and `eth_getLogs` ≤ 2 (a watcher regression logs ~12+), and the book must still render. Idle backoff and the WS-mode push path are not CI-assertable (no interaction simulation over minutes; no WS endpoint on the fork harness). | `live/live-rpc-audit.mjs` — 60s steady-state tally against the deployed site with a hard call budget; run post-deploy and in the release batch. |
| Asset picker — faucet test tokens + SelectMenu dropdown | CI-Anvil | `tests/16-asset-picker.spec.ts` — on the fork (Base Sepolia's testnetMocks): all five faucet ERC-20s listed as rows with the "Faucet test token" badge, selecting one closes the menu and shows the live-resolved symbol on the control, and the paste-an-address escape hatch still opens and accepts input. Specs 02/03/08 keep exercising picker-driven flows end-to-end through the shared `chooseMenuValue` helper. Keyboard/AT semantics are code-reviewed (ARIA combobox pattern), not separately spec-asserted. | — |

**Gap rows** are allowed but must name the follow-up ('extend X on next touch of Y') — an honest gap beats a false claim; the matrix only works if it never lies.

**When adding a row**: prefer CI-Anvil. If claiming live-only, write
the one-sentence reason — "easier" is not a reason. If a live-only
feature later grows an Anvil-fakeable core (as the alerts CARD's
fail-closed rendering could), split the row.
