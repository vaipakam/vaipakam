# Internal-liquidation ledger — design proposal (pre-implementation)

**Status**: Design doc, alternatives stage. No code shipped.
**Item**: B.2 in
[`docs/internal/PendingTasks-2026-05-14.md`](../internal/PendingTasks-2026-05-14.md).
**Companion**: shares the per-tier liquidation-discount budget
modeled in
[`FlashLoanLiquidationPath.md`](FlashLoanLiquidationPath.md) §4.
This doc reuses that tier model and proposes a path that runs
**before** the external-aggregator path takes over.

**User clarifications absorbed**: bot's at-stake cost is gas-only
(no principal capital, no slippage, no flash-loan repayment) →
1% incentive is enough; the ledger-eviction-at-84% question is
resolved by recommending a view-only design over a stored
ledger (§4.4.1). Three bands ratified by user: ≥85% advertise,
≥90% internal-match window, ≥92% external fallback. 1%
matcher incentive split evenly across the two matched legs.

## 1. Goal

Today every liquidation routes through an external aggregator
(0x / 1inch / Uniswap V3 / Balancer V2 — see
[`LibSwap`](../../contracts/src/libraries/LibSwap.sol)) which
costs the borrower a per-tier discount (Tier-1: 7.7%,
Tier-2: 6.0%, Tier-3: 5.0%) plus aggregator fees + slippage.
This is the right path when nothing else is available, but at
scale a fraction of near-liquidation loans across the protocol
are **opposing-direction** pairs:

- Loan A: Lender lent USDC, Borrower posted WETH collateral. To
  close, sell WETH → USDC (external swap).
- Loan B: Lender lent WETH, Borrower posted USDC collateral. To
  close, sell USDC → WETH (external swap, opposite direction).

If both A and B are near-liquidation at the same time, a bot
can match them: A's WETH collateral pays off B's WETH debt;
B's USDC collateral pays off A's USDC debt. No external swap.
No aggregator fee. No slippage. Both parties save the
discount-burden; the bot earns a 1% incentive; the protocol
saves the swap-failure tail-risk.

The user-stated 3-band LTV model (read "5% buffer-from-
liquidation remaining" as the cue point — 86% with the
current 92% external-liquidation threshold, then 90% internal
window, then 92% external fallback):

