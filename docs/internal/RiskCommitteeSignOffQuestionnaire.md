# Risk-Committee Sign-Off Questionnaire — Vaipakam mainnet rollout

**Status**: DRAFT 2026-05-15 — first-cut shape. Iterate with the committee chair before circulating to signers.

**Item**: A.5 from
[`PendingTasks-2026-05-14.md`](PendingTasks-2026-05-14.md).
Gated on A.4 (auditor engagement) completing.
Tracked on [`@vaipakam-labs` Project](https://github.com/users/vaipakam/projects/1).

**Scope**: **protocol-wide**, not per-chain. Per-chain residual risk
is enumerated and confirmed via a readback artifact (see §8) but
the committee signs off ONCE on policy + procedure, not chain-by-
chain.

**Reading order for signers**:

1. This questionnaire (committee-facing summary).
2. [`OffchainDataFetchAudit-2026-05-15.md`](OffchainDataFetchAudit-2026-05-15.md).
3. [`ConfigKnobBoundsAudit-2026-05-14.md`](ConfigKnobBoundsAudit-2026-05-14.md).
4. [`WethChainSafetyAudit-2026-05-14.md`](WethChainSafetyAudit-2026-05-14.md).
5. External auditor's report (A.4 — pending).
6. [`docs/AuditPackage/pre-deploy-census-2026-05-14/`](../AuditPackage/pre-deploy-census-2026-05-14/) — pre-deploy slippage census.
7. [`docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md`](../DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md) — depth-tier-LTV regime design.
8. [`docs/DesignsAndPlans/FlashLoanLiquidationPath.md`](../DesignsAndPlans/FlashLoanLiquidationPath.md) — discount-path liquidation design.
9. [`docs/DesignsAndPlans/InternalLiquidationLedger.md`](../DesignsAndPlans/InternalLiquidationLedger.md) — internal-match path.
10. [`docs/ops/GovernanceRunbook.md`](../ops/GovernanceRunbook.md) — what happens AFTER sign-off (timelock-gated flip ceremony).

---

## 1. Audit posture

> Have all critical / high findings from the external audit been
> remediated? Are medium findings explicitly accepted with rationale
> + owner?

**Internal pre-audit posture (already documented)**:

| Audit | Findings | Status |
| --- | --- | --- |
| `OffchainDataFetchAudit-2026-05-15.md` (C.1) | 0 critical, 0 high; F-1 doc fix, F-2 refactor, F-3 event enrichment | F-1 landed PR #7; F-2 + F-3 landed PR #10 |
| `ConfigKnobBoundsAudit-2026-05-14.md` (C.2) | 3 real gaps + 1 false-positive | All 3 fixed |
| `WethChainSafetyAudit-2026-05-14.md` (B.1) | 0 gaps after 3 fixes from first pass | Clean |

**External auditor posture (pending A.4)**: TBD. The committee
should not sign off until the auditor's findings have been
remediated or explicitly accepted with rationale.

---

## 2. Parameter sanity

> Are the per-tier LTV caps (Tier 1: 50%, Tier 2: 60%, Tier 3:
> peer-consensus-derived ~73%) consistent with the slippage census +
> comparable to Aave V3 / Compound V3 / Morpho on the same assets?

**Pre-committed answer**: parameters are sound. Derivation is
multi-source + verifiable:

- Tier 1 / Tier 2 are **library defaults** (50% / 60%) — conservative,
  source-code constants in `LibVaipakam.tierLtvLibraryDefaultBps`,
  inside the audit-package bound-check
  ([`tierLtvBoundsBps`](../../contracts/src/libraries/LibVaipakam.sol)).
- Tier 3 is **peer-consensus-derived** from Aave V3 + Compound V3
  via `LibPeerLTV.aggregateTierLtv`, with a 14-day stale-cache
  fallback to the library default — see
  [`OffchainDataFetchAudit-2026-05-15.md`](OffchainDataFetchAudit-2026-05-15.md) Part 4.
- Pre-deploy slippage census output corroborates the on-chain depth
  classifier returns the expected tier per asset — see
  [`docs/AuditPackage/pre-deploy-census-2026-05-14/README.md`](../AuditPackage/pre-deploy-census-2026-05-14/README.md).

**Committee question to confirm**: do you accept the
peer-consensus-derived Tier 3 LTV as the gating mechanism, or
require a manual override floor / ceiling per asset?

---

## 3. Kill-switch readiness

> Who can flip `depthTieredLtvEnabled` off and within what time
> bound? `discountPathEnabled` independently? Pause?

**Pre-committed answer**:

| Kill switch | On-chain authority | Time bound | Notes |
| --- | --- | --- | --- |
| `setDepthTieredLtvEnabled(bool)` | TimelockController (post-handover) | 48h schedule + execute | Default `false` ⇒ today's HF≥1.5 still binding. Flipping ON keeps the old `maxLtvBps` ceiling AND the per-tier cap (init gate takes the `min`). |
| `setDiscountPathEnabled(bool)` | TimelockController (post-handover) | 48h schedule + execute | Independent of depth-tier. Default `false` ⇒ discount path closed entirely. **EC-002 verification**: when ON, the discount path enforces principal-first-then-collateral at three layers (see [Issue #11](https://github.com/vaipakam/vaipakam/issues/11) closing note + `OffchainDataFetchAudit-2026-05-15.md` Part 7). |
| `Pausable.pause()` | ADMIN_ROLE (governance Safe; no 48h delay) | Immediate | Emergency lever — halts all state-changing entry points. Repayments + claims may stay live per facet (see `Pausable` overrides). |
| `setSanctionsOracle` rotation | ADMIN_ROLE + 48h timelock | 48h | Chainalysis-style oracle address |
| `setInternalMatchEnabled(bool)` | TimelockController | 48h | Independent kill-switch for B.2 internal-match path |

Internal-match has its own kill-switch path documented at
[`GovernanceRunbook.md` §6.3](../ops/GovernanceRunbook.md).

**Committee question to confirm**: are the kill-switches granular
enough? Do you want any kill-switch fast-tracked below 48h delay
under specific conditions (e.g., a "pause but don't unpause" 0-delay
variant for emergency)?

---

## 4. Bot dependencies

> Is the keeper relay healthy + monitored? What's the SLA for a
> stuck relay?

**Pre-committed answer**: three Workers ([`apps/keeper`](../../apps/keeper),
[`apps/indexer`](../../apps/indexer), [`apps/agent`](../../apps/agent))
on Cloudflare per chain. Asymmetry protection in
`effectiveTier = min(getLiquidityTier(asset), keeperTier)` means a
stuck or compromised keeper relay can only **raise risk-aversion**
(force all assets to Tier 1 = 50% cap, the no-keeper baseline),
never lower it. **No fund-loss vector exists from a stuck or
compromised relay.**

**Pre-sign-off testnet observability gate**: before mainnet flip,
run the keeper relay + indexer + agent on Base Sepolia for at
least one full bake cycle. Capture:

- `KeeperTierSet(asset, oldTier, newTier)` events emitted ([F-3](https://github.com/vaipakam/vaipakam/issues/9) added `oldTier` so the audit trail is event-only, no storage replay).
- Liquidation triggers fired (atomic + discount + internal-match).
- Indexer event-coverage check green ([`apps/indexer/scripts/check-event-coverage.mjs`](../../apps/indexer/scripts/check-event-coverage.mjs)).
- Agent watch-feed-heartbeat / watch-health-factor / watch-l2-sequencer Tenderly alerts wired.

**Committee question to confirm**: is one bake cycle on Base
Sepolia sufficient, or do you want N parallel testnet rehearsals
across all 5 testnet chains?

---

## 5. Cross-chain

> DVN policy compliant per CLAUDE.md (3-required + 2-optional + 1-of-2
> threshold)? Future migration path?

**Pre-committed answer**:

- Current cross-chain layer: LayerZero V2 OFT for VPFI, reward mesh,
  Buy adapter. DVN policy enforced at deploy gate
  ([`LZConfig.t.sol`](../../contracts/test/LZConfig.t.sol)): 3 required
  (LayerZero Labs + Google Cloud + Polyhedra/Nethermind) + 2 optional
  (BWare + Stargate/Horizen), threshold 1-of-2.
- Rate-limits set on `VPFIBuyAdapter` via
  `setRateLimits(50_000e18, 500_000e18)` — defaults are
  `type(uint256).max` (off); admin must set the real values.
- April 2026 OFT exploit (Kelp / LayerZero) is the precedent: 1-required
  + 0-optional default would have been the attack vector — Vaipakam's
  policy rejects that shape at the deploy gate.

**Roadmap**: migration to Chainlink CCIP planned ([`@vaipakam-labs`
Issue #5](https://github.com/vaipakam/vaipakam/issues/5) — T-068).
Driven by cross-vendor diversification and CCIP's risk-management-
network approach. **Not gating for mainnet rollout** — current LZ
config is hardened. Migration becomes a separate audit cycle.

**Committee question to confirm**: do you accept the current LZ-V2
+ hardened-DVN posture, with a documented CCIP migration roadmap,
as sufficient for mainnet enablement?

---

## 6. Liquidation economics

> At the chosen per-tier discount (Tier 1: 7.7%, Tier 2: 6.0%,
> Tier 3: 5.0%), is the implied liquidator profit positive even at
> worst-case slippage? What if external liquidation fails outright?

**Pre-committed answer (user-authored)**:

- **Normal operation**: loans initiate at ≤ 3% slippage with
  ≤ 0.3% DEX fee. The init-gate stops borrowers at ~50-73% LTV
  per tier. Liquidation opens at the per-loan `liquidationLtvBpsAtInit`
  (default 80-90% per tier). With external liquidation opening
  at LTV ≥ `liquidationLtvBpsAtInit + 200bps` (= ~92% on Tier 1)
  and the per-tier discount priced in, the implied liquidator
  margin remains positive even at worst-case 6% slippage. The
  8% LTV buffer between init gate and external-liquidation
  trigger is the headroom that makes this work.
- **Black-swan / abnormal-market conditions**: slippage > 6% or
  DEX revert — liquidation skips to the **in-kind fallback**.
  Lender receives the collateral asset directly, not the lending
  asset. This is **disclosed and consent-gated in the frontend**:
  - [`apps/defi/src/i18n/locales/en.json`](../../apps/defi/src/i18n/locales/en.json#L543) line 543: "If liquidation of liquid collateral fails (like in Abnormal Market conditions, when slippage > 6%, thin liquidity, DEX revert, or any other runtime failure)"
  - Line 544: "Lender receives the collateral in-kind — NOT the lending asset."
  - Line 729: "You must agree to the abnormal-market liquidation fallback terms before creating an offer." (`fallbackConsentRequired` validation key, gates `createOffer` UI flow.)
- **Claim-time retry**: lender or their keeper bot supplies a ranked
  retry try-list (0x → 1inch → UniV3 → Balancer) at claim time via
  [`ClaimFacet.claimAsLenderWithRetry`](../../contracts/src/facets/ClaimFacet.sol#L162-L178).
  On any-success commits to principal-asset proceeds; on total
  failure, terminal Defaulted with in-kind collateral (premium split
  3% lender / 2% treasury per `apps/defi/src/i18n/locales/en.json`
  line 1518).

**Committee question to confirm**: do you accept the in-kind
fallback + claim-time retry as adequate user protection, given the
consent-gated disclosure on the offer-creation flow?

---

## 7. Sequencer / oracle outage

> What happens during a 1h sequencer outage on Base / Arb / OP?
> Quorum failure on Tellor + API3 + DIA?

**Pre-committed answer**:

- **Sequencer outage (L2 only)**: `OracleFacet._sequencerHealthy` reads
  the Chainlink sequencer-uptime feed; if down OR if back-up < 1h
  grace, every oracle-sensitive entry-point fails-closed with
  `SequencerUnhealthy`. New loans / HF-based liquidations / rate-
  dependent quotes block. Repayments + user-initiated exits stay
  live so users can never be trapped. Documented in
  [`apps/defi/src/i18n/locales/en.json`](../../apps/defi/src/i18n/locales/en.json#L1550) line 1550.
- **Primary oracle (Chainlink) outage**: hybrid staleness rule
  (2h volatile / 25h stable-with-peg-check) applied per
  `OracleFacet._validatePriceFeed`. Beyond staleness → `StalePriceData`
  revert (fail-closed).
- **Secondary oracle quorum (Tellor + API3 + DIA) failure**: Soft
  2-of-N rule — if every secondary returns `Unavailable`, primary
  is accepted as a graceful fallback (sparse-coverage tolerance).
  If any secondary actively `Disagrees` AND no secondary `Agrees`,
  the tx reverts `SecondaryQuorumFailed`. **Single-source poisoning
  requires compromising primary + every responsive secondary in
  one block** — see
  [`OffchainDataFetchAudit-2026-05-15.md`](OffchainDataFetchAudit-2026-05-15.md) Part 2.
- **Total failure (every layer down simultaneously)**: this is the
  black-swan envelope already covered in §6 — in-kind collateral
  fallback + claim-time retry + consent-gated disclosure.

**Committee question to confirm**: do you accept the layered-fail-
closed posture, or want any layer-specific addition (e.g., a
"manual pause on oracle disagreement" admin lever)?

---

## 8. Sign-off scope — protocol-wide

> Per-chain or all-chains? If per-chain, does each chain need a
> fresh review?

**Pre-committed answer**: **protocol-wide single sign-off** is the
right shape for this architecture because:

- Parameter derivation is chain-independent: `LibPeerLTV` peer-
  consensus, depth-tier classification, Soft 2-of-N quorum are
  all chain-agnostic primitives.
- Per-chain delta is enumerable CONFIGURATION (which oracles wire
  where, which DEX clones exist, which Aave/Compound markets list
  the asset), not different code paths.
- Deploy scope is **major mainnets only** — chains with battle-
  tested DEX + oracle infrastructure.

**One delta — per-chain configuration readback artifact**: before
flipping kill-switches on chain X, an operator runs the readback
procedure documented in
[`GovernanceRunbook.md` §6.1 "Readback verification"](../ops/GovernanceRunbook.md)
(oracle wiring + secondary-quorum addresses + depth-tier knobs +
paaAssets list + sequencer feed if L2). The artifact is archived
alongside this questionnaire. The committee signs off ONCE on the
policy + procedure; per-chain artifacts are checklist evidence,
not separate sign-off cycles.

**Committee question to confirm**: protocol-wide single sign-off
+ per-chain readback artifact archive — accept?

---

## 9. Sign-off form

To be filled in by each committee signer once §1-§8 are answered.

| Section | Signer's position |
| --- | --- |
| 1. Audit posture | ☐ Accept ☐ Defer (auditor incomplete) ☐ Reject |
| 2. Parameter sanity | ☐ Accept ☐ Accept-with-override-floor ☐ Reject |
| 3. Kill-switch readiness | ☐ Accept ☐ Accept-with-emergency-pause-fast-path ☐ Reject |
| 4. Bot dependencies | ☐ Accept-after-1-bake ☐ Require-N-testnet-bakes ☐ Reject |
| 5. Cross-chain | ☐ Accept LZ + CCIP roadmap ☐ Require-CCIP-before-mainnet ☐ Reject |
| 6. Liquidation economics | ☐ Accept in-kind fallback + claim retry ☐ Reject |
| 7. Sequencer / oracle outage | ☐ Accept layered fail-closed ☐ Require additional admin lever ☐ Reject |
| 8. Scope | ☐ Accept protocol-wide ☐ Require per-chain ☐ Reject |

**Overall decision**: ☐ APPROVE mainnet rollout ☐ APPROVE with conditions ☐ DEFER ☐ REJECT

**Conditions / notes** (if applicable):

```
(signer-specific text)
```

**Signed**: _______________________ **Date**: __________

---

## Cross-references

- [`docs/internal/PendingTasks-2026-05-14.md`](PendingTasks-2026-05-14.md) §A.5 — task source
- [`docs/internal/OffchainDataFetchAudit-2026-05-15.md`](OffchainDataFetchAudit-2026-05-15.md) — C.1 audit + F-1/F-2/F-3 findings
- [`docs/internal/ConfigKnobBoundsAudit-2026-05-14.md`](ConfigKnobBoundsAudit-2026-05-14.md) — C.2 governance-knob bounds
- [`docs/internal/WethChainSafetyAudit-2026-05-14.md`](WethChainSafetyAudit-2026-05-14.md) — B.1 per-chain WETH semantics
- [`docs/ops/GovernanceRunbook.md`](../ops/GovernanceRunbook.md) — post-sign-off ceremony
- [`docs/ops/FlashLoanLiquidatorRollout.md`](../ops/FlashLoanLiquidatorRollout.md) — discount-path per-chain enablement
- [`docs/ops/IncidentRunbook.md`](../ops/IncidentRunbook.md) — pause / unpause / rollback procedures
- [`@vaipakam-labs` Issue #11](https://github.com/vaipakam/vaipakam/issues/11) — EC-002 closure verification
