// src/facets/SwapToRepayFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibRefinanceRequest} from "../libraries/LibRefinanceRequest.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LibSwapToRepaySizing} from "../libraries/LibSwapToRepaySizing.sol";

/**
 * @title SwapToRepayPartialFacet
 * @author Vaipakam Developer Team
 * @notice T-090 — the PARTIAL swap-to-repay route: swap a portion of the
 *         borrower's collateral into the loan's principal asset and apply the
 *         proceeds to a partial principal reduction, in one transaction.
 * @dev    Split out of {SwapToRepayFacet} in #2416, which had reached 73 bytes
 *         under EIP-170 — less than any guard costs, so every queued change to
 *         either swap-to-repay route was undeployable (the #1780 / #1835
 *         condition). A pure move: same storage, same Diamond, same selector
 *         and call surface; only the runtime bytecode is separate. The full
 *         route and its preview stay in {SwapToRepayFacet}. **The two must be
 *         refreshed together** — one surface across two facets, so refreshing
 *         either alone runs the routes on mismatched code.
 *
 *         The route's rules are unchanged and documented on
 *         {swapToRepayPartial}; the shared ones (slippage cap, borrower-only
 *         authority, yield-fee discount keyed on the current lender-NFT
 *         holder, total-swap-failure reverts) are those {SwapToRepayFacet}'s
 *         header states. `_callEncumb2` and `_resolveLenderYieldFee` are
 *         private helpers both facets carry, verbatim.
 */