| Band | LTV | Behaviour |
| --- | --- | --- |
| Healthy | LTV < 85% | Loan healthy. Not advertised. (If the loan ever entered the matchable band and dropped back here — see §11 — it's removed / filtered out next block.) |
| Match-advertise | 85% ≤ LTV < 90% | Loan exposed to bots so they can pre-pair candidates off-chain. No on-chain mutation. |
| Internal-match only | 90% ≤ LTV < 92% | `triggerInternalMatchLiquidation(loanIdA, loanIdB)` callable. External `triggerLiquidation` reverts in this band. **Internal matchers have a 2% priority window.** |
| External fallback | LTV ≥ 92% | External `triggerLiquidation` callable. Internal still allowed if a pair forms. |

Bot incentive: **1% of matched notional** sourced from the
discount-burden that each borrower would otherwise have paid
the external aggregator (§8). The bot's only at-stake cost is
the matching transaction's gas fee — no principal capital is
required, no slippage exposure, no flash-loan repayment risk.
A 1% incentive on opportunistic gas-only work is already
generous enough to attract third-party keeper participation.

## 2. Why this matters — vs the existing liquidation paths

| Path | Cost to borrowers | Slippage exposure | Aggregator risk |
| --- | --- | --- | --- |
| **External atomic swap** (current default) | Per-tier discount 5-7.7% | Yes, capped by [`liquiditySlippageBps`](../../contracts/src/facets/ConfigFacet.sol) | DEX router liveness + 4-DEX failover |
| **Flash-loan path** (per FlashLoanLiquidationPath.md) | Same per-tier discount; lower keeper-capital cost | Same | Same + Aave V3 / Balancer V2 flash-loan liveness |
| **Internal match** (this doc) | 1% to bot (much less than external 5-7.7% discount) | **Zero** — no swap | None — no aggregator involved |

The internal-match path strictly dominates when a pair exists.
It doesn't replace the external path; it shaves the top off the
external-path volume in scenarios where a counter-pair exists.

Realistic match-eligibility estimate: at moderate scale
(~10k active loans) and uniform direction distribution,
opposing-pair availability for near-liquidation loans is
expected to be 10-25% in band-2/3 windows. That's a meaningful
discount-saving on the matched fraction — and a real
incentive for community keeper bots to run our matcher.

## 3. Industry comparison

Most lending protocols don't do this:

- **Aave / Compound**: socialised bad debt + external liquidator
  bonus. No internal matching across pairs. The aggregator
  market is the matching engine.
- **MakerDAO**: collateral auctions (Dutch). No cross-vault
  matching either.
- **dYdX / GMX (perp DEXs)**: socialised liquidator pool, no
  per-pair matching.

What comes closest:

- **CoFiX (defunct AMM-less DEX)**: matched buyers and sellers
  via oracle-priced order books rather than pool swaps. The
  philosophical analogue: oracle prices the trade, not a pool.
- **Internal matching engines in OTC platforms (FalconX,
  Wintermute)**: route taker flow against opposing inventory
  before hitting external venues. Same principle, off-chain.

Our internal-match path is the on-chain version of the OTC
principle: the protocol's own borrower flow IS the counter-
inventory, oracle-priced, no aggregator fee. The novelty isn't
huge — it's an obvious optimisation no major lender ships
because their architecture (pool-based supply) doesn't expose
per-loan opposing-direction structure the way our per-loan
discrete model does.

## 4. Four matching-engine alternatives

### 4.1 Alternative A — Dutch-auction

Each match-advertised loan opens an on-chain Dutch auction;
matchers bid by submitting a `(matchPartnerId, discountBps)`
tuple. Lowest discount accepted as time progresses.

**Pros**: classic price-discovery; auditable.

**Cons**:
- Wrong shape. The match price IS the oracle price — both legs
  are valued by the existing oracle quorum
  ([`OracleFacet.getAssetPrice`](../../contracts/src/facets/OracleFacet.sol)).
  There's no price to discover.
- Adds ~10× storage cost per match-advertised loan vs simple
  flagging.
- Adds time-latency in a context where speed matters.

**Verdict**: rejected. Wrong tool.

### 4.2 Alternative B — Periodic batched clearing

Maintain a ledger of match-advertised loans. Every N blocks
(or every N seconds via keeper trigger), clear the ledger in
one batched transaction: solve the bipartite-matching problem
across all advertised loans, execute all matches atomically.

**Pros**: maximises matching efficiency (global optimum per
batch); compresses gas per match across many pairs.

**Cons**:
- Adds latency. Batch clearing can take 1-5 min per cycle. In
  the 90-92% band a loan can deteriorate to 92%+ before the
  batch fires.
- Single batch transaction == single MEV target. The block
  proposer can extract the value the matcher would have earned.
- Bipartite-matching on-chain is gas-heavy. With 100+
  candidates per batch this gets expensive fast.
- Cron-style clearing is operationally fragile (whose keeper
  runs the batch? what if it fails?).

**Verdict**: rejected. Optimisation gain doesn't justify
operational complexity for an opportunistic-path feature.

### 4.3 Alternative C — Simple priority queue (first-bot-to-match-wins)

No ledger. Any bot can call
`triggerInternalMatchLiquidation(loanIdA, loanIdB)` as long as
both loans pass their LTV gates and assets oppose. Speed-of-
discovery is the moat; first valid submission per pair wins.

**Pros**:
- Trivially simple. No clearing logic, no auction state.
- Aligned with how community keeper bots already operate (race
  to submit the profitable tx).
- Maximises real-time matching: a pair forms the instant both
  legs become eligible.
- No central coordinator: every bot picks its own scanning
  cadence + match policy.

**Cons**:
- Bots all race for the same pair → some gas wasted on reverts.
  (Mitigation: each match tx is small, ~150k gas, so wasted gas
  on revert is small.)
- MEV exposure: block proposers can sandwich profitable
  matches. (Mitigation: 1% incentive is bounded; not worth
  serious extraction effort.)
- No global optimality: bot picks a pair that's profitable for
  it, not necessarily the protocol-optimal pair. Acceptable —
  marginally suboptimal matches are still strictly better than
  external liquidation.

**Verdict**: **recommended.** Right shape for opportunistic
matching at this scale.

### 4.4 Alternative D — View-only (no on-chain ledger)

Skip the storage entirely. Expose a view function:

```solidity
function getMatchEligibleLoans(uint16 minLtvBps, uint16 maxLtvBps)
    external view returns (uint256[] memory loanIds);
```

Bots query this off-chain, pair candidates locally, submit
matches via `triggerInternalMatchLiquidation`. The "ledger" is
just a derived view over `s.loans` + `RiskFacet.calculateHealthFactor`.

**Pros**:
- Zero new storage. Zero state-write gas.
- Always-fresh: a loan that crosses 85% LTV is immediately
  visible in the next block, no separate `addToLedger` call
  needed.
- Aligns with how
  [`MetricsFacet.getActiveLoansPaginated`](../../contracts/src/facets/MetricsFacet.sol)
  already exposes loan state to bots.

**Cons**:
- O(N) view iteration. At 10k active loans, this is ~10k
  storage reads per call. Pagination required.
- A bot scanning every block pays the storage-read cost every
  block. Acceptable for a single well-funded keeper; awkward
  if 50 keepers all hammer the view.

**Verdict**: **recommended together with C.** This is the right
shape for v1. If view cost becomes a bottleneck (10k+ active
loans + many keepers), v2 adds an indexed set of match-eligible
loans maintained on every LTV transition (cheap incremental
maintenance). Premature now.

#### 4.4.1 Why this also solves the "soft-delete at 84% LTV" concern

The user-raised concern: "when the loan LTV becomes less than
84% then the ledger entry need to be removed (or else modify
with soft deletion with a flag…). What is the better approach?"

A view-only design dissolves the concern entirely:

- A loan that crosses 85% upward is automatically visible in the
  next block's view (current LTV ≥ 85% passes the filter).
- A loan that crosses 84% downward (LTV improved after a partial
  repay, more collateral posted, or oracle price moved) is
  automatically filtered out in the next block's view (current
  LTV < 85% fails the filter).
