// src/libraries/LibAutoList.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {
    FeeLeg,
    PREPAY_MODE_FIXED_PRICE,
    PREPAY_MODE_DUTCH
} from "../seaport/PrepayTypes.sol";

/**
 * @title  LibAutoList
 * @author Vaipakam Developer Team
 * @notice T-086 Round-7 (Issue #355) — pure math primitives for the
 *         grace-period auto-list-at-floor entry point. Computes the
 *         protocol-mandated floor (`askAtFloor`) and evaluates the
 *         B-cond rotation gates from §18.5 of the design doc.
 *
 *         Lives as a separate library so the facet's body stays
 *         under EIP-170 and the predicate math is reusable + unit-
 *         testable in isolation. Every entry point is `internal pure`
 *         or `internal view` — no storage writes, no external calls.
 *
 *         The library's surface:
 *
 *           - {askAtFloor} — the protocol-mandated minimum ask:
 *               `(lenderLeg + treasuryLeg) × (10_000 + bufferBps) /
 *               10_000`. Read by both Case A (fresh post) and Case B
 *               (rotation comparison) of `autoListAtFloorOnGrace`.
 *
 *           - {b_cond_1_fixedPriceAboveFloor} — fixed-price rotation
 *               gate. Dutch is carved out per round-3.9.
 *
 *           - {b_cond_2_signedLegsShort} — both-mode strict-shortfall
 *               gate against the executor's `_orderProtocolLegs`
 *               snapshot per round-3.8 + round-3.9.
 *
 *           - {b_cond_3a_dutchNeverReachesFee} — Dutch never decays
 *               to the fee-aware floor at all (compares `endAskPrice`
 *               against the fee-aware threshold).
 *
 *           - {b_cond_3b_dutchReachesFloorTooLate} — Dutch reaches
 *               the fee-aware floor strictly after the safe-margin
 *               boundary. Uses ceiling division to mirror Seaport's
 *               truncating `_locateCurrentAmount` per round-3.7.
 *               Underflow-guard branch (`askAtFee >= startAskPrice`)
 *               FIRES rotation per round-3.10.
 *
 *           - {b_cond_5_dutchExpired} — Dutch listing past its
 *               `auctionEndTime` while still inside grace.
 */