contract SwapToRepayPartialFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted on a successful partial swap-to-repay (principal
    ///         reduced; loan continues in Active).
    /// @param loanId The loan being partially repaid.
    /// @param borrower The borrower (== msg.sender).
    /// @param collateralIn The collateral consumed by the swap.
    /// @param principalOut The principal asset received from the swap.
    /// @param partialPrincipal The principal amount retired.
    /// @param adapterUsed The `LibSwap` adapter index that succeeded.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayPartialExecuted(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 collateralIn,
        uint256 principalOut,
        uint256 partialPrincipal,
        uint256 adapterUsed
    );

    /// @notice Mirror of `RepayFacet.RepayPartialPeriodAdvanced` so the
    ///         T-034 periodic-interest checkpoint-advance signal is
    ///         observable on the swap-to-repay path too. Identical
    ///         topic hash — indexers subscribing by topic catch both.
    ///         (Codex round-1 PR #390 P2 #2.)
    /// @custom:event-category state-change/loan-mutation
    event RepayPartialPeriodAdvanced(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        address indexed advancedBy
    );

    /// @notice Mirror of `RepayFacet.PeriodicInterestSettled`. Topic
    ///         match — see {RepayPartialPeriodAdvanced}.
    ///         (Codex round-1 PR #390 P2 #2.)
    /// @custom:event-category state-change/loan-mutation
    event PeriodicInterestSettled(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        uint256 paidByBorrower,
        address indexed settler
    );

    /// @notice #1383 — the lender yield-fee resolve host cross-facet call
    ///         reverted (should be unreachable; the host is a diamond-internal
    ///         resolve + optional VPFI vault debit).
    error LenderYieldFeeResolveFailed();

    /// @notice `LibSwap.swapWithFailover` returned `(success=false)` —
    ///         every adapter in the caller's try-list reverted.
    error SwapAllAdaptersFailed();

    /// @notice The loan isn't ERC20-on-ERC20 — NFT collateral / NFT
    ///         rental / illiquid-asset loans are out of scope for the
    ///         swap-to-repay surface in v1.
    error UnsupportedLoanShape();

    /// @notice Partial swap-to-repay proceeds would retire the full
    ///         loan principal. To avoid leaving an Active zero-principal
    ///         loan, the borrower must use `swapToRepayFull` instead —
    ///         which carries the close-out side-effects (Repaid status,
    ///         position-NFT lifecycle, reward close).
    error PartialWouldRetireFullPrincipal();

    /// @notice Repayment attempted past the loan's grace period —
    ///         beyond that point only `DefaultedFacet` can resolve.
    ///         Mirrored from `RepayFacet`.
    error RepaymentPastGracePeriod();

    /// @notice The offer was not opted into partial repay at creation;
    ///         the partial swap-to-repay path requires the lender's
    ///         pre-consent via `Offer.allowsPartialRepay`. Mirrored
    ///         from `RepayFacet`.
    error PartialRepayNotAllowed();

    /// @notice Partial swap-to-repay proceeds resolved to less than
    ///         the asset-level `minPartialBps` floor (`loan.principal *
    ///         minPartialBps / BASIS_POINTS`). Mirrored from `RepayFacet`.
    error InsufficientPartialAmount();

    /// @notice Pass-2 A2 (#1190, Codex #1229) — reverted when a swap-to-repay
    ///         partial would LOWER the loan's health factor. Unlike a direct
    ///         partial (collateral untouched → HF always improves), a swap sells
    ///         collateral AND repays principal, so a bad swap CAN worsen HF —
    ///         this monotonicity guard (replacing the old inverted 1.5 admission
    ///         floor) is the meaningful protection here, alongside the LTV cap.
    error PartialSwapWorsensHealthFactor(uint256 hfBefore, uint256 hfAfter);

    /// @notice Partial swap-to-repay: swap a portion of the borrower's
    ///         collateral for the principal asset and apply the proceeds
    ///         to a partial principal reduction. Resets the accrual
    ///         clock per `repayPartial` semantics.
    /// @dev    Gated on `loan.allowsPartialRepay` (snapshotted from
    ///         `Offer.allowsPartialRepay` at init). Post-swap HF check
    ///         per `repayPartial:771-783`.
    /// @param loanId               The loan to partially repay.
    /// @param collateralSwapAmount The collateral input to swap.
    /// @param adapterCalls         Keeper-ranked try-list.
    function swapToRepayPartial(
        uint256 loanId,
        uint256 collateralSwapAmount,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 — same custody-conflict rationale
        // as `swapToRepayFull`; block partial-atomic while the
        // intent surface holds the collateral.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        // #2407 — refused while a live refinance request targets the loan.
        LibRefinanceRequest.assertNone(loanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // #594 — consolidate a transferred borrower position into the current
        // holder's vault before the partial swap operates on it (borrower side,
        // skip-not-block). A partial repay keeps the loan Active and pays NO
        // proceeds to the lender (it reduces principal in place), so only the
        // borrower side consolidates here. The FULL swap-to-repay is the
        // both-side close-out (lender paid + borrower surplus), wired in #658
        // PR-B above.
        LibConsolidation.consolidateToHolder(
            loanId, false, LibConsolidation.Ctx.Tier2CloseOut
        );

        // ── Pre-flight gates ─────────────────────────────────────────
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();
        // Codex round-1 PR #390 P2 #4 (same fix as `swapToRepayFull`).
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20 ||
            loan.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) revert UnsupportedLoanShape();
        if (
            loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
        ) revert UnsupportedLoanShape();
        // Codex round-1 PR #390 P1 #3 (same fix as `swapToRepayFull`).
        LibAuth.requireBorrowerNftOwner(loan);

        // Codex round-2 PR #390 P2 #1 — block lender self-repay on
        // the partial path too. The full path had this guard from
        // round-0; without the mirror, a lender who has acquired the
        // borrower-side position NFT could consume claim-bearing
        // collateral and route the partial principal + interest into
        // their own lender vault while keeping the loan Active.
        if (msg.sender == loan.lender) revert LenderCannotRepayOwnLoan();
        if (
            IERC721(address(this)).ownerOf(loan.lenderTokenId) == msg.sender
        ) revert LenderCannotRepayOwnLoan();

        if (!loan.allowsPartialRepay) revert PartialRepayNotAllowed();

        if (collateralSwapAmount == 0 || collateralSwapAmount > loan.collateralAmount)
            revert InvalidAmount();

        uint256 endTime = loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();

        // Pass-2 A2 (#1190, Codex #1229) — capture PRE-swap HF for the
        // monotonicity gate. This loan is ERC-20-on-both-legs + liquid (asserted
        // above), so it always carries an HF. Unlike a direct partial, a swap
        // sells collateral AND repays principal, so HF is not guaranteed to
        // improve — the gate below asserts the swap does not worsen it.
        uint256 hfBefore = abi.decode(
            LibFacet.crossFacetStaticCall(
                abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
                HealthFactorCalculationFailed.selector
            ),
            (uint256)
        );

        // ── Slippage floor pre-flight ────────────────────────────────
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            collateralSwapAmount
        );
        uint256 minPrincipalOut = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - LibVaipakam.cfgMaxSwapToRepaySlippageBps())) /
            LibVaipakam.BASIS_POINTS;

        // ── Withdraw + swap ──────────────────────────────────────────
        // Codex round-3 P1 #2 — same partial-fill refund pattern
        // as `swapToRepayFull`.
        uint256 collateralBalanceBefore =
            IERC20(loan.collateralAsset).balanceOf(address(this));

        // #407 PR 4 round-1 Codex P1 #3 (2026-06-12) — decrement the
        // lien by the slice we're moving out. The loan stays ACTIVE
        // here so a full release would leave the residual collateral
        // unprotected from other ERC20 withdraw surfaces.
        _decrementLienAtSwapToRepayPartial(loanId, collateralSwapAmount);
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                loan.borrower,
                loan.collateralAsset,
                address(this),
                collateralSwapAmount
            ),
            VaultWithdrawFailed.selector
        );

        (bool success, uint256 outputAmount, uint256 adapterUsed) = LibSwap.swapWithFailover(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            collateralSwapAmount,
            minPrincipalOut,
            address(this),
            adapterCalls
        );
        if (!success) revert SwapAllAdaptersFailed();

        // Refund partial-fill leftover collateral to borrower vault.
        uint256 actualCollateralConsumed = collateralSwapAmount -
            (IERC20(loan.collateralAsset).balanceOf(address(this)) -
                collateralBalanceBefore);
        uint256 partialFillRefund = collateralSwapAmount - actualCollateralConsumed;
        if (partialFillRefund > 0) {
            IERC20(loan.collateralAsset).safeTransfer(
                LibFacet.getOrCreateVault(loan.borrower),
                partialFillRefund
            );
            LibVaipakam.recordVaultDeposit(
                loan.borrower,
                loan.collateralAsset,
                partialFillRefund
            );
            // #407 PR 4 round-1 — restore the lien for the dust that
            // landed back in the borrower vault; the loan stays Active
            // and that collateral still backs it.
            _incrementLienAtSwapToRepayPartial(loanId, partialFillRefund);
        }

        // #594 Codex #657 round-4 — the eager consolidation above checkpointed
        // the holder's VPFI tier/staking at the FULL pre-swap balance; the swap
        // just consumed the net (swap-amount minus any partial-fill refund) out
        // of their vault. Re-stamp at the post-swap balance so the holder
        // doesn't keep fee-tier/staking credit on VPFI that was swapped away.
        // No-op for non-VPFI collateral.
        if (loan.collateralAsset == s.vpfiToken) {
            LibConsolidation.restampUserVpfi(loan.borrower);
        }

        // ── Accrued-interest split + partial bound ───────────────────
        // Pass-2 A3 (#1191) — CREDIT any periodic-settled interest so the swap
        // partial charges only the UNSETTLED accrual (else it re-charges the
        // periodic auto-liquidation's already-settled days — the audit's M1 /
        // its SwapToRepay twin). Netted here; the stale `interestSettled` is
        // zeroed at the accrual-clock reset below (the #915 credit+zero pattern).
        uint256 grossAccrued = LibEntitlement.accruedInterestToTime(loan, block.timestamp);
        uint256 priorSettled = uint256(loan.interestSettled);
        uint256 accrued = LibEntitlement.creditSettledInterest(loan, grossAccrued);
        (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(loan, accrued);

        // Must at least cover the accrued interest.
        if (outputAmount < lenderShare + treasuryShare) revert InsufficientProceeds();
        uint256 partialPrincipal = outputAmount - lenderShare - treasuryShare;
        if (partialPrincipal == 0) revert InsufficientProceeds();

        // Codex round-1 P2 #3 — reject swaps that would retire the
        // full principal; borrower must use `swapToRepayFull` for
        // close-out side-effects.
        if (partialPrincipal >= loan.principal)
            revert PartialWouldRetireFullPrincipal();

        uint256 minPartial = (loan.principal *
            s.assetRiskParams[loan.principalAsset].minPartialBps) /
            LibVaipakam.BASIS_POINTS;
        if (partialPrincipal < minPartial) revert InsufficientPartialAmount();

        // ── Lender Yield Fee discount (§F2 / #1354 / #1383) ──────────
        // swap-to-repay-partial does NOT consolidate `loan.lender` — the lender
        // payout below resolves the CURRENT lender-NFT holder — so the discount
        // is keyed on that holder, not the (possibly stale) `loan.lender`. The
        // shift is treasury→lender, so `partialPrincipal` (already computed) and
        // the borrower surplus (below) are invariant.
        {
            address settlingLender = IERC721(address(this)).ownerOf(loan.lenderTokenId);
            (uint256 lenderExtra, uint256 newTreasury) = _resolveLenderYieldFee(
                loanId,
                settlingLender,
                accrued,
                treasuryShare
            );
            if (lenderExtra > 0) {
                lenderShare += lenderExtra;
                treasuryShare = newTreasury;
            }
        }

        // ── Settle waterfall — diamond-held pattern ──────────────────
        address treasury = LibFacet.getTreasury();
        if (treasuryShare > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, treasuryShare);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, treasuryShare);
        }

        // Codex round-3 P1 #1 + round-4 P1 #3 — pay the lender directly
        // on the partial path, but route to the CURRENT lender-side NFT
        // owner (not the stale `loan.lender` field). Lender rights
        // travel with the NFT just like borrower rights; without this
        // resolution, a plain ERC-721 transfer of the lender NFT
        // would leave the borrower's partial payment routing to the
        // original lender (who no longer owns the loan). The loan
        // stays Active so the lender has no claim slot, and
        // `vaultWithdrawERC20` is `onlyDiamondInternal` — direct EOA
        // transfer is the only path to actually realize the funds.
        address currentLenderHolder = IERC721(address(this))
            .ownerOf(loan.lenderTokenId);
        // #954 (§1.3) — `swapToRepayPartial` is a DISCRETIONARY, loan-stays-
        // Active path (the analogue of `repayPartial`), so it hard-SCREENS the
        // direct EOA payee rather than freezing: a flagged party's must-complete
        // escape hatch is `swapToRepayFull` (which freezes). Mirror
        // `repayPartial`'s Tier-1 screen on the discretionary payout.
        LibVaipakam._assertNotSanctioned(currentLenderHolder);
        uint256 lenderTotal = lenderShare + partialPrincipal;
        IERC20(loan.principalAsset).safeTransfer(currentLenderHolder, lenderTotal);

        // Any leftover principal (above accrued + partialPrincipal) →
        // current borrower-NFT holder's EOA directly (Codex round-4
        // P1 #2 / round-2 P1 #1). Same rationale as the full-path
        // surplus: Active partial-repay loans have no claim slot for
        // principal and vault withdraw is internal-only.
        uint256 surplus = outputAmount - treasuryShare - lenderTotal;
        if (surplus > 0) {
            address currentBorrowerHolder = IERC721(address(this))
                .ownerOf(loan.borrowerTokenId);
            // #954 (§1.3) — same Tier-1 discretionary screen on the borrower
            // surplus payee; the must-complete escape is `swapToRepayFull`.
            LibVaipakam._assertNotSanctioned(currentBorrowerHolder);
            IERC20(loan.principalAsset).safeTransfer(
                currentBorrowerHolder,
                surplus
            );
        }

        // ── Loan state updates ───────────────────────────────────────
        unchecked {
            loan.principal -= partialPrincipal;
            // Codex round-1 P1 #4 — reduce collateralAmount so HF /
            // default / claim logic reflects true post-swap backing.
            // Codex round-4 P1 #1 — use `actualCollateralConsumed`,
            // not `collateralSwapAmount`. On an aggregator partial-fill
            // the unspent input was already refunded to the vault
            // (above); subtracting the FULL `collateralSwapAmount`
            // here would double-count the loss and understate the
            // remaining backing for HF / default math.
            loan.collateralAmount -= actualCollateralConsumed;
        }
        // #408 / #410 / #413 (2026-06-12), Codex PR #559 round-1
        // P1: mirror `RepayFacet.repayPartial`'s Option A remaining-
        // committed-term tracking on this partial-repay entry point
        // too. Without it, a full-term loan partially repaid via
        // collateral swap would compute the floor on the reduced
        // principal but over the ORIGINAL term, drifting out of sync
        // with the formula `RepayFacet.repayPartial` uses on the same
        // loan state shape.
        //
        // #641 — the re-stamp lands on the dedicated INTEREST clock
        // (`interestAccrualStart` / `interestRemainingDays`); the term tuple
        // (`startTime` + `durationDays` → maturity + grace) is LEFT UNTOUCHED,
        // mirroring `RepayFacet.repayPartial`. Seed the clock from the term for
        // any loan that predates the fields before reading elapsed.
        LibVaipakam.seedInterestClockIfUnset(loan);
        uint256 elapsedSinceSegmentStart;
        unchecked {
            elapsedSinceSegmentStart =
                (block.timestamp - loan.interestAccrualStart) / LibVaipakam.ONE_DAY;
        }
        if (elapsedSinceSegmentStart >= loan.interestRemainingDays) {
            loan.interestRemainingDays = 0;
        } else {
            unchecked {
                loan.interestRemainingDays = uint16(
                    uint256(loan.interestRemainingDays) - elapsedSinceSegmentStart
                );
            }
        }
        loan.interestAccrualStart = uint64(block.timestamp); // reset accrual clock
        // Pass-2 A3 (#1191) — consume ONLY the settled portion this partial's
        // charge just netted (`grossAccrued`) and PRESERVE any excess: a periodic
        // auto-liquidation can OVERDELIVER (credits slippage-buffered proceeds >
        // interest accrued so far), so zeroing all of it would forfeit the
        // borrower's already-paid excess and later overstate the debt (Codex
        // #1229). The clock is reset above, so the surviving
        // `interestSettled - grossAccrued` credits future accrual.
        loan.interestSettled = priorSettled > grossAccrued
            ? priorSettled - grossAccrued
            : 0;

        // ── T-034 §4.5 — periodic-interest checkpoint advance
        //    (mirror RepayFacet:679-706) ────────────────────────────
        if (loan.periodicInterestCadence != LibVaipakam.PeriodicInterestCadence.None) {
            // Pass-2 A3 (#1191, Codex #1229) — credit the NETTED `accrued`, NOT
            // `grossAccrued`: the latter spans already-settled periods (the
            // accrual clock is not reset by periodic auto-liquidation), so adding
            // it would credit old interest into the new period and skip a
            // required auto-liquidation, underpaying the lender (Codex #1229
            // round 3, P1). Exact current-period attribution deferred to #1230.
            // Mirrors RepayFacet.
            uint256 newPaid = uint256(loan.interestPaidSinceLastPeriod) + accrued;
            if (newPaid > type(uint128).max) newPaid = type(uint128).max;
            loan.interestPaidSinceLastPeriod = SafeCast.toUint128(newPaid);
            if (LibPeriodicInterest.canAdvanceCheckpointInline(loan)) {
                // Codex round-1 PR #390 P2 #2 — emit the
                // `RepayPartialPeriodAdvanced` + `PeriodicInterestSettled`
                // events that off-chain accounting subscribes to. Both
                // are topic-matched to the RepayFacet declarations so
                // existing indexer / dashboard handlers fire here too.
                uint256 boundary = LibPeriodicInterest.periodEndAt(loan);
                uint256 expected = LibPeriodicInterest.expectedInterestForPeriod(loan);
                LibPeriodicInterest.advanceCheckpoint(loan);
                emit RepayPartialPeriodAdvanced(loanId, boundary, expected, msg.sender);
                emit PeriodicInterestSettled(
                    loanId,
                    boundary,
                    expected,
                    newPaid,
                    msg.sender
                );
            }
        }

        // ── Post-repay HF guard ──────────────────────────────────────
        // Pass-2 A2 (#1190, Codex #1229) — MONOTONICITY, not the old inverted
        // 1.5 admission floor (which blocked a sub-floor borrower from
        // deleveraging via a swap that improves HF but doesn't fully restore
        // 1.5 — the same bug A2 fixes on `repayPartial`). Assert the swap does
        // not WORSEN HF; the tier-LTV cap below is the separate over-consumption
        // guard (#394).
        uint256 hfAfter = abi.decode(
            LibFacet.crossFacetStaticCall(
                abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
                HealthFactorCalculationFailed.selector
            ),
            (uint256)
        );
        if (hfAfter < hfBefore) revert PartialSwapWorsensHealthFactor(hfBefore, hfAfter);

        // #394 Lever A (Codex #647 round-6) — also re-check post-swap LTV against
        // THIS loan's snapshotted admission init-LTV cap. For a depth-tiered
        // loan the HF snapshot is 1e18, so the HF check alone wouldn't stop a
        // partial swap-to-repay (under a permissive slippage) from consuming
        // collateral + repaying too little and ending ABOVE the tier-cap buffer
        // the lender accepted — same guard the partial-withdrawal / fallback-cure
        // paths enforce.
        bytes memory ltvResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId),
            LTVCalculationFailed.selector
        );
        uint256 ltv = abi.decode(ltvResult, (uint256));
        if (
            ltv >
            LibVaipakam.effectiveLoanInitLtvCapBps(
                loan.initLtvCapBpsAtInit,
                LibVaipakam.storageSlot().assetRiskParams[loan.collateralAsset].loanInitMaxLtvBps
            )
        ) revert LTVExceeded();

        // Codex round-3 P2 #1 + round-4 P2 #1 — emit `msg.sender`
        // (current borrower-NFT owner, not stale `loan.borrower`)
        // and `actualCollateralConsumed` (not the requested amount).
        emit SwapToRepayPartialExecuted(
            loanId,
            msg.sender,
            actualCollateralConsumed,
            outputAmount,
            partialPrincipal,
            adapterUsed
        );
    }

    /// @dev #407 PR 4 round-1 Codex P1 #3 (2026-06-12) — consolidated
    ///      cross-facet helpers. One per arg-shape; each call site
    ///      picks the selector.
    function _callEncumb2(bytes4 selector, uint256 loanId, uint256 arg2) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(selector, loanId, arg2),
            bytes4(0)
        );
    }

    /// @dev #1383 — resolve the lender yield-fee discount for `settlingLender`
    ///      via the `VPFIDiscountFacet` host, so the try-VPFI-then-direct-
    ///      reduction delivery bytecode stays off this at-EIP-170 facet. Returns
    ///      the deltas to fold into the settlement (`lenderShare += lenderExtra;
    ///      treasuryShare = newTreasury`). The host emits the analytics
    ///      passthrough on the VPFI-payment path, so the caller drops
    ///      `vpfiDeducted`. `settlingLender` is `loan.lender` on the consolidated
    ///      full close-out, or the current `ownerOf(lenderTokenId)` on the
    ///      non-consolidated partial path.
    function _resolveLenderYieldFee(
        uint256 loanId,
        address settlingLender,
        uint256 interestForQuote,
        uint256 treasuryShare
    ) private returns (uint256 lenderExtra, uint256 newTreasury) {
        // #1383 — short-circuit the ineligible/dark case with an INLINED
        // eligibility read (`consent OR Full`, no cross-facet routing) before
        // the host call. Keeps the resolve a strict no-op for every
        // unstamped/no-consent loan and never routes to `VPFIDiscountFacet` when
        // no discount can apply.
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (
            treasuryShare == 0 ||
            !LibVPFIDiscount.lenderYieldFeeEligible(loan, settlingLender)
        ) {
            return (0, treasuryShare);
        }
        bytes memory ret = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                VPFIDiscountFacet.resolveLenderYieldFeeFor.selector,
                loanId,
                settlingLender,
                interestForQuote,
                treasuryShare
            ),
            LenderYieldFeeResolveFailed.selector
        );
        (lenderExtra, newTreasury, ) = abi.decode(ret, (uint256, uint256, uint256));
    }

    function _decrementLienAtSwapToRepayPartial(uint256 loanId, uint256 consumed) private {
        _callEncumb2(EncumbranceMutateFacet.decrementCollateralLien.selector, loanId, consumed);
    }

    function _incrementLienAtSwapToRepayPartial(uint256 loanId, uint256 added) private {
        _callEncumb2(EncumbranceMutateFacet.incrementCollateralLien.selector, loanId, added);
    }
}
