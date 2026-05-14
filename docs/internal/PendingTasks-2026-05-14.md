# Pending tasks snapshot — 2026-05-14 (end of merge)

Comprehensive inventory of work remaining after the
`feat/market-rate-widget-and-tiered-ltv` branch merged into main
(`cd1b4de`). All 13 code-side commits of today's session shipped:
autonomous tier-LTV layer, pre-deploy census audit-package,
liquidator-buys-at-discount path, flash-loan keeper bot extension,
the six market-rate-widget follow-up items (a–f), the
protocol-console-docs subdomain move, and the runbook + knob-index
documentation.

**Master kill-switches default OFF** (`depthTieredLtvEnabled` +
`discountPathEnabled`), so this merge ships **zero runtime behaviour
change**. The audit-gated rollout sequence is documented below.

This doc is for future-self / collaborators — a one-stop pickup
list. The canonical authority for each item's status remains the
relevant design / runbook / memory; this doc cross-links.

---

## Group A — Today's threads, operational rollout

Code is landed. What's left is per-chain operator work that should
be done in order: testnets first, then mainnets after the audit.

### A.1 Run `ConfigureV2Factories.s.sol` per chain

Wires Uni-V2-fork pools (Uniswap V2, Sushiswap V2, PancakeSwap V2)
into the `OracleFacet.getLiquidityTier` route search. Currently
dormant on every chain — slots default `address(0)` ⇒ V3-only.

- **What to do**: `forge script
  contracts/script/ConfigureV2Factories.s.sol --rpc-url $RPC
  --broadcast` per chain.
- **Where the addresses come from**: script ships canonical addresses
  for Ethereum / Base / Arbitrum / Optimism / BNB / Polygon PoS,
  verified against each protocol's docs as of 2026-05-14. Override
  per chain via `<CHAIN>_UNI_V2_FACTORY` /
  `<CHAIN>_SUSHI_V2_FACTORY` / `<CHAIN>_PANCAKE_V2_FACTORY`.
- **Why it matters**: long-tail / mid-cap assets that live mostly
  on V2 venues (SHIB-likes, the BNB / PancakeSwap ecosystem) classify
  Tier 0 / Illiquid via the on-chain pre-screen until this runs.
- **Required before**: `setDepthTieredLtvEnabled(true)` per chain.
- **Authority**:
  [`contracts/.env.example`](../../contracts/.env.example) (env-var
  block 312-330) +
  [`MarketRateWidgetAndDepthTieredLTV.md`](../DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md)
  §4.4.

### A.2 Run `DeployFlashLoanLiquidator.s.sol` per chain

Deploys our reference flash-loan-funded liquidator receiver
contract. Until this runs and the keeper bot is wired to the
deployed address per chain, the discount path is callable by
external liquidators only (via `RiskFacet.triggerLiquidationDiscounted`
on the diamond + their own receiver) — our own keeper bot's
flash-loan branch silently skips chains without a deployment.

- **What to do**: walkthrough in
  [`docs/ops/FlashLoanLiquidatorRollout.md`](../ops/FlashLoanLiquidatorRollout.md).
- **6-step shape**: env vars → deploy → refresh consolidated
  deployments JSON → hand-edit `apps/keeper/src/flashLoanProviders.ts`
  `liquidator` slot → flip `DISCOUNT_PATH_ENABLED_<chainId>`
  Worker secret → watch logs.
- **Required before**: `setDiscountPathEnabled(true)` per chain
  (separate kill-switch from depth-tier).

### A.3 Re-run pre-deploy slippage census

Audit-package output from 2026-05-14 captured the system DURING
Aave's response to the April 18 OFT exploit (several L2 WETH LTVs
frozen/zeroed). Once Aave's WETH-restoration AIP fully executes
(expected ~1-2 weeks from 2026-05-14), re-run the census to capture
steady-state peer-consensus values.