- There is **no ledger to soft-delete from** because there is
  **no ledger.** Membership is derived per-block from current
  state.
- The user's own follow-up reasoning supports this: "before
  liquidation anyway the LTV is checked again." The execution
  gate at `triggerInternalMatchLiquidation` re-validates LTV ≥
  90% on each loan at the moment of the match. A bot acting on
  a stale view that's a few blocks behind costs only the bot's
  gas (the tx reverts; no protocol state mutated).

So we get the soft-delete semantics for free, with no flag, no
storage write, no hysteresis-threshold debate (whether to remove
at 84% or 85% becomes moot — the view's filter threshold IS the
single tuning knob).

The only scenario where a stored ledger with explicit
84%-removal hysteresis would beat the view-based design:
**oscillation suppression** — a loan repeatedly crossing
85% in and out within a single block would cause bots to
repeatedly fetch and discard it. In practice oscillation across
blocks is rare (LTV changes monotonically except on borrow /
repay / oracle update), so this isn't a real-world problem.

## 5. Recommendation

**C + D combined**: simple priority queue executor + view-only
candidate exposure. No ledger storage in v1.

| Decision | v1 | v2 (if needed) |
| --- | --- | --- |
| Candidate discovery | View function `getMatchEligibleLoans(minBps, maxBps)` | Indexed `s.matchEligibleLoanIds` set maintained on LTV transitions |
| Match execution | `triggerInternalMatchLiquidation(loanIdA, loanIdB)` — first-bot-wins | Same |
| Matching algorithm | Bot-side (off-chain) bipartite-pair search | Same |
| Clearing cadence | Continuous, per-bot, no batching | Same |

