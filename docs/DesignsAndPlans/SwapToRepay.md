# Swap-to-Repay (T-090)

> Status: **implemented — v1 shipped under T-090**
> Owners: contracts (new facet), libraries (knob), frontend (later card)
> Related: T-086 prepay-listing (NFT-side marketplace path), Phase 7a
> 4-DEX swap failover, T-051 direct-custody pattern.

## 1. Problem

Today every Vaipakam repay path requires the borrower to hand over the
**principal asset** in full ([`RepayFacet.repayLoan`](../../contracts/src/facets/RepayFacet.sol#L250))
or in pieces if the offer was created with `allowsPartialRepay = true`
([`RepayFacet.repayPartial`](../../contracts/src/facets/RepayFacet.sol#L607)).
If the borrower's vault holds a different ERC20 (e.g. USDC vault, ETH
loan), the only way to repay is:

1. Withdraw collateral to wallet.
2. Externally swap on a DEX.
3. Re-deposit the principal asset.
4. Call `repayLoan` / `repayPartial`.

That's four transactions for a flow that should be one — and it leaks
gas, slippage, and custody steps. The collateral assets sits in the
borrower's own vault; we already have a proven 4-DEX swap failover
primitive ([`LibSwap.swapWithFailover`](../../contracts/src/libraries/LibSwap.sol#L139),
Phase 7a); the missing piece is a diamond-side entry point that fuses
"swap collateral → principal" with "apply proceeds to the loan's
settlement waterfall".

This document specifies that entry point as a new facet
`SwapToRepayFacet`.

## 2. Scope (v1)

**In scope:**

- ERC20 collateral → ERC20 principal swap-to-repay against an active
  ERC20 loan.
- Full swap-to-repay (closes loan, respects `useFullTermInterest`).
- Partial swap-to-repay (reduces principal), gated on the offer's
  pre-existing `allowsPartialRepay` opt-in.

**Out of scope (v1):**

- **NFT collateral**: no swap path at repay time exists today. T-086's
  prepay-listing surface ([`NFTPrepayListingFacet`](../../contracts/src/facets/NFTPrepayListingFacet.sol))
  is the existing marketplace path but is gated to the pre-grace
  window. Extending it to repay time is a meaningful scope expansion;
  tracked as a follow-up card.
- **NFT-rental loans**: rentals settle from a borrower-funded prepay
  vault (`loan.prepayAsset`), not from collateral. There's no
  swap-to-repay primitive that fits the rental shape.
- **Multi-route split swaps**: `LibSwap.swapWithSplit` exists for the
  higher-LTV liquidator and could be wired in later. v1 uses
  `swapWithFailover` only — borrower-initiated trades are smaller
  than liquidator trades, so single-route execution is the right
  default.
- **FallbackPending cure**: `repayLoan` accepts a `FallbackPending`
  status to cure a failed liquidation
  ([`RepayFacet.sol:256`](../../contracts/src/facets/RepayFacet.sol#L256));
  swap-to-repay only accepts `Active` in v1 to keep the slippage /
  settlement surface narrow.

## 3. Existing surfaces being reused

| Surface | File | Role in T-090 |
|---|---|---|
| `LibSwap.swapWithFailover(loanId, inputToken, outputToken, inputAmount, minOutputAmount, recipient, adapterCalls)` | [`libraries/LibSwap.sol:139`](../../contracts/src/libraries/LibSwap.sol#L139) | The keeper-ranked 4-DEX try-list primitive. Reused verbatim. |
| `LibFallback.expectedSwapOutput(diamond, collateralAsset, principalAsset, collateralAmount)` | [`libraries/LibFallback.sol:23`](../../contracts/src/libraries/LibFallback.sol#L23) | Oracle-derived expected proceeds for the slippage floor. |
| `LibEntitlement.settlementInterest(loan, nowTime)` | [`libraries/LibEntitlement.sol:57`](../../contracts/src/libraries/LibEntitlement.sol#L57) | Full-term-or-pro-rata interest, respects `loan.useFullTermInterest`. |
| `LibEntitlement.accruedInterestToTime(loan, nowTime)` | [`libraries/LibEntitlement.sol:45`](../../contracts/src/libraries/LibEntitlement.sol#L45) | Pro-rata interest for the partial path. |
| `LibEntitlement.splitTreasury(amount)` | [`libraries/LibEntitlement.sol:75`](../../contracts/src/libraries/LibEntitlement.sol#L75) | 99% lender / 1% treasury split (admin-configurable). |
| `LibSettlement.computeRepayment(loan, lateFee, nowTime)` | [`libraries/LibSettlement.sol:47`](../../contracts/src/libraries/LibSettlement.sol#L47) | The immutable settlement plan for full close-out. |
| `LibVaipakam.calculateLateFee(loanId, endTime)` | [`libraries/LibVaipakam.sol`](../../contracts/src/libraries/LibVaipakam.sol) | Late-fee math reused. |
| `Loan.allowsPartialRepay` (storage) | [`libraries/LibVaipakam.sol:1390`](../../contracts/src/libraries/LibVaipakam.sol#L1390) | Snapshotted from `Offer.allowsPartialRepay` at init. Single consent surface — reuse, don't add a new flag. |
| `VaultFactoryFacet.vaultWithdrawERC20` | [`facets/VaultFactoryFacet.sol`](../../contracts/src/facets/VaultFactoryFacet.sol) | Pull collateral from borrower vault to diamond pre-swap. |
| `VaultFactoryFacet.vaultDepositERC20From` | [`facets/VaultFactoryFacet.sol`](../../contracts/src/facets/VaultFactoryFacet.sol) | Push proceeds from diamond into the lender vault post-swap (T-037 single-transfer pattern). |
| `cfgMaxLiquidationSlippageBps()` admin getter | [`libraries/LibVaipakam.sol:3453`](../../contracts/src/libraries/LibVaipakam.sol#L3453) | Pattern we mirror for the new `cfgMaxSwapToRepaySlippageBps` knob (see §5). |
| `RiskFacet.triggerLiquidation` (HF-liquidation withdraw → swap → settle pattern) | [`facets/RiskFacet.sol:560`](../../contracts/src/facets/RiskFacet.sol#L560) | The execution template T-090 mirrors. |

## 4. Entry-point shape

New facet **`SwapToRepayFacet`** exposing two external functions —
`swapToRepayFull` and `swapToRepayPartial`. We keep them separate
rather than a single multi-mode function because:

- The full path closes the loan (writes `lenderClaims` + `borrowerClaims`,
  emits `LoanRepaid`) and respects `useFullTermInterest`.
- The partial path reduces principal and resets `loan.startTime`
  (matches `repayPartial`'s pro-rata accrual reset
  [`RepayFacet.sol:663`](../../contracts/src/facets/RepayFacet.sol#L663)).
- One function with a `bool isPartial` flag conflates two distinct
  state transitions and bloats the function body.

Two functions, two clear state transitions.

```solidity
/// @notice Swap the borrower's collateral asset for the loan's
///         principal asset and close the loan in one transaction.
///         Respects `loan.useFullTermInterest`.
/// @dev    Only `Active` loans (not `FallbackPending`). ERC20-on-ERC20
///         loans only. Slippage capped at `cfgMaxSwapToRepaySlippageBps`
///         (default 300 bps = 3%).
/// @param loanId           The loan to settle.
/// @param adapterCalls     Keeper-ranked 4-DEX try-list (`LibSwap.AdapterCall[]`).
/// @param maxCollateralIn  Upper bound on collateral the caller permits
///                          the diamond to withdraw from their vault.
///                          The actual withdraw amount is derived from
///                          the required principal proceeds (debt + slippage
///                          buffer); a too-tight bound reverts before
///                          any state moves.
function swapToRepayFull(
    uint256 loanId,
    LibSwap.AdapterCall[] calldata adapterCalls,
    uint256 maxCollateralIn
) external nonReentrant whenNotPaused;

/// @notice Swap a portion of the borrower's collateral asset for the
///         loan's principal asset and apply the proceeds to a partial
///         principal reduction. Resets the accrual clock per the
///         existing `repayPartial` semantics.
/// @dev    Gated on `loan.allowsPartialRepay` (snapshotted from
///         `Offer.allowsPartialRepay` at init). Reverts if the offer
///         did not pre-consent to partial repays. Post-swap HF check
///         per `repayPartial`.
/// @param loanId               The loan to partially repay.
/// @param collateralSwapAmount The collateral input the caller permits
///                              the diamond to swap.
/// @param adapterCalls         Keeper-ranked try-list.
function swapToRepayPartial(
    uint256 loanId,
    uint256 collateralSwapAmount,
    LibSwap.AdapterCall[] calldata adapterCalls
) external nonReentrant whenNotPaused;
```

### Caller-authority

Both functions require `LibAuth.requireBorrower(loan)` — only the
borrower (current owner of the borrower-side position NFT) may initiate
a swap-to-repay. **No third-party "repay on behalf of"** for the
swap path: the borrower's collateral is at risk during the swap (the
diamond pulls it from the borrower's vault), so consent must be the
borrower's own.

This is a deliberate divergence from `repayLoan` (which allows
third-party repay-on-behalf-of for ERC20 loans
[`RepayFacet.sol:240-247`](../../contracts/src/facets/RepayFacet.sol#L240-L247)).
A third party could already use `repayLoan` to repay on the borrower's
behalf using their own principal asset; what they can't do is borrow
the borrower's collateral and execute a swap on their behalf.

## 5. New config knob

**`cfgMaxSwapToRepaySlippageBps()`** — admin-configurable, default
**300 bps (3%)**. Sibling to `cfgMaxLiquidationSlippageBps()` (default
600 bps / 6%).

Rationale for the tighter cap: HF-liquidation is permissionless and
adversarial — the wider 6% allows the liquidator to execute even when
the chain is congested or pool depth is thin. Swap-to-repay is
borrower-initiated, non-adversarial, and the borrower picks the
moment — a tighter 3% cap is appropriate and lets the borrower
abort if the chain has gapped against them.

The borrower can always wait for a better price; the liquidator's
swap is on a clock.

Storage layout: append-only new field on `LibVaipakam.Storage` (or in
the `ProtocolConfig` substruct, matching the existing config knob
pattern — confirm at implementation time).

## 6. Execution flow — `swapToRepayFull`

```
1.  Load loan; assert status == Active; assert ERC20 / ERC20 shape
    (loan.assetType == ERC20, collateralLiquidity == Liquid).
2.  LibAuth.requireBorrower(loan).
3.  Block lender-side self-repay (same guard as RepayFacet:273-278).
4.  Compute graceEnd; assert block.timestamp <= graceEnd
    (RepaymentPastGracePeriod).
5.  Compute the settlement plan via LibSettlement.computeRepayment(
        loan,
        LibVaipakam.calculateLateFee(loanId, endTime),
        block.timestamp
    ).
    plan.lenderDue is principal + lenderShare; plan.treasuryShare is
    the 1% cut on (interest + lateFee).
6.  Compute the required principalAsset output:
        requiredPrincipal = plan.lenderDue + plan.treasuryShare
7.  Compute the expected swap output via LibFallback.expectedSwapOutput
    using the borrower's specified `maxCollateralIn`. From that
    derive the slippage-adjusted minOutput:
        minPrincipalOut = expectedProceeds *
            (BASIS_POINTS - cfgMaxSwapToRepaySlippageBps()) /
            BASIS_POINTS
        if (minPrincipalOut < requiredPrincipal)
            revert SwapBoundsInsufficient();
8.  Withdraw maxCollateralIn from borrower vault to diamond (T-051
    pattern).
9.  LibSwap.swapWithFailover(loanId, collateralAsset, principalAsset,
        maxCollateralIn, requiredPrincipal, address(this), adapterCalls).
    Note: minOutput passed to LibSwap = requiredPrincipal exactly,
    NOT minPrincipalOut. This is the harder bound: the swap MUST
    produce enough to close the loan or it reverts the whole call
    (no soft-fallback — borrower can retry with better routing).
10. On swap success: diamond now holds at least requiredPrincipal of
    principalAsset.
11. Settle the waterfall using the plan:
    a. Treasury share: transfer plan.treasuryShare from diamond
       directly to treasury; record via LibFacet.recordTreasuryAccrual.
    b. Lender share: deposit plan.lenderDue into lender's vault via
       VaultFactoryFacet.vaultDepositERC20From (T-037 single-transfer
       pattern — payer = address(this), user = loan.lender).
12. Write claim slots:
    a. s.lenderClaims[loanId] = ClaimInfo(asset=principalAsset,
       amount=plan.lenderDue, ...) — same shape as repayLoan:355.
    b. s.borrowerClaims[loanId] = ClaimInfo(asset=collateralAsset,
       amount=ANY_LEFTOVER_COLLATERAL, ...) — if the swap consumed
       less than maxCollateralIn, the remainder is claimable.
13. ANY LEFTOVER PRINCIPAL above requiredPrincipal: the diamond now
    holds (swapOutput - requiredPrincipal) extra principalAsset.
    Two policy options (see §9 — picking option A for v1):
    Option A: Deposit the surplus to the borrower's vault — they get
              the upside of a tight quote.
    Option B: Treat as protocol surplus → treasury.
14. Mark loan Repaid; emit LoanSettlementBreakdown + LoanRepaid +
    SwapToRepayExecuted (new event).
15. Close phase-2 reward accrual: LibInteractionRewards.closeLoan(
        loanId, borrowerClean=true, lenderForfeit=false
    ).
```

## 7. Execution flow — `swapToRepayPartial`

```
1.  Load loan; assert status == Active; assert ERC20 / ERC20 shape.
2.  LibAuth.requireBorrower(loan).
3.  Assert loan.allowsPartialRepay (else PartialRepayNotAllowed).
4.  Assert collateralSwapAmount > 0.
5.  Compute graceEnd; assert block.timestamp <= graceEnd.
6.  Compute expected proceeds + slippage-adjusted minPrincipalOut as
    in step 7 of swapToRepayFull. minPrincipalOut here is the swap's
    minimum guarantee, not a "must cover loan" hard bound.
7.  Withdraw collateralSwapAmount from borrower vault to diamond.
8.  LibSwap.swapWithFailover(loanId, collateralAsset, principalAsset,
        collateralSwapAmount, minPrincipalOut, address(this),
        adapterCalls).
9.  On swap success: diamond holds principalProceeds.
10. Compute accrued interest:
        accrued = LibEntitlement.accruedInterestToTime(
            loan, block.timestamp
        );
        (treasuryShare, lenderShare) = LibEntitlement.splitTreasury(
            accrued
        );
11. Bound the partial-principal reduction:
        partialPrincipal = principalProceeds - lenderShare - treasuryShare;
        if (partialPrincipal == 0) revert InsufficientProceeds();
        if (partialPrincipal > loan.principal)
            partialPrincipal = loan.principal; // cap at remaining
    Also enforce the existing minPartial floor:
        minPartial = loan.principal * s.assetRiskParams[principalAsset]
            .minPartialBps / BASIS_POINTS;
        if (partialPrincipal < minPartial)
            revert InsufficientPartialAmount();
12. Settle waterfall:
    a. lenderShare + partialPrincipal → loan.lender (vaultDepositERC20From
       OR direct transfer — match the existing repayPartial pattern at
       RepayFacet.sol:647).
    b. treasuryShare → treasury.
13. Update loan state:
        loan.principal -= partialPrincipal;
        loan.startTime = uint64(block.timestamp);   // reset clock
14. Post-repay HF check (per repayPartial:771-783): for liquid-on-liquid
    loans, recompute HF and assert HF >= MIN_HEALTH_FACTOR.
15. T-034 §4.5 periodic-interest accumulator bookkeeping (mirror
    RepayFacet.sol:679-706 — the partial swap-to-repay should advance
    the periodic-interest checkpoint identically).
16. Emit PartialRepaid + SwapToRepayPartialExecuted.
```

## 8. Storage changes

**No new state on `Loan` or `Offer`.** The design reuses
`Loan.allowsPartialRepay` as the consent flag — no new flag, no
storage layout migration.

**One new field on `ProtocolConfig`**: `swapToRepaySlippageBps`
(append-only — last field of `ProtocolConfig` substruct). Defaults
to 300 (3%) via `cfgMaxSwapToRepaySlippageBps()` returning the
stored value or 300 if unset (matching the
`cfgMaxLiquidationSlippageBps` zero-fallback pattern).

Pause-gating: `whenNotPaused` modifier on both entry points
(`Pausable` from OZ — same as `RepayFacet`).

## 9. Surplus principal policy — v1 = return to borrower vault

When a swap delivers more principal than the loan requires (tight
quote, favourable price move between quote and submission), the
diamond holds surplus principalAsset that must be assigned.

**v1 picks Option A**: surplus → borrower vault (via
`vaultDepositERC20From`). Justification:
- Borrower took the slippage risk; the borrower should get the
  slippage upside symmetrically.
- Matches the HF-liquidation pattern at
  [`RiskFacet.sol`](../../contracts/src/facets/RiskFacet.sol) where
  any surplus after the lender / treasury / incentive cuts goes to
  the borrower's vault.
- Discourages keepers from over-quoting to skim the spread.

**Option B (treasury surplus) is intentionally rejected for v1**: it
would create a perverse keeper-side incentive (over-quote, skim) and
double-tax the borrower (already paying treasury cut on the loan's
interest).

## 10. Events

```solidity
/// @notice Emitted when a borrower swap-to-repays a full loan close-out.
/// @custom:event-category state-change/loan-mutation
event SwapToRepayExecuted(
    uint256 indexed loanId,
    address indexed borrower,
    uint256 collateralIn,
    uint256 principalOut,
    uint256 surplusPrincipal,
    uint256 surplusCollateral,
    uint256 adapterUsed
);

/// @notice Emitted when a borrower swap-to-repays a partial principal
///         reduction.
/// @custom:event-category state-change/loan-mutation
event SwapToRepayPartialExecuted(
    uint256 indexed loanId,
    address indexed borrower,
    uint256 collateralIn,
    uint256 principalOut,
    uint256 partialPrincipal,
    uint256 adapterUsed
);
```

The indexer must handle both events (per the indexer event-coverage
guardrail in `CLAUDE.md`).

## 11. Errors

```solidity
error PartialRepayNotAllowed();
error InsufficientPartialAmount();
error RepaymentPastGracePeriod();
error InvalidLoanStatus();
error LenderCannotRepayOwnLoan();
error SwapBoundsInsufficient();      // expected proceeds < required
error InsufficientProceeds();        // partial: proceeds < interest + minPartial
error UnsupportedLoanShape();        // non-ERC20/ERC20 loan
```

The first five are intentional re-uses from `RepayFacet`. The last
three are new.

## 12. Test plan

Test file: `contracts/test/SwapToRepayFacetTest.t.sol`.

### Unit (in-process)

1. **Full happy path** — ERC20-on-ERC20 loan, borrower swaps full
   collateral, loan closes, lender / treasury / borrower vault balances
   move correctly.
2. **Full with `useFullTermInterest = true`** — early swap-to-repay
   charges the full coupon; lender is made whole on duration.
3. **Full with `useFullTermInterest = false`** — same path uses
   pro-rata accrual via `LibEntitlement.settlementInterest`.
4. **Partial happy path** — gated on `loan.allowsPartialRepay`,
   reduces principal, resets `startTime`, post-HF passes.
5. **Partial blocked when `allowsPartialRepay = false`** — reverts
   `PartialRepayNotAllowed`.
6. **Partial below `minPartialBps` floor** — reverts
   `InsufficientPartialAmount`.
7. **Slippage cap rejection** — keeper try-list quotes too tight
   relative to oracle, `requiredPrincipal > slippageFloor`, reverts
   `SwapBoundsInsufficient` before any state moves.
8. **Adapter failover** — first adapter reverts, second adapter
   succeeds. Loan settles. `SwapAdapterAttempted` events confirm
   the failover order.
9. **Total swap failure** — every adapter reverts. Transaction
   reverts (NO soft fallback in v1 — borrower can retry with
   better routing).
10. **Past-grace block** — `block.timestamp > graceEnd`, reverts.
11. **Lender self-repay block** — borrower transferred their own
    lender-side position NFT to themselves (degenerate case); reverts
    `LenderCannotRepayOwnLoan`.
12. **NFT-rental rejection** — `loan.assetType == NFT`, reverts
    `UnsupportedLoanShape`.
13. **Non-borrower caller rejection** — third party calls
    `swapToRepayFull`, reverts via `LibAuth.requireBorrower`.
14. **Post-HF check on partial** — partial swap-to-repay that
    leaves loan in HF < 1.5, reverts `HealthFactorTooLow`.
15. **Surplus principal routing** — tight quote delivers extra
    principal; surplus deposited to borrower vault. Borrower vault
    balance changes verified.
16. **Surplus collateral routing** — swap consumed less than
    `maxCollateralIn`; remaining collateral claimable via the
    `borrowerClaims` slot (same shape as `repayLoan`).
17. **Periodic-interest checkpoint advance on partial** — T-034
    cadence-aware loan partial-repays, checkpoint advances, both
    `RepayPartialPeriodAdvanced` and `PeriodicInterestSettled` fire.

### Fork (gated by FORK_URL_BASE_SEPOLIA)

18. **Real Uniswap V3 swap on Base-Sepolia fork** — borrower swap-to-
    repays an active USDC-collateral / DAI-loan against a real pool.
    All settlement assertions verified.

### Producer-side artifact tests

19. **Facet selector coverage** (`SelectorCoverageTest`) —
    `SwapToRepayFacet` added to `DiamondFacetNames.cutFacetNames()`
    + `_getSwapToRepayFacetSelectors()` populated and called from
    `_populateRoutedSet()`. Same for `DeployDiamond.s.sol` +
    `HelperTest.sol`.
20. **Facet size limit** (`FacetSizeLimitTest`) — EIP-170 bytecode
    bound enforced.

## 13. Producer-side artifact updates

Per the facet-addition 7-site checklist in memory:

- `contracts/script/DeployDiamond.s.sol` — add
  `_getSwapToRepayFacetSelectors()` returning the two external
  selectors; wire into the cut list.
- `contracts/script/lib/DiamondFacetNames.sol` — append
  `"SwapToRepayFacet"` to `cutFacetNames()`.
- `contracts/test/HelperTest.sol` — mirror selectors helper.
- `contracts/test/deploy/SelectorCoverageTest.t.sol` — wire
  `_getSwapToRepayFacetSelectors()` into `_populateRoutedSet()`.
- `contracts/test/deploy/FacetSizeLimitTest.t.sol` — picked up
  automatically via `DiamondFacetNames`.
- `contracts/script/exportFrontendAbis.sh` — add `SwapToRepayFacet`
  to the `FACETS=(...)` array.
- `packages/contracts/src/abis/index.ts` — re-export the new
  facet's ABI.
- `apps/indexer/scripts/check-event-coverage.mjs` — `SwapToRepayExecuted`
  and `SwapToRepayPartialExecuted` are `state-change/loan-mutation`
  events; either handle them in `chainIndexer.ts` or add to the
  `DELIBERATELY_NOT_HANDLED` allowlist with a one-line reason.

## 14. Frontend (separate card)

Out of scope for the contracts PR. Sketch:

- `apps/defi/src/components/loan/LoanDetailsActions/RepayPanel.tsx` —
  add a "Swap collateral to repay" tab alongside the existing
  "Repay" tab.
- New hook `useSwapToRepayQuote(loanId)` — fetches a ranked
  `AdapterCall[]` try-list from the existing quote-proxy Worker
  (re-using the 4-DEX failover quote infrastructure from Phase 7a).
- Surplus-principal estimate shown in the modal so the borrower
  knows the upside isn't lost.
- Slippage tolerance display (3% protocol cap), with a per-call
  override slider bounded by the cap.

Filed as a sibling card (see §16).

## 15. Documentation

After contracts merge:

- **Functional spec**: new section in
  `docs/FunctionalSpecs/RepayBehaviour.md` (or
  `docs/FunctionalSpecs/SwapToRepay.md` if a new domain doc fits
  better — check `docs/FunctionalSpecs/README.md` precedence rules).
- **Advanced User Guide**: new section under Loan Details actions
  (`loan-details.actions:borrower`) describing the swap-to-repay
  surface.
- **Release notes fragment** under `docs/ReleaseNotes/unreleased/`
  per the per-PR fragment convention.
- **Runbook note** in `DeploymentRunbook.md` if the new config knob
  has a non-default desired-on-deploy value.

## 16. Implementation cards

Parent feature card + four implementation sub-cards, retained here as
the implementation audit trail:

- **Parent**: `T-090 — Swap collateral asset to prepay (umbrella)` —
  links to this design doc + tracks all sub-cards.
- **Sub 1 (contracts)**: Implement `SwapToRepayFacet` + new
  `cfgMaxSwapToRepaySlippageBps` knob + unit + fork tests + producer
  artifacts. Single PR.
- **Sub 2 (indexer)**: Handle `SwapToRepayExecuted` and
  `SwapToRepayPartialExecuted` in `chainIndexer.ts`; D1 schema
  additions if any.
- **Sub 3 (frontend)**: Wire the swap-to-repay tab on
  `RepayPanel.tsx`, quote hook, surplus + slippage UX.
- **Sub 4 (docs)**: Functional spec + Advanced User Guide section +
  release notes fragment.

## 17. Rollout

- Pre-live protocol — no atomic-rollout concerns. Contracts ship with
  consumers (indexer + frontend) co-updated for code consistency, not
  deploy-race protection.
- Default slippage knob (`cfgMaxSwapToRepaySlippageBps = 300`) is a
  conservative cap. Operator can tune via the standard `ConfigFacet`
  setter after observing real swap volumes.

## 18. Open questions

None blocking — the user has locked the five high-level tradeoffs:

1. New facet (not extend `RepayFacet`).
2. Reuse `Loan.allowsPartialRepay` for partial gating.
3. 3% slippage cap (new `cfgMaxSwapToRepaySlippageBps` knob).
4. NFT collateral out of scope for v1.
5. Respect `useFullTermInterest` flag on full path.

The implementation-level questions (surplus policy, soft-fallback
on total swap failure, partial-vs-full function split) are decided
above with reasoning.