- **What to do**: re-run
  `contracts/script/SlippageCensusPreDeploy.s.sol` per chain. Update
  `docs/AuditPackage/pre-deploy-census-<date>/` with new CSVs +
  README.
- **Expected delta**: Arb / Base / Mantle / Linea Tier 3 should
  climb from library-default fallback (73% / 50% / 62% / 50%) into
  real peer-consensus values mirroring Ethereum's 73.37%.
- **Authority**:
  [`docs/AuditPackage/pre-deploy-census-2026-05-14/README.md`](../AuditPackage/pre-deploy-census-2026-05-14/README.md).

### A.4 Auditor engagement

Single review covering all three layers landed today:
- Autonomous tier-LTV layer (Phases 1-7)
- Depth-tiered-LTV init gate + Uni-V2-fork route search +
  liquidity-confidence relay
- Liquidator-buys-at-discount path (`RiskFacet.triggerLiquidationDiscounted`
  + `FlashLoanLiquidator` receiver)

Audit package contents:
- 6 pre-deploy census CSVs +
  [README](../AuditPackage/pre-deploy-census-2026-05-14/README.md)
- Design docs:
  [`AutonomousLtvAndOracleFallback.md`](../DesignsAndPlans/AutonomousLtvAndOracleFallback.md),
  [`MarketRateWidgetAndDepthTieredLTV.md`](../DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md),
  [`FlashLoanLiquidationPath.md`](../DesignsAndPlans/FlashLoanLiquidationPath.md)
- Operator runbook:
  [`FlashLoanLiquidatorRollout.md`](../ops/FlashLoanLiquidatorRollout.md)
- Forge regression: 1897 / 0 / 5 across 90 suites at HEAD `cd1b4de`.

### A.5 Risk-committee sign-off

Per-chain decision before flipping either kill-switch.

### A.6 Per-chain governance flips

Two independent kill-switches per chain (each can be staged
separately):
- `ConfigFacet.setDepthTieredLtvEnabled(true)` — activates the
  higher-LTV regime via per-tier caps.
- `ConfigFacet.setDiscountPathEnabled(true)` — activates the
  liquidator-buys-at-discount path.

ADMIN_ROLE pre-handover; TimelockController-gated 48h
post-handover. Suggested order:
1. Base Sepolia (full dry-run).
2. Lowest-TVL mainnet first (Optimism or BNB Chain) — wait 1-2
   weeks per chain between promotions.
3. Ethereum mainnet last.

---

## Group B — New ToDo items added 2026-05-14

User-added entries in
[`docs/ToDo.md`](../ToDo.md). Each is feature-sized; each
deserves alternatives discussion before coding (per the
project-wide
[propose-alternatives](../../../.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory/feedback_propose_alternatives.md)
rule).

### ~~B.1 WETH-vs-native-token check on Polygon / BNB~~ — CLOSED 2026-05-14

Walked every Solidity + TypeScript code path that touches WETH.
Result: **0 gaps**. The "admin-configurable WETH address per
chain" the ToDo entry asked about is already the design —
`OracleAdminFacet.setWethContract(address)` is owner-only and
must be set per chain. The VPFIBuyAdapter payment-token policy
already enforces correct chain-specific values for the cross-chain
buy lane.

Full audit:
[`WethChainSafetyAudit-2026-05-14.md`](WethChainSafetyAudit-2026-05-14.md).

One cheap natspec hardening landed alongside the audit doc —
strengthened `OracleAdminFacet.setWethContract` natspec to
explicitly call out the BNB/Polygon chain-specific addresses +
the "wrapped-native ≠ bridged-WETH" distinction. Operator-
documentation improvement; no behaviour change.

### ~~B.2 Internal-liquidation ledger proposal~~ — CLOSED 2026-05-15