This keeps v1 surface tiny (one view + one entry point) and
preserves the option to add storage indexing later without
breaking the executor's contract.

## 6. Storage + entry-point sketch (for the recommended path)

### 6.1 New constants in [`LibVaipakam.sol`](../../contracts/src/libraries/LibVaipakam.sol)

```solidity
uint16 internal constant MATCH_ADVERTISE_LTV_BPS = 8_500;     // 85%
uint16 internal constant MATCH_LIQUIDATE_LTV_BPS = 9_000;     // 90%
uint16 internal constant EXTERNAL_LIQUIDATE_LTV_BPS = 9_200;  // 92%
uint16 internal constant MATCH_INCENTIVE_BPS = 100;           // 1% of notional
```

These become governance-configurable via `ConfigFacet` setters
gated by `ADMIN_ROLE` and a master kill-switch flag (per §9).

### 6.2 New view in `MetricsFacet`

```solidity
function getMatchEligibleLoans(
    uint16 minLtvBps,
    uint16 maxLtvBps,
    uint256 startIdx,
    uint256 pageSize
) external view returns (uint256[] memory loanIds, uint256 nextIdx);
```

Iterates `s.activeLoanIdsList` from `startIdx`, returns up to
`pageSize` loanIds whose current `ltvBps` lies in
`[minLtvBps, maxLtvBps]`. Bot paginates.

### 6.3 New entry point in `RiskFacet`

```solidity
function triggerInternalMatchLiquidation(
    uint256 loanIdA,
    uint256 loanIdB
) external nonReentrant whenNotPaused;
```

Validation gates (all must hold):

1. Master kill-switch `s.internalMatchEnabled == true`.
2. Both `loanA` and `loanB` are `LoanStatus.Active`.
3. Asset opposition:
   `loanA.principalAsset == loanB.collateralAsset` **AND**
   `loanA.collateralAsset == loanB.principalAsset`.
4. Both LTVs in the matchable band:
   `loanA.ltv ≥ MATCH_LIQUIDATE_LTV_BPS`,
   `loanB.ltv ≥ MATCH_LIQUIDATE_LTV_BPS`.
   (Below 90% — match-advertise band only; revert.)
5. Sanctions: neither lender nor borrower of either loan is
   sanctioned (Tier-1 gate via `LibVaipakam._assertNotSanctioned`).
6. KYC: dormant on retail per CLAUDE.md.

Execution (atomic):

1. Compute matched notional: `min(loanA.principal, loanB.principal)`
   in each leg's denominator. Asymmetric — see §7.
2. Pull `matchedA` of `loanA.collateralAsset` from
   `loanA.borrower`'s escrow → transfer to `loanB.lender`.
3. Pull `matchedB` of `loanB.collateralAsset` from
   `loanB.borrower`'s escrow → transfer to `loanA.lender`.
4. Pay bot incentive (§8).
5. Mark both loans terminal: new `LoanStatus.InternalMatched`
   (or reuse `Liquidated` with a flag — design decision in §10).
6. Emit `InternalMatchExecuted(loanIdA, loanIdB, matcher,
   matchedANotional, matchedBNotional, incentivePaid)`.

If either escrow pull fails → revert entire tx. Standard
Diamond reentrancy guard.

### 6.4 External liquidation gate adjustment

`RiskFacet.triggerLiquidation` (the existing external path)
adds a band check:

```solidity
if (ltvBps >= MATCH_LIQUIDATE_LTV_BPS && ltvBps < EXTERNAL_LIQUIDATE_LTV_BPS) {
    revert InternalMatchOnlyBand(ltvBps);
}
```

