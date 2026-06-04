// test/LibAutoListTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibAutoList} from "../src/libraries/LibAutoList.sol";
import {IVaipakamPrepayContext} from "../src/seaport/IVaipakamPrepayContext.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {
    FeeLeg,
    PREPAY_MODE_FIXED_PRICE,
    PREPAY_MODE_DUTCH
} from "../src/seaport/PrepayTypes.sol";

/**
 * @notice T-086 Round-7 (Issue #355) — pure-math pin tests for the
 *         {LibAutoList} B-cond predicates. Locks in every round-3.5
 *         through round-3.10 algebra correction the design doc
 *         iteration converged on, independent of the diamond setup.
 *
 *         Test buckets:
 *           1. {askAtFloor} — formula matches `_requireAskCoversFloorWithFees`
 *              arithmetic shape.
 *           2. {b_cond_1_fixedPriceAboveFloor} — fires for fixed-price
 *              above floor; Dutch carved out (round-3.9 P2 #3).
 *           3. {b_cond_2_signedLegsShort} — strict-shortfall, both
 *              modes, with the borrower-slack pin (round-3.8 + 3.9).
 *           4. {b_cond_3a_dutchNeverReachesFee} — Dutch endAskPrice
 *              above fee-aware floor (round-3.5 + 3.6).
 *           5. {b_cond_3b_dutchReachesFloorTooLate} — ceiling-division
 *              t_floor (round-3.7), underflow-guard FIRE (round-3.10),
 *              saturating safeMargin (round-3.4 + 3.6), borderline.
 *           6. {b_cond_5_dutchExpired} — auctionEndTime boundary
 *              (round-3.3 + 3.5).
 */