End-to-end shipped on `feat/internal-liquidation-ledger` (11
commits in the vaipakam repo + 1 in `vaipakam-keeper-bot`).
Design doc + implementation summary in
[`docs/DesignsAndPlans/InternalLiquidationLedger.md`](../DesignsAndPlans/InternalLiquidationLedger.md)
§0.0. The original 3-band 85/90/92 LTV proposal pivoted during
plan-mode Q&A into the cleaner shape that ships:
- The "match-liquidate floor" is per-loan, snapshotted from
  the existing per-tier liquidation threshold at `initiateLoan`
  → no separate knob to drift away from the per-asset risk
  gradient.
- "Is the ledger really needed?" — view-based design wins. No
  storage, no add/remove maintenance. `MetricsFacet.getMatchEligibleLoans`
  filters `s.activeLoanIdsList` per-block.
- 1% per-leg incentive, governance-tunable up to 3% cap, paid
  synchronously on match.
- 2-way partial-match α + 3-way A→B→C→A chain. Both kill-
  switched off by default; production stays in today's external-
  liquidation behaviour until per-chain governance flips it on.

**Forge regression**: 1936 passed / 0 failed / 5 skipped on the
non-invariant suite. Frontend + worker typechecks green.
**Audit**: bundles with A.4 next engagement per D7 of the
plan-mode Q&A.