This is the **2% priority window** for internal matching.
Above 92%, both paths reopen; the loan has deteriorated past
the priority window and external liquidation is appropriate.

## 7. Partial-match semantics

Common case: matched legs are asymmetric. Example:

- Loan A: principal 10,000 USDC, collateral 5 WETH.
- Loan B: principal 4 WETH, collateral 8,000 USDC.

A's WETH collateral (5) ≥ B's WETH debt (4). B's USDC
collateral (8,000) < A's USDC debt (10,000) — partial.

Two options:

### 7.1 Option α — match-the-min, residual stays open

Match `min(A.principal, B.collateral_USD_equiv)` on the USDC
leg and `min(A.collateral_WETH, B.principal)` on the WETH leg.
The smaller of these two ratios is the match fraction.

In the example:
- USDC leg: min(10000, 8000) = 8000 USDC moved (80% of A's
  debt cleared).
- WETH leg: min(5, 4) × 80% = 3.2 WETH moved (80% of B's
  debt cleared).
- Residuals: A has 2000 USDC debt + 1.8 WETH collateral
  remaining; B has 0.8 WETH debt + 1600 USDC collateral
  remaining.

Both loans **stay active** with reduced balances. Either gets
re-matched against a new partner in the next block or falls
through to external liquidation when LTV crosses 92% again.

**Pros**: simple; partial-match is just "move the smaller
side, reduce both legs."
**Cons**: introduces partial-state mutations on Active loans —
new code path to test (analogous to existing partial-repayment).

### 7.2 Option β — match-the-min, residual auto-swaps externally

Same min-match, but the residual on the larger leg is
immediately swapped via the existing external path in the
same tx. The matcher pays for the swap (using their incentive
budget) so they only commit to a full close.

**Pros**: both loans terminate cleanly. No partial-state code
path.
**Cons**: matcher's incentive math more complex. Effectively
forces bot to also be the external liquidator for the residual,
which can fail (swap revert) and roll back the whole match.

### 7.3 Recommendation

**α (partial, residual stays open).** Reuses the existing
partial-repayment infrastructure
([`RepayFacet`](../../contracts/src/facets/RepayFacet.sol))
plumbing pattern. Keeper bots already understand partial
states; this is symmetric. β couples internal matching to
external swap success, which defeats the "internal matching
has zero aggregator risk" property from §2.

## 8. Bot incentive design — 1% of matched notional

The 1% incentive needs a clear source-of-funds story.
Otherwise we're either silently dipping treasury or stealing
from one side.

Locked: **1% per leg** (per user-confirmed wording in plan-mode Q&A).
Range-bounded `[0, 300]` BPS, admin-tunable per §9.1.

For each matched leg:
- Borrower would have paid the per-tier liquidation discount
  (Tier-1: 7.7%, Tier-2: 6.0%, Tier-3: 5.0%) under external
  liquidation. They save the full discount minus 1% = at
  least 4.0% saved (Tier-3 at cap) or 6.7% saved (Tier-1 at
  default 1%). Borrowers net positive vs external at every
  legal incentive value.
- Protocol nets +0% (same value flow modeled differently).
- Bot earns 1% of leg-A's matched notional + 1% of leg-B's
  matched notional in their respective assets. On a 3-way chain
  match (per §7 option α-with-3-way), 1% × 3 legs.

Implementation: at execution time, before transferring the
matched collateral cross-vault, withhold 1% of each leg's
matched amount and route it to `msg.sender`. Withheld asset is
the asset the receiving lender was going to receive (no FX
conversion needed).

**Why 1% per leg (= 1% of single-side notional, sourced from
each borrower)**: the user-locked framing. Both legs contribute
the same rate, so neither borrower feels singled out; the bot's
income scales linearly with match size; and the per-leg unit
matches the asymmetric partial-match accounting from §7.