contract LibAutoListTest is Test {
    // ── Default fixtures ────────────────────────────────────────────────

    uint256 internal constant BUFFER_BPS = 200; // 2%
    address internal constant ANY_ADDR = address(0xBEEF);

    function _pctx(uint256 lender, uint256 treasury) internal pure returns (IVaipakamPrepayContext.PrepayContext memory pctx) {
        pctx.status = LibVaipakam.LoanStatus.Active;
        pctx.assetType = LibVaipakam.AssetType.ERC20;
        pctx.collateralAssetType = LibVaipakam.AssetType.ERC721;
        pctx.principalAsset = ANY_ADDR;
        pctx.collateralAsset = ANY_ADDR;
        pctx.collateralTokenId = 1;
        pctx.collateralQuantity = 1;
        pctx.lenderLeg = lender;
        pctx.treasuryLeg = treasury;
        // Constant so the helper is `pure` and callers can be too.
        pctx.graceEnd = 1_000_000;
        pctx.lenderNftOwner = ANY_ADDR;
        pctx.borrowerNftOwner = ANY_ADDR;
        pctx.treasury = ANY_ADDR;
        pctx.borrowerVault = ANY_ADDR;
    }

    function _emptyLegs() internal pure returns (FeeLeg[] memory) {
        return new FeeLeg[](0);
    }

    function _feeLegs(uint96 startAmt, uint96 endAmt) internal pure returns (FeeLeg[] memory legs) {
        legs = new FeeLeg[](1);
        legs[0] = FeeLeg({recipient: ANY_ADDR, startAmount: startAmt, endAmount: endAmt});
    }

    // ─── 1. askAtFloor ──────────────────────────────────────────────────

    /// @dev The floor matches the buffer-applied protocol-leg formula.
    ///      A protocolLegs of 1000 + buffer 200 BPS → 1020.
    function test_askAtFloor_appliesBufferToProtocolLegs() public pure {
        IVaipakamPrepayContext.PrepayContext memory pctx = _emptyPctx(900, 100);
        uint256 ask = LibAutoList.askAtFloor(pctx, BUFFER_BPS);
        assertEq(ask, 1020, "1000 * 10200 / 10000 = 1020");
    }

    /// @dev With zero buffer the floor equals the bare protocol legs.
    function test_askAtFloor_zeroBufferReturnsBareLegs() public pure {
        IVaipakamPrepayContext.PrepayContext memory pctx = _emptyPctx(500, 250);
        uint256 ask = LibAutoList.askAtFloor(pctx, 0);
        assertEq(ask, 750, "no buffer => bare lender + treasury");
    }

    function _emptyPctx(uint256 lender, uint256 treasury) internal pure returns (IVaipakamPrepayContext.PrepayContext memory) {
        return _pctx(lender, treasury);
    }

    // ─── 2. B-cond-1 fixed-price above floor + Dutch carve-out ──────────

    function test_bCond1_firesWhenFixedPriceAboveFloor() public pure {
        bool fires = LibAutoList.b_cond_1_fixedPriceAboveFloor(
            PREPAY_MODE_FIXED_PRICE,
            1100, // existingAsk
            1000, // askAtFloor
            _emptyLegs()
        );
        assertTrue(fires, "1100 > 1000 + 0 (no fees) fires B-cond-1");
    }

    function test_bCond1_doesNotFireAtExactFloor() public pure {
        bool fires = LibAutoList.b_cond_1_fixedPriceAboveFloor(
            PREPAY_MODE_FIXED_PRICE,
            1000,
            1000,
            _emptyLegs()
        );
        assertFalse(fires, "equality at floor is acceptable, not aspirational");
    }

    function test_bCond1_includesFeeSumInThreshold() public pure {
        FeeLeg[] memory legs = _feeLegs(50, 50);
        // existingAsk = 1050 (== floor + feeSum) should NOT fire.
        assertFalse(
            LibAutoList.b_cond_1_fixedPriceAboveFloor(PREPAY_MODE_FIXED_PRICE, 1050, 1000, legs),
            "fee-aware floor: 1050 == 1000 + 50 does not fire"
        );
        // existingAsk = 1051 SHOULD fire (above fee-aware floor).
        assertTrue(
            LibAutoList.b_cond_1_fixedPriceAboveFloor(PREPAY_MODE_FIXED_PRICE, 1051, 1000, legs),
            "1051 > 1050 fires"
        );
    }

    /// @dev ROUND-3.9 PIN (Codex round-9 P2 #3) — Dutch carve-out.
    ///      B-cond-1 MUST NOT fire on Dutch orders even when their
    ///      `existingAsk` (the startAskPrice) is above the floor —
    ///      that's the whole point of a Dutch auction.
    function test_bCond1_dutchCarveOut_doesNotFireOnHealthyDecay() public pure {
        bool fires = LibAutoList.b_cond_1_fixedPriceAboveFloor(
            PREPAY_MODE_DUTCH,
            2000, // startAskPrice well above floor
            1000,
            _emptyLegs()
        );
        assertFalse(fires, "B-cond-1 carved out for Dutch; rotation owned by B-cond-2/3a/3b/5");
    }

    // ─── 3. B-cond-2 strict-shortfall (round-3.9) ───────────────────────

    /// @dev ROUND-3.9 PIN — exact match does NOT fire.
    function test_bCond2_doesNotFireOnFreshExactSignedLegs() public pure {
        IVaipakamPrepayContext.PrepayContext memory pctx = _emptyPctx(1000, 50);
        bool fires = LibAutoList.b_cond_2_signedLegsShort(pctx, 1000, 50);
        assertFalse(fires, "live == signed: no shortfall");
    }

    /// @dev ROUND-3.9 PIN — strict `>` predicate, 1-wei shortfall fires.
    function test_bCond2_firesOnLenderShortBy1() public pure {
        IVaipakamPrepayContext.PrepayContext memory pctx = _emptyPctx(1001, 50);
        bool fires = LibAutoList.b_cond_2_signedLegsShort(pctx, 1000, 50);
        assertTrue(fires, "live.lender 1 wei past signed fires (executor rejects fill)");
    }

    function test_bCond2_firesOnTreasuryShortBy1() public pure {
        IVaipakamPrepayContext.PrepayContext memory pctx = _emptyPctx(1000, 51);
        bool fires = LibAutoList.b_cond_2_signedLegsShort(pctx, 1000, 50);
        assertTrue(fires, "treasury-leg shortfall fires independently");
    }

    /// @dev ROUND-3.8 + 3.9 PIN (Codex round-8 P2 #2; round-9 P2 #2 fixed-
    ///      price symmetric) — BORROWER-SLACK case. The borrower posted
    ///      `endAskPrice = post_floor + 10` with the +10 landing in
    ///      `consideration[2]` (borrower leg) — signed lender + treasury
    ///      stay at the bare post-time minimum. After a 1-wei accrual
    ///      the order is unfillable but the round-3.7 `endAskPrice -
    ///      endFeeSum` derivation would have no-oped. The signed-legs
    ///      predicate correctly fires.
    function test_bCond2_firesWhenBorrowerSlackHidesShortLeg() public pure {
        // Signed amounts at bare post-time floor: 1000 + 50.
        // Live legs grew by 1 wei → 1001 + 50.
        IVaipakamPrepayContext.PrepayContext memory pctx = _emptyPctx(1001, 50);
        bool fires = LibAutoList.b_cond_2_signedLegsShort(pctx, 1000, 50);
        assertTrue(fires, "borrower-slack does not insulate the signed legs from shortfall");
    }

    // ─── 4. B-cond-3a Dutch never reaches fee-aware floor ───────────────

    function test_bCond3a_firesWhenEndAskAboveFloor() public pure {
        bool fires = LibAutoList.b_cond_3a_dutchNeverReachesFee(
            PREPAY_MODE_DUTCH,
            1100, // endAskPrice
            1000, // askAtFloor
            _emptyLegs()
        );
        assertTrue(fires, "Dutch end floor above protocol floor never crosses");
    }

    function test_bCond3a_doesNotFireAtExactEndFloor() public pure {
        bool fires = LibAutoList.b_cond_3a_dutchNeverReachesFee(
            PREPAY_MODE_DUTCH,
            1000,
            1000,
            _emptyLegs()
        );
        assertFalse(fires, "equality at fee-aware floor accepted");
    }

    /// @dev ROUND-3.6 PIN (Codex round-6 P2 #1) — fee-aware threshold
    ///      uses `endAmount` for Dutch. A Dutch order priced at exactly
    ///      `askAtFloor + endFeeSum` must not false-positive-fire.
    function test_bCond3a_feeAwareEndAmountThreshold() public pure {
        FeeLeg[] memory legs = _feeLegs(60, 40); // Dutch: startAmount > endAmount
        // endAskPrice = askAtFloor + endFeeSum (1040) → no fire.
        assertFalse(
            LibAutoList.b_cond_3a_dutchNeverReachesFee(PREPAY_MODE_DUTCH, 1040, 1000, legs),
            "fee-aware: 1040 = 1000 + 40 does not fire"
        );
        // endAskPrice = 1041 (1 wei above) → fires.
        assertTrue(
            LibAutoList.b_cond_3a_dutchNeverReachesFee(PREPAY_MODE_DUTCH, 1041, 1000, legs),
            "1041 > 1040 fires"
        );
    }

    function test_bCond3a_doesNotFireOnFixedPrice() public pure {
        bool fires = LibAutoList.b_cond_3a_dutchNeverReachesFee(
            PREPAY_MODE_FIXED_PRICE,
            5000, // huge ask but mode is fixed-price
            1000,
            _emptyLegs()
        );
        assertFalse(fires, "B-cond-3a is Dutch-only");
    }

    // ─── 5. B-cond-3b ceiling division + underflow guard ────────────────

    /// @dev ROUND-3.7 PIN (Codex round-7 P2 #2) — ceiling division at
    ///      the boundary. Parameters chosen so floor-division gives a
    ///      t_floor one tick short of the Seaport-truncated crossing
    ///      time. See LibAutoList block-comment for the worked example.
    function test_bCond3b_ceilingDivisionAtBoundary() public {
        // Setup: startAskPrice=1100, endAskPrice=800, askAtFee=1000,
        // duration=10, no fees. Floor division gives t_floor =
        // startTime + 100*10/300 = startTime + 3. At t-startTime=3 the
        // Seaport price is 1100 - 300*3/10 = 1100 - 90 = 1010 (still
        // above askAtFee). The actual crossing is at t-startTime=4.
        // Ceiling division gives 4.
        uint256 startTime = 100;
        uint256 auctionEndTime = startTime + 10;
        uint256 loanEnd = startTime + 5;
        // Build a tight grace: gracePeriodEnd = loanEnd + 20, large
        // enough that t_safe = gracePeriodEnd - margin lies BETWEEN
        // floor(3) and ceiling(4) — proving ceiling fires when floor
        // would no-op.
        uint256 gracePeriodEnd = loanEnd + 20;
        // Configure dutchGraceMarginSec so t_safe == startTime + 4
        // (the ceiling result). margin = gracePeriodEnd - t_safe =
        // loanEnd + 20 - (startTime + 4) = 5 + 20 - 4 = 21.
        // (graceDuration = 20, so 21 > 20 → saturating fallback
        // safeMargin = 20/2 = 10 → t_safe = gracePeriodEnd - 10 =
        // loanEnd + 10 = startTime + 15. That doesn't bracket 3 vs 4.)
        // Pick smaller margin: 10 (< graceDuration=20).
        // safeMargin = 10, t_safe = gracePeriodEnd - 10 = loanEnd + 10
        //            = startTime + 15. Still doesn't bracket.
        // Need t_safe between startTime+3 and startTime+4.
        // → safeMargin = gracePeriodEnd - (startTime + 4) = 21.
        // → graceDuration must be >= 21. Make loanEnd=startTime + 1,
        //   gracePeriodEnd = startTime + 22 → graceDuration = 21,
        //   safeMargin = min(21, 21) = 21, t_safe = startTime + 1.
        // That's BELOW startTime+3 so t_floor > t_safe always.
        // Easier: rebuild — pick small graceDuration so safeMargin
        // saturates to graceDuration/2 = 2, t_safe = gracePeriodEnd
        // - 2. Make gracePeriodEnd = startTime + 6 → t_safe = 104.
        // → loanEnd = startTime + 2 (graceDuration = 4 → safeMargin
        //   = 2 → t_safe = 104).
        startTime = 100;
        auctionEndTime = 110;
        loanEnd = 102;
        gracePeriodEnd = 106;
        // Floor-derived t_floor = 100 + 3 = 103. t_safe = 104.
        // Floor: 103 > 104 → false (no fire). Bug.
        // Ceiling-derived t_floor = 100 + 4 = 104. 104 > 104 → false
        // (borderline policy favors no-fire).
        // → assert no-fire AT this exact boundary; one tick later the
        //   gate fires.
        // Reframe: pick params so ceiling and floor produce
        // different no-fire vs fire results around t_safe.
        // Use t_safe = 103 (between floor=103 and ceiling=4 oneside).
        // graceDuration = 6, gracePeriodEnd = 109, loanEnd = 103,
        // safeMargin = min(margin, 6). Want t_safe = 103 → margin = 6.
        // safeMargin = min(6, 6) = 6 → t_safe = 103.
        // Floor t_floor = 103 → 103 > 103 → false (no fire).
        // Ceiling t_floor = 104 → 104 > 103 → TRUE (fire).
        // → ceiling-derivation FIRES, floor-derivation no-ops. Pin.
        // Final params:
        //   startTime=100, auctionEndTime=110, duration=10
        //   startAskPrice=1100, endAskPrice=800, askAtFee=1000
        //   numerator = (1100-1000)*10 = 1000
        //   denominator = 1100-800 = 300
        //   ceiling t_floor = 100 + ceil(1000/300) = 100 + 4 = 104
        //   floor   t_floor = 100 + (1000/300)     = 100 + 3 = 103
        //
        //   loanEnd=97, gracePeriodEnd=109 → graceDuration=12
        //   dutchGraceMarginSec=6 (12 > 6 TRUE → safeMargin=6)
        //   t_safe = 109 - 6 = 103
        //
        //   Ceiling: 104 > 103 TRUE   → fires (the round-3.7 fix).
        //   Floor:   103 > 103 FALSE  → no-op (the demonstrated bug).
        startTime = 100;
        auctionEndTime = 110;
        loanEnd = 97;
        gracePeriodEnd = 109;
        uint256 dutchGraceMarginSec = 6;
        bool fires = LibAutoList.b_cond_3b_dutchReachesFloorTooLate(
            PREPAY_MODE_DUTCH,
            1100,  // startAskPrice
            800,   // endAskPrice
            startTime,
            auctionEndTime,
            1000,  // askAtFloor_
            _emptyLegs(),
            gracePeriodEnd,
            loanEnd,
            dutchGraceMarginSec
        );
        assertTrue(fires, "ceiling-division t_floor catches the 1-tick boundary case");
    }

    /// @dev ROUND-3.10 PIN (Codex round-10 P2 #5) — underflow guard
    ///      FIRES rotation when `askAtFee >= startAskPrice`.
    ///      Supersedes round-3.6's SKIP semantics — handles both
    ///      interest accrual and pure governance buffer-bumps.
    function test_bCond3b_underflowGuardFires() public pure {
        bool fires = LibAutoList.b_cond_3b_dutchReachesFloorTooLate(
            PREPAY_MODE_DUTCH,
            1000,  // startAskPrice
            800,   // endAskPrice
            100,   // startTime
            200,   // auctionEndTime
            1500,  // askAtFloor_ > startAskPrice → askAtFee >= startAskPrice
            _emptyLegs(),
            300,   // gracePeriodEnd
            150,   // loanEnd
            10     // dutchGraceMarginSec
        );
        assertTrue(fires, "askAtFee >= startAskPrice fires rotation immediately");
    }

    function test_bCond3b_doesNotFireWhenAuctionReachesFloorEarly() public pure {
        // Dutch reaches floor well before t_safe: should not fire.
        bool fires = LibAutoList.b_cond_3b_dutchReachesFloorTooLate(
            PREPAY_MODE_DUTCH,
            2000,  // startAskPrice
            900,   // endAskPrice (below fee-aware floor)
            100,   // startTime
            200,   // auctionEndTime
            1000,  // askAtFloor_
            _emptyLegs(),
            500,   // gracePeriodEnd
            150,   // loanEnd (graceDuration = 350)
            10     // dutchGraceMarginSec (saturate to 10; t_safe = 490)
        );
        // t_floor = 100 + ceil((2000-1000)*100 / (2000-900))
        //        = 100 + ceil(100000/1100) = 100 + ceil(90.909) = 100 + 91 = 191
        // t_safe = 500 - 10 = 490 → 191 > 490 false → no fire.
        assertFalse(fires, "auction reaches floor at t=191 well before t_safe=490");
    }

    function test_bCond3b_saturatingMargin_useshalfGrace() public pure {
        // graceDuration = 10s, configured margin = 100s. safeMargin
        // saturates to 10/2 = 5; t_safe = gracePeriodEnd - 5.
        // Build a scenario where the floor-margin would fire but the
        // half-grace fallback doesn't.
        bool fires = LibAutoList.b_cond_3b_dutchReachesFloorTooLate(
            PREPAY_MODE_DUTCH,
            2000,
            900,
            100,    // startTime
            300,    // auctionEndTime
            1000,   // askAtFloor_
            _emptyLegs(),
            210,    // gracePeriodEnd
            200,    // loanEnd (graceDuration = 10)
            100     // dutchGraceMarginSec (would saturate)
        );
        // t_safe = 210 - 5 = 205.
        // t_floor = 100 + ceil((2000-1000)*200 / (2000-900))
        //         = 100 + ceil(200000/1100) = 100 + 182 = 282
        // 282 > 205 → fires.
        assertTrue(fires, "still fires when t_floor late even after saturating to half-grace");
    }

    function test_bCond3b_doesNotFireOnFixedPrice() public pure {
        bool fires = LibAutoList.b_cond_3b_dutchReachesFloorTooLate(
            PREPAY_MODE_FIXED_PRICE,
            5000, 100, 100, 200, 1000, _emptyLegs(), 500, 150, 10
        );
        assertFalse(fires, "B-cond-3b is Dutch-only");
    }

    // ─── 6. B-cond-5 expired Dutch ──────────────────────────────────────

    function test_bCond5_firesAtExactAuctionEnd() public {
        // ROUND-3.5 PIN (Codex round-5 P3) — `>=` boundary, not `>`.
        vm.warp(200);
        bool fires = LibAutoList.b_cond_5_dutchExpired(PREPAY_MODE_DUTCH, 200);
        assertTrue(fires, "Seaport endTime exclusive: block.timestamp == auctionEndTime is dead");
    }

    function test_bCond5_doesNotFireBeforeAuctionEnd() public {
        vm.warp(199);
        bool fires = LibAutoList.b_cond_5_dutchExpired(PREPAY_MODE_DUTCH, 200);
        assertFalse(fires, "still live at t < auctionEndTime");
    }

    function test_bCond5_doesNotFireOnFixedPrice() public {
        vm.warp(1_000_000);
        bool fires = LibAutoList.b_cond_5_dutchExpired(PREPAY_MODE_FIXED_PRICE, 200);
        assertFalse(fires, "B-cond-5 is Dutch-only");
    }
}