**B.2 follow-ups** (intentionally out of scope for this branch
— track here so they don't get lost):

- **B.2.1 Per-page badge wiring** for `LoanStatus.InternalMatched`.
  Label exists in `apps/defi/src/types/loan.ts`; pages that
  render loan status (Dashboard, LoanTimeline,
  LenderEarlyWithdrawal, BorrowerPreclose, Refinance,
  NftVerifier) treat unknown-variant as Active for now.
- **B.2.2 MyLoans "near-liquidation" filter bucket** — surface
  borrowers' loans currently in
  `[liquidationLtvBpsAtInit − 5%, liquidationLtvBpsAtInit)`
  with a CTA to top-up collateral / repay before the match
  window opens.
- **B.2.3 Indexer schema row for `InternalMatchExecuted`** —
  currently allowlisted in `apps/indexer/scripts/check-event-coverage.mjs`
  (event surfaces via live `getLoanDetails` for now). Wire a
  proper handler in `chainIndexer.ts` + activity-event row.
- **B.2.4 3-way chain in the keeper-bot** —
  `vaipakam-keeper-bot/src/detectors/internalMatcher.ts`
  finds 2-way pairs today. The contract supports 3-way via
  `triggerInternalMatchLiquidation(idA, idB, idC)`; bot needs
  a second pass over loans that didn't pair up 2-way to detect
  3-cycles.
- **B.2.5 Companion bot pair-search algorithm doc** in
  `vaipakam-keeper-bot/docs/InternalMatchSearchAlgorithm.md`
  (per D8 of plan-mode Q&A). Spec: candidate enumeration, pair
  scoring, 3-way chain detection, gas-vs-profit threshold logic.

---

## Group C — Older `docs/ToDo.md` items (security-adjacent)

### C.1 Off-chain data-fetch audit

> "Need to check what are all the data that we fetch off chain
> and need to see that no stale/missing data is fetched."

Surfaces to walk:
- `apps/indexer/src/*` — chain-event indexer
- `apps/agent/src/*` — Telegram / Push notification surface
- `apps/keeper/src/*` (multiple): `dailyOracleSnapshot.ts`,
  `liquidityConfidence.ts`, `serverQuotes.ts`, `dexDirectQuotes.ts`
- Any external API fetch — DeFiLlama, CoinGecko, 0x, 1inch,
  Balancer V2 subgraph

For each: define stale-data policy (TTL, retry, fail-soft vs
fail-closed), document defenses against API-side outages /
returning malformed payloads. ~1-2 days.

### C.2 Timelock / admin-key compromise — config range-bounding audit

> "What if timelocker keys are compromised or admin keys are
> compromised? are all configs are range-bounded?"

Walk every `ConfigFacet.set*` setter and verify each parameter has
a meaningful `[floor, ceil]` so a compromised key can't push to a
degenerate value. Many already do (tier-LTV bounds, secondary-
oracle deviation, auto-pause window, Pyth confidence ceiling, etc.)
but a systematic sweep + written audit are missing.

- **Output**: a table of every governance knob with current bound +
  rationale + worst-case-attack-bounded-by.
- **Authority**:
  [`docs/ops/AdminConfigurableKnobsAndSwitches.md`](../ops/AdminConfigurableKnobsAndSwitches.md)
  is the existing partial index. Audit should expand it into the
  full inventory.
- ~Half a day to a full day.

---

## ~~Group D — Deploy-script modernization~~ — CLOSED 2026-05-14 (commit `a74bc7c`)

All three ratification points resolved + two new operational
guards landed today:

- **Q1**: single `TIMELOCK_PROPOSER` env var via deterministic
  CREATE2. ✅ Already in scripts; ratified.
- **Q2**: PAUSER_ROLE direct to Safe, skipping Timelock.
  ✅ Already in scripts; ratified.
- **Q3**: Deployer EOA → Admin EOA (immediate in-script) →
  Admin EOA does config → Admin EOA → Multisig (final, with
  manual-pause + auditable-resume). ✅ Ratified — matches the
  scripts' existing topology.
- **NEW guard 1**: Mainnet HW-signer hard-fail in
  `deploy-mainnet.sh` preflight. Requires
  `--confirm-mainnet-hardware-signer` flag (operator's attested
  statement that Admin EOA's signing path is a hardware wallet,
  not a .env hot key). Testnet (`deploy-testnet.sh`) accepts the
  same flag in WARN-mode for rehearsal muscle-memory.
- **NEW guard 2**: 48-hour Admin EOA → Multisig handover deadline.
  Both scripts write the timestamp at `--phase contracts` end;
  mainnet HARD-FAILS at `--phase handover` if >48h elapsed unless
  `--reset-handover-deadline` is passed (with audit-trail logging
  to `.markers/handover-deadline.log`). Testnet WARN-only.
- `deploy-chain.sh` (one-shot quick-iter, no `--phase handover`
  step) gets only a top-of-file comment explaining why neither
  guard attaches.

The 2026-05-09 memory's "~250 lines surgery + ~150 lines surgery"
estimate was based on stale state — the legacy-path debt
(`frontend/` / `ops/hf-watcher/`) had ALREADY been paid down in
commits between 2026-05-09 and 2026-05-14. Today's commit added
208 lines net (the two new guards + their documentation), not the
~400 lines the original memory anticipated.

---

## Group E — Background follow-ups

No urgency; track as long-running maintenance items.

### E.1 Aave V4 peer-reader in `LibPeerLTV`

Aave V4 launched on Ethereum mainnet 2026-03-30 with a
hub-and-spoke architecture. As of today it's Ethereum-only — no
L2 rollouts. When V4 expands to a chain we read on, `LibPeerLTV`
needs a third reader (alongside the existing V3 + Compound V3
readers). Hub-and-spoke means the read API is fundamentally
different — each Spoke is a separate market.

- **Trigger**: V4 mainnet on any chain in our 6-chain target set
  beyond Ethereum.
- **Authority**: memory
  [`aave-v4-peer-reader-followup`](../../../.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory/project_aave_v4_peer_reader_followup.md).

### E.2 Balancer V2 SOR direct-quote in `dexDirectQuotes.ts`

Deferred at the flash-loan-thread closure — 0x v2 + 1inch v6
cover the common case. Balancer V2 SOR requires either the
Balancer SDK or a custom solver against the Vault's `batchSwap`
interface.

- **Trigger**: an asset whose deep liquidity is exclusively on
  Balancer V2 weighted pools (rare; weEth and similar LSTs would
  qualify if they were the principal asset).

### E.3 Range Orders matcher deployment

`apps/keeper/src/matcher.ts` is wired into the cron handler but
not deployed (Cloudflare Worker not pushed). The 2-week testnet
bake is the deliberate gate before deploy.

### E.4 Widget i18n for non-en locales

Piece A's
[market-rate widget](../../apps/defi/src/components/app/MarketRateWidget.tsx)
currently ships English text + i18next fallback for the 9 other
locales (es / fr / de / hi / zh / ko / ja / ar / ta). Translation
strings need to land in
[`apps/defi/src/i18n/locales/*.json`](../../apps/defi/src/i18n/locales/).

### E.5 Liquidity-confidence relay — Tier-3 advisory `LIQ_TIER3_DISABLE_DEFI_LISTING`

The Tier-3 "battle-tested elsewhere" advisory in
[`apps/keeper/src/liquidityConfidence.ts`](../../apps/keeper/src/liquidityConfidence.ts)
is a 2-of-3 ensemble:
- Signal ①: DeFiLlama listing on Aave V3 / Compound V3 / Morpho
  with TVL ≥ `LIQ_TIER3_MIN_TVL_USD` (default $10M)
- Signal ②: CoinGecko market cap ≥ `LIQ_TIER3_MIN_MCAP_USD`
  (default $1B)
- Signal ③: CoinGecko 24h volume ≥ `LIQ_TIER3_MIN_VOL_USD`
  (default $50M)

Operators can disable signal ① via
`LIQ_TIER3_DISABLE_DEFI_LISTING=true` if DeFiLlama becomes
unreliable — the ensemble collapses to 2-of-2 CoinGecko-only
(stricter, safe). Decision is operational; no code change needed.

---

## Group F — `docs/ToDo.md` backlog

[The ToDo file](../ToDo.md) has ~80 open items (T-001 through
T-600). Highlights worth triaging:

| ID | Theme |
|---|---|
| **T-600** | Treasury contract architecture + fund distribution model |
| **T-068** | Migration from LayerZero to Chainlink CCIP (large; cross-chain layer change) |
| **T-069** | ops/subgraph + ops/tenderly notifications setup |
| **T-067** | Create-offer-in-offer-book improvements with market-anchor display |
| **T-066, T-065** | OfferBook sorting + duration bucketing UX |
| **T-064** | Multilingual SEO indexing for non-landing pages |

Worth a dedicated triage session — most look like incremental
UX/feature work rather than blockers, but the absence of a
prioritization layer makes them easy to lose track of.

---

## Recommended next session

Order by impact + dependency:

| Priority | Item | Effort | Why |
|---|---|---|---|
| 🔥 **Block 1** | C.2 — config range-bounding audit | Half a day | Cheap; protects against admin-key compromise; lightweight to do before auditor engagement (which itself is in Block 3). |
| 🔥 **Block 1** | D — deploy-script modernization (resume with the 3 ratification points) | ~1 day | Blocks ALL of Group A. Until the scripts handle the new source tree, every per-chain rollout step needs manual workarounds. |
| ⚡ **Block 2** | A.1 — `ConfigureV2Factories.s.sol` on Base Sepolia | ~1 hour | Smallest immediate operational step; validates the rollout pipeline. |
| ⚡ **Block 2** | A.2 — `DeployFlashLoanLiquidator.s.sol` on Base Sepolia | ~1 hour | Exercises the keeper-bot flash-loan path end-to-end before audit. |
| 📋 **Block 3** | A.4 / A.5 — auditor + risk-committee engagement | Async | The gating step for mainnet rollout. Start the conversation now; the deliverables are already in place. |
| ✏ **Block 4** | B.2 — internal-liquidation ledger design doc | ~1 day | Architecturally interesting; deserves alternatives discussion. Could land independently of Block 3. |
| ✏ **Block 4** | B.1 — WETH-on-Polygon/BNB audit | ~1 day | Mechanical; isolate any latent regressions before mainnet rollout. |

Background items (Group E) tick over as triggers fire — no
proactive scheduling needed.