**Alternative considered**: 1% from treasury. Rejected — the
protocol shouldn't bankroll matcher infra; the saving belongs
to the borrowers who avoided external liquidation, and a slice
of that saving should pay the matcher who delivered it.

## 9. Master kill-switch + per-chain enablement + range-bounded admin tunables

Same shape as the depth-tiered LTV switch (per
[`MarketRateWidgetAndDepthTieredLTV.md`](MarketRateWidgetAndDepthTieredLTV.md)):

- `s.internalMatchEnabled` defaults to `false`.
- `ConfigFacet.setInternalMatchEnabled(bool)` under
  `ADMIN_ROLE`.
- View `getInternalMatchConfigBundle()` exposes
  `(enabled, advertiseLtv, matchLtv, externalLtv, incentivePerLegBps)`
  to the frontend for status surfacing.

### 9.1 Range-bounded admin/governance tunables

**Every numeric value mentioned in this doc — 1%, 90%, 92%, and
the 85% view-filter — is admin-configurable, range-bounded by a
compile-time `MIN_` / `MAX_` constant in
[`LibVaipakam.sol`](../../contracts/src/libraries/LibVaipakam.sol).**
Admin (and later governance) cannot punch through the bounds via
any setter; only a contract upgrade can move them.

| Knob | Default | Hard range (compile-time) | Why this range |
| --- | --- | --- | --- |
| `advertiseLtvBps` | 8_500 (85%) | `[MIN_MATCH_ADVERTISE_LTV_BPS = 5_000 (50%), liquidateLtvBps − 100]` | Min 50% so "approaching liquidation" stays meaningful; max forces a ≥ 1% gap below the internal-match floor (no zero-band collapse). |
| `liquidateLtvBps` | 9_000 (90%) | `[advertiseLtvBps + 100, externalLtvBps − 100]` | Monotonically above advertise; ≥ 1% below external (priority window can't collapse). |
| `externalLtvBps` | 9_200 (92%) | `[liquidateLtvBps + 100, MAX_EXTERNAL_LIQUIDATE_LTV_BPS = 9_900 (99%)]` | Above internal-match; capped at 99% so external still fires before LTV crosses 100% (bad-debt prevention). |
| `incentivePerLegBps` | 100 (1%) | `[MIN_MATCH_INCENTIVE_BPS_PER_LEG = 0, MAX_MATCH_INCENTIVE_BPS_PER_LEG = 300 (3%)]` | Floor 0 lets governance zero the incentive without disabling the path. Cap 3% per leg = 6% total on a 2-way match, still within the 5–7.7% external-discount budget — so even at the cap, borrowers always net out ahead of external liquidation. |

Setter (`ConfigFacet.setInternalMatchBands(uint16,uint16,uint16,uint16)`)
under `ADMIN_ROLE`, with three independent revert paths:

1. `BandOutOfRange(field, value, min, max)` — any of the 4 values outside its hard range.
2. `InvalidBandOrdering(advertise, liquidate, external)` — monotonic cross-tier check fails.
3. `IncentiveAboveCap(value, max)` — incentive above 300 BPS.

Test coverage parallels `ConfigKnobBoundsAudit-2026-05-14.md`'s
boundary-at-cap / boundary-just-over / huge-value pattern.

### 9.2 Per-chain enablement

Per-chain enablement happens by flipping
`setInternalMatchEnabled(true)` on the chains where bot infra is
ready and active-loan volume justifies it. Defaults `false`; sparse
chains where match-pair probability is too low can stay off.

### 9.3 What the 84% / 86% values from earlier discussion became

Earlier drafts referenced "≥86% enters ledger, <84% removed
(soft-delete)." The view-only design (§4.4.1) dissolves this:
membership is derived per-block from current LTV, so there is no
add/remove pair to tune. The single relevant threshold is the view
filter's `advertiseLtvBps`, defaulting to 85% and range-bounded
above. No hysteresis tuning knob exists in the v1 surface.

Per-chain enablement: enable on chains where bot infrastructure
is ready and active-loan volume justifies it. Disable on
sparse chains where match-pair probability is too low to
justify the priority-window cost.

## 10. Open items for user to decide before coding

1. **`InternalMatched` status vs reuse `Liquidated`?** Adding a
   new `LoanStatus` enum value affects analytics + UI everywhere
   loan status is rendered. Reuse `Liquidated` + boolean flag is
   smaller blast radius but loses the analytics-clarity. Lean
   toward separate status; cheap to add now, expensive to add
   later.
2. **Partial-match residual handling — α or β from §7?** Lean α.
3. **Bot incentive split 0.5%+0.5% or 1% from one side?** Lean
   symmetric 0.5+0.5.
4. **Should match-eligibility be advertised cross-chain?**
   Bot on chain A discovers a pair on chain B → requires LZ
   message + cross-chain settlement → way out of scope for v1.
   v1 = same-chain pairs only. v2 might revisit.
5. **Does this need its own audit pass?** New entry-point that
   atomically transfers two parties' collateral with sanctions +
   asset-opposition + LTV-band gates and bot incentive payout
   is non-trivial. Recommend yes — bundle with the next audit
   engagement (per item A.4) rather than scheduling separately.
6. **Bot-side pair-search algorithm spec?** The contracts don't
   constrain it; this doc doesn't specify it either. The keeper-
   bot repo (`vaipakam-keeper-bot/src/detectors/`) should get
   its own design doc once the contract surface is decided.
7. **Ledger soft-delete at LTV < 84% — keep on the table?**
   Resolved in §4.4.1: view-based design dissolves the concern.
   If user prefers an explicit on-chain ledger with hysteresis
   semantics, escalate to v1 (changes Alternative D to a
   storage-backed set with `addToLedger` / `removeFromLedger`
   maintained on every LTV-mutating call). Lean view-only.

## 11. Implementation plan (4 phases, in order)

| Phase | Scope | Tests |
| --- | --- | --- |
| 1 | Constants + storage flag + setters + view function | `InternalMatchConfig.t.sol` (bounds + monotonic) + `MetricsFacetMatchEligibleView.t.sol` |
| 2 | `triggerInternalMatchLiquidation` entry point + validation gates | `InternalMatchLiquidationGates.t.sol` (all revert paths) |
| 3 | Partial-match execution (Option α from §7) + bot incentive payout | `InternalMatchPartialFill.t.sol` + `InternalMatchIncentive.t.sol` |
| 4 | External-path band gate (90-92% priority window) | `InternalMatchPriorityWindow.t.sol` (assert external reverts in band-3) |

Frontend / keeper-bot work happens in parallel after Phase 2
lands (so the bot can start exercising the entry point on
testnet).

## 12. Audit-package additions

When B.2 reaches audit (per item 5 in §10):

- This design doc (`InternalLiquidationLedger.md`).
- The 4 new test files in
  [`contracts/test/`](../../contracts/test/).
- The new `LoanStatus.InternalMatched` analytics surface (if
  decision 1 lands as "new status").
- A worked numerical example with asymmetric partial match
  + bot incentive payout (added inline as a test comment).
- Updated `ConfigKnobBoundsAudit-*.md` row for the new
  `setInternalMatchBands` setter (4 BPS args, monotonic
  cross-tier).

## 13. Out of scope

- Cross-chain match aggregation (decision 4).
- Auction-style price discovery (Alternative A).
- Periodic batched clearing (Alternative B).
- v2 indexed storage for match-eligible set (deferred until
  view-iteration becomes a bottleneck).
- Borrower-side matching against same-direction loans (this
  is structurally a refinance, already covered by
  [`RefinanceFacet`](../../contracts/src/facets/RefinanceFacet.sol)
  in scope of [`RangeOffersDesign.md`](RangeOffersDesign.md)).