library LibAutoList {
    /// @notice Compute the protocol-mandated floor for an auto-list
    ///         post: the live protocol legs scaled up by the configured
    ///         safety buffer.
    /// @dev    `bufferBps` is the value stored on
    ///         `LibVaipakam.Storage.cfgPrepayListingBufferBps`; the
    ///         setter range-bounds it so the `+ bufferBps` addition
    ///         can't overflow `uint256`. No fee legs in the auto-list
    ///         path — the keeper has no off-chain attestation for
    ///         OpenSea / SignedZone fee schedules, so the post is
    ///         protocol-only.
    /// @param  pctx Live prepay-context resolved at `block.timestamp`.
    /// @param  bufferBps Configured prepay-listing buffer BPS.
    /// @return ask The minimum ask the auto-list path posts at.
    function askAtFloor(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        uint256 bufferBps
    ) internal pure returns (uint256 ask) {
        uint256 protocolLegs = pctx.lenderLeg + pctx.treasuryLeg;
        // `(10_000 + bufferBps) × protocolLegs / 10_000` matches the
        // existing `_requireAskCoversFloorWithFees` derivation in
        // `NFTPrepayListingFacet` — keeps the auto-list floor on the
        // same arithmetic shape so a borrower-posted ask AT the floor
        // and an auto-list ask AT the floor produce identical values.
        ask = (protocolLegs * (10_000 + bufferBps)) / 10_000;
    }

    /// @notice B-cond-1 (fixed-price only, Dutch carved out per
    ///         round-3.9) — existing fixed-price `existingAsk` is
    ///         strictly above the fee-aware floor.
    /// @dev    Threshold includes the recorded fee-leg sum
    ///         (`startAmount` for fixed-price, where `startAmount ==
    ///         endAmount`). For fee-free listings `feeSum` is zero
    ///         and the threshold collapses to `askAtFloor_`. The
    ///         predicate uses strict `>` because EQUALITY at the
    ///         floor is exactly the desired post; only ABOVE-floor
    ///         is "aspirational".
    /// @param  auctionMode Recorded mode from the executor's
    ///                     `OrderContext.mode`. Caller is responsible
    ///                     for invoking this only when the mode is
    ///                     `PREPAY_MODE_FIXED_PRICE`.
    /// @param  existingAsk Recorded `askPrice` from
    ///                     `OrderContext.askPrice`.
    /// @param  askAtFloor_ Output of {askAtFloor}.
    /// @param  recordedFeeLegs Snapshot of `_orderFeeLegs[orderHash]`.
    function b_cond_1_fixedPriceAboveFloor(
        uint8 auctionMode,
        uint256 existingAsk,
        uint256 askAtFloor_,
        FeeLeg[] memory recordedFeeLegs
    ) internal pure returns (bool) {
        // Dutch carve-out per round-3.9 against Codex round-9 P2 #3:
        // B-cond-1 applies ONLY to fixed-price. Dutch rotation is
        // owned by B-cond-2 / B-cond-3a / B-cond-3b / B-cond-5.
        if (auctionMode != PREPAY_MODE_FIXED_PRICE) return false;
        uint256 feeSum = 0;
        for (uint256 i = 0; i < recordedFeeLegs.length; ) {
            feeSum += uint256(recordedFeeLegs[i].startAmount);
            unchecked { ++i; }
        }
        return existingAsk > (askAtFloor_ + feeSum);
    }

    /// @notice B-cond-2 (both modes, round-3.9 strict-shortfall) —
    ///         the signed lender or treasury leg is strictly short of
    ///         live `pctx`.
    /// @dev    Mirrors the executor's per-leg fill-time check at
    ///         `CollateralListingExecutor._assertOrderContent`
    ///         (`consideration[0].amount < pctx.lenderLeg →
    ///         LenderShortPaid`). Strict `>` (not `> + 1`) per
    ///         round-3.9: the schema-extended read is direct from
    ///         storage with no arithmetic rounding to absorb, and a
    ///         1-wei shortfall makes the order unfillable.
    /// @param  pctx Live prepay-context.
    /// @param  recordedLender Signed lender amount snapshotted in
    ///                        `_orderProtocolLegs.lender`.
    /// @param  recordedTreasury Signed treasury amount snapshotted in
    ///                          `_orderProtocolLegs.treasury`.
    function b_cond_2_signedLegsShort(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        uint128 recordedLender,
        uint128 recordedTreasury
    ) internal pure returns (bool) {
        return
            pctx.lenderLeg > uint256(recordedLender) ||
            pctx.treasuryLeg > uint256(recordedTreasury);
    }

    /// @notice B-cond-3a (Dutch only, round-3.5 + 3.6 fee-aware) —
    ///         Dutch `endAskPrice` is strictly above the fee-aware
    ///         floor, so the auction never reaches the floor at any
    ///         tick.
    /// @dev    Fee-aware threshold uses the `endAmount` fee sum
    ///         (Dutch fee legs decay with the order; the at-end fee
    ///         sum is what `endAskPrice` covers). For fee-free Dutch
    ///         orders `endAmount` is empty and the comparison
    ///         collapses to `endAskPrice > askAtFloor_`.
    function b_cond_3a_dutchNeverReachesFee(
        uint8 auctionMode,
        uint256 endAskPrice,
        uint256 askAtFloor_,
        FeeLeg[] memory recordedFeeLegs
    ) internal pure returns (bool) {
        if (auctionMode != PREPAY_MODE_DUTCH) return false;
        uint256 endFeeSum = 0;
        for (uint256 i = 0; i < recordedFeeLegs.length; ) {
            endFeeSum += uint256(recordedFeeLegs[i].endAmount);
            unchecked { ++i; }
        }
        return endAskPrice > (askAtFloor_ + endFeeSum);
    }

    /// @notice B-cond-3b (Dutch only) — Dutch reaches the fee-aware
    ///         floor LATER than the safe-margin boundary `t_safe`.
    ///         Returns `true` when the rotation should fire.
    /// @dev    Round-3.7 ceiling division for `t_floor` (Seaport's
    ///         `_locateCurrentAmount` truncates the decay amount, so
    ///         a floor-divided crossing time reports one tick early).
    ///         Round-3.10 underflow guard: when `askAtFee >=
    ///         startAskPrice` (the Dutch start price is below the
    ///         current fee-aware floor — interest accrual or
    ///         governance buffer-bump pushed it there), FIRE
    ///         rotation immediately (supersedes round-3.6 "skip"
    ///         semantics — with round-3.8 signed-legs B-cond-2, a
    ///         pure buffer-bump wouldn't otherwise trigger any
    ///         rotation gate). Round-3.4 saturating fallback for
    ///         loans whose grace duration is shorter than the
    ///         configured margin: `safeMargin = graceDuration / 2`.
    /// @param  auctionMode `OrderContext.mode`.
    /// @param  startAskPrice Recorded `OrderContext.askPrice` (Dutch
    ///                       start ask).
    /// @param  endAskPrice Recorded `OrderContext.endAskPrice` (Dutch
    ///                     floor).
    /// @param  startTime Recorded `OrderContext.startTime`.
    /// @param  auctionEndTime Recorded `OrderContext.auctionEndTime`.
    /// @param  askAtFloor_ Output of {askAtFloor}.
    /// @param  recordedFeeLegs Snapshot of `_orderFeeLegs[orderHash]`.
    /// @param  loanGracePeriodEnd Loan's `gracePeriodEnd`
    ///                            (= `loanEnd + gracePeriod`).
    /// @param  loanEnd Loan's repayment deadline (= `startTime +
    ///                 durationDays × 1 days`); the base for the
    ///                 saturating `graceDuration` derivation.
    /// @param  dutchGraceMarginSec Governance-set value of
    ///         `Storage.cfgPrepayListingDutchGraceMarginSec` — the
    ///         desired safe-margin in seconds before `gracePeriodEnd`.
    function b_cond_3b_dutchReachesFloorTooLate(
        uint8 auctionMode,
        uint256 startAskPrice,
        uint256 endAskPrice,
        uint256 startTime,
        uint256 auctionEndTime,
        uint256 askAtFloor_,
        FeeLeg[] memory recordedFeeLegs,
        uint256 loanGracePeriodEnd,
        uint256 loanEnd,
        uint256 dutchGraceMarginSec
    ) internal pure returns (bool) {
        if (auctionMode != PREPAY_MODE_DUTCH) return false;

        // Fee-aware floor (round-3.6 against Codex round-6 P2 #1):
        // include the projected end-fee sum so a correctly-priced
        // fee-aware Dutch order at the exact floor doesn't false-
        // positive-fire.
        uint256 endFeeSum = 0;
        for (uint256 i = 0; i < recordedFeeLegs.length; ) {
            endFeeSum += uint256(recordedFeeLegs[i].endAmount);
            unchecked { ++i; }
        }
        uint256 askAtFee = askAtFloor_ + endFeeSum;

        // Round-3.10 against Codex round-10 P2 #5: underflow-guard
        // branch FIRES rotation. Either interest accrual or a
        // governance buffer-bump pushed `askAtFee` strictly above
        // the Dutch listing's `startAskPrice` — the auction
        // structurally cannot reach the live floor at any tick.
        //
        // Round-3.13 against Codex round-12 P2 #1: strict `>`
        // (not `>=`). The `==` case is a healthy Dutch listing
        // whose start price IS the live fee-aware floor — the
        // auction begins AT the floor on tick 0 and decays from
        // there. No rotation needed; including `==` in the
        // rotate-immediately branch contradicted the surrounding
        // B-cond-3 policy (rotate only when the Dutch listing
        // reaches the floor too late or never). Subtraction
        // safety is preserved: at equality
        // `startAskPrice - askAtFee = 0`, no underflow, and the
        // downstream `t_floor` formula proceeds normally (the
        // decay-tick calculation correctly returns 0 — the floor
        // is reached at the start tick).
        //
        // Round-3.4 against Codex round-3.2 P2 line 243 — the
        // degenerate-shape adversarial finding: at equality the
        // Dutch listing IS fillable only at the literal start tick;
        // any later tick has `currentPrice < askAtFee` and fills
        // would revert `LenderShortPaid` against the live legs.
        // Codex argued this warrants eager rotation. The design
        // sticks with strict `>` because b_cond_2 (signed-legs
        // shortfall) catches the next state-change automatically —
        // any interest accrual between the equality call and the
        // following call shifts live legs above signed legs and
        // b_cond_2 fires. A governance buffer-bump with no interest
        // accrual would shift the live floor strictly above
        // `startAskPrice`, at which point this guard (now strict
        // `>`) fires. So the equality case is correctly handled by
        // the COMBINATION of b_cond_2 + this guard on the very next
        // call; eager rotation at equality would over-rotate
        // borrower-intentional at-floor listings. The trade-off is
        // bounded — at most one block of degenerate state, after
        // which the next caller's b_cond gate fires.
        if (askAtFee > startAskPrice) return true;

        // Sanity gates: caller (the facet) should already have ruled
        // out these shapes via B-cond-3a / B-cond-2 / executor's own
        // shape invariants, but they're cheap belt-and-braces against
        // a malformed `OrderContext`.
        if (endAskPrice >= startAskPrice) return false; // denominator zero
        if (endAskPrice > askAtFee) return false;       // never crosses

        // Round-3.7 against Codex round-7 P2 #2: ceiling division to
        // match Seaport's truncating price-at-tick.
        //   duration = auctionEndTime - startTime
        //   numerator = (startAskPrice - askAtFee) × duration
        //   denominator = startAskPrice - endAskPrice
        //   t_floor = startTime + ceilDiv(numerator, denominator)
        uint256 duration = auctionEndTime - startTime;
        uint256 numerator = (startAskPrice - askAtFee) * duration;
        uint256 denominator = startAskPrice - endAskPrice;
        // Ceiling: (a + b - 1) / b for positive a, b. `denominator >
        // 0` from the early-return above.
        uint256 t_floor = startTime + (numerator + denominator - 1) / denominator;

        // Round-3.4 + round-3.6 against Codex round-6 P3 #5:
        // saturating `safeMargin` for loans whose grace duration is
        // shorter than the configured margin. `t_safe =
        // gracePeriodEnd - safeMargin`.
        //
        // T-086 Round-7 follow-up (Codex round-12 P2 #3): apply the
        // 3600-second protocol default when the operator-set value is
        // zero. Without this fallback the storage slot starts at 0 on
        // a fresh deploy and B-cond-3b's t_safe collapses to
        // `gracePeriodEnd`, so a Dutch listing decaying to the floor
        // only in the final tick of grace silently passes the gate.
        // That contradicts the design intent of the knob — the
        // setter is bounded against `MIN_LOAN_GRACE_PERIOD - 60`
        // precisely because the protocol expects a non-zero safe-
        // margin. Defaulting in the read path means operators don't
        // have to remember a one-time post-deploy config tx.
        uint256 effectiveMarginSec =
            dutchGraceMarginSec == 0 ? 3600 : dutchGraceMarginSec;
        uint256 graceDuration = loanGracePeriodEnd - loanEnd;
        uint256 safeMargin =
            graceDuration > effectiveMarginSec
                ? effectiveMarginSec
                : graceDuration / 2;
        uint256 t_safe = loanGracePeriodEnd - safeMargin;

        // Round-3.4 rounding policy: strict `>` favors NOT firing at
        // the boundary (`t_floor == t_safe` accepted; fill window
        // equals the configured margin exactly).
        return t_floor > t_safe;
    }

    /// @notice B-cond-5 (round-3.3 + round-3.5 + round-3.6) — Dutch
    ///         listing has passed its `auctionEndTime` while we're
    ///         still in the grace window. Seaport's `endTime` is
    ///         exclusive, so the order is no longer fillable and we
    ///         need to rotate to a fresh post.
    /// @dev    Boundary uses `>=` per round-3.5 boundary fix against
    ///         Codex round-5 P3: at `block.timestamp ==
    ///         auctionEndTime` the order is already dead.
    function b_cond_5_dutchExpired(
        uint8 auctionMode,
        uint256 auctionEndTime
    ) internal view returns (bool) {
        if (auctionMode != PREPAY_MODE_DUTCH) return false;
        return block.timestamp >= auctionEndTime;
    }
}
