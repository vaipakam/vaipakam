// test/BulkDashboardViewsTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibMetricsTypes} from "../src/libraries/LibMetricsTypes.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {MetricsDashboardFacet} from "../src/facets/MetricsDashboardFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @notice #1025 — coverage for the bulk wallet-dashboard batch-by-id views
 *         {MetricsDashboardFacet.getOffersWithState} / {getLoansBatch}. Seeds
 *         offers/loans directly through {TestMutatorFacet} (same pattern as
 *         EnumerationTest) so every lifecycle branch is exercised without
 *         driving the full offer→loan flow. Guards:
 *           - per-element {OfferState} parity vs {MetricsFacet.getOfferState}
 *             (the hoisted single-source derivation can't drift);
 *           - field parity vs the raw storage row (no field dropped/transposed);
 *           - never-existed id → zero element, batch does NOT revert;
 *           - strict positional, NON-deduped output (dual-role holders);
 *           - the {MAX_BATCH_IDS} cap ({BatchTooLarge}) + boundary;
 *           - empty array; large (MAX_BATCH_IDS) array (viaIR array-coder).
 */
contract BulkDashboardViewsTest is SetupTest {
    MetricsDashboardFacet dash;
    MetricsFacet metrics;
    address u1;
    address u2;

    function setUp() public {
        setupHelper();
        dash = MetricsDashboardFacet(address(diamond));
        metrics = MetricsFacet(address(diamond));
        u1 = makeAddr("u1");
        u2 = makeAddr("u2");
    }

    // ─── seeding ─────────────────────────────────────────────────────────────

    /// @dev A richly-populated open offer so field-parity assertions are real.
    function _seedRichOffer(uint256 offerId, address creator_) internal {
        LibVaipakam.Offer memory o;
        o.id = offerId;
        o.creator = creator_;
        o.offerType = LibVaipakam.OfferType.Lender;
        o.assetType = LibVaipakam.AssetType.ERC20;
        o.collateralAssetType = LibVaipakam.AssetType.ERC20;
        o.lendingAsset = mockERC20;
        o.collateralAsset = mockERC20;
        o.amount = 100 ether;
        o.amountMax = 120 ether;
        o.amountFilled = 10 ether;
        o.interestRateBps = 500;
        o.interestRateBpsMax = 900;
        o.durationDays = 30;
        o.tokenId = 7;
        o.collateralAmount = 150 ether;
        o.collateralTokenId = 8;
        o.collateralQuantity = 3;
        o.quantity = 2;
        o.positionTokenId = 4242;
        o.prepayAsset = mockERC20;
        o.useFullTermInterest = true;
        o.creatorRiskAndTermsConsent = true;
        o.allowsPartialRepay = true;
        o.fillMode = LibVaipakam.FillMode.Partial;
        o.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        o.collateralLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        o.createdAt = uint64(block.timestamp);
        o.expiresAt = uint64(block.timestamp + 7 days);
        TestMutatorFacet(address(diamond)).setOffer(offerId, o);
    }

    function _seedAcceptedOffer(uint256 offerId, address creator_) internal {
        LibVaipakam.Offer memory o;
        o.id = offerId;
        o.creator = creator_;
        o.accepted = true;
        o.lendingAsset = mockERC20;
        o.amount = 50 ether;
        o.offerType = LibVaipakam.OfferType.Lender;
        o.assetType = LibVaipakam.AssetType.ERC20;
        TestMutatorFacet(address(diamond)).setOffer(offerId, o);
    }

    function _seedConsumedBySaleOffer(uint256 offerId, address creator_) internal {
        LibVaipakam.Offer memory o;
        o.id = offerId;
        o.creator = creator_;
        o.lendingAsset = mockERC20;
        o.amount = 40 ether;
        o.offerType = LibVaipakam.OfferType.Lender;
        o.assetType = LibVaipakam.AssetType.ERC20;
        TestMutatorFacet(address(diamond)).setOffer(offerId, o);
        TestMutatorFacet(address(diamond)).setOfferConsumedBySaleRaw(offerId, true);
    }

    function _seedLoan(
        uint256 loanId,
        address lender_,
        address borrower_,
        LibVaipakam.LoanStatus status
    ) internal {
        LibVaipakam.Loan memory l;
        l.id = loanId;
        l.offerId = loanId + 100;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principal = 100 ether;
        l.principalAsset = mockERC20;
        l.collateralAsset = mockERC20;
        l.collateralAmount = 150 ether;
        l.status = status;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        l.interestRateBps = 700;
        l.lenderTokenId = loanId * 10 + 1;
        l.borrowerTokenId = loanId * 10 + 2;
        l.allowsPartialRepay = true;
        TestMutatorFacet(address(diamond)).setLoan(loanId, l);
    }

    // ─── getOffersWithState ──────────────────────────────────────────────────

    function testOffersWithState_StatesAndParity() public {
        _seedRichOffer(1, u1);
        _seedAcceptedOffer(2, u1);
        TestMutatorFacet(address(diamond)).setOfferCancelled(3, true); // id==0 + cancelled
        _seedConsumedBySaleOffer(4, u1);

        uint256[] memory ids = new uint256[](5);
        ids[0] = 1; ids[1] = 2; ids[2] = 3; ids[3] = 4; ids[4] = 999; // 999 never-existed

        LibMetricsTypes.OfferView[] memory v = dash.getOffersWithState(ids);
        assertEq(v.length, 5, "length");

        // State parity — each element's state equals the single-id getOfferState.
        for (uint256 i = 0; i < ids.length; i++) {
            assertEq(uint8(v[i].state), uint8(metrics.getOfferState(ids[i])), "state parity");
        }
        assertEq(uint8(v[0].state), uint8(LibMetricsTypes.OfferState.Open), "open");
        assertEq(uint8(v[1].state), uint8(LibMetricsTypes.OfferState.Accepted), "accepted");
        assertEq(uint8(v[2].state), uint8(LibMetricsTypes.OfferState.Cancelled), "cancelled");
        assertEq(uint8(v[3].state), uint8(LibMetricsTypes.OfferState.ConsumedBySale), "consumed");
        assertEq(uint8(v[4].state), uint8(LibMetricsTypes.OfferState.Cancelled), "never-existed=cancelled");

        // Field parity against the rich seeded offer (every projected field).
        LibMetricsTypes.OfferView memory r = v[0];
        assertEq(r.id, 1, "id");
        assertEq(r.creator, u1, "creator");
        assertEq(uint8(r.offerType), uint8(LibVaipakam.OfferType.Lender), "offerType");
        assertEq(r.accepted, false, "accepted flag");
        assertEq(r.lendingAsset, mockERC20, "lendingAsset");
        assertEq(r.collateralAsset, mockERC20, "collateralAsset");
        assertEq(r.amount, 100 ether, "amount");
        assertEq(r.amountMax, 120 ether, "amountMax");
        assertEq(r.amountFilled, 10 ether, "amountFilled");
        assertEq(r.interestRateBps, 500, "rate");
        assertEq(r.interestRateBpsMax, 900, "rateMax");
        assertEq(r.durationDays, 30, "duration");
        assertEq(r.tokenId, 7, "tokenId");
        assertEq(r.collateralAmount, 150 ether, "collateralAmount");
        assertEq(r.collateralTokenId, 8, "collateralTokenId");
        assertEq(r.collateralQuantity, 3, "collateralQuantity");
        assertEq(r.quantity, 2, "quantity");
        assertEq(r.positionTokenId, 4242, "positionTokenId");
        assertEq(r.prepayAsset, mockERC20, "prepayAsset");
        assertTrue(r.useFullTermInterest, "useFullTermInterest");
        assertTrue(r.creatorRiskAndTermsConsent, "consent");
        assertTrue(r.allowsPartialRepay, "allowsPartialRepay");
        assertEq(uint8(r.fillMode), uint8(LibVaipakam.FillMode.Partial), "fillMode");
        assertEq(uint8(r.principalLiquidity), uint8(LibVaipakam.LiquidityStatus.Liquid), "principalLiquidity");
        assertEq(uint8(r.collateralLiquidity), uint8(LibVaipakam.LiquidityStatus.Illiquid), "collateralLiquidity");
    }

    function testOffersWithState_NeverExistedIsZeroValue() public view {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 424242;
        LibMetricsTypes.OfferView[] memory v = dash.getOffersWithState(ids);
        assertEq(v.length, 1, "length");
        assertEq(v[0].id, 0, "zero id");
        assertEq(v[0].creator, address(0), "zero creator");
        assertEq(uint8(v[0].state), uint8(LibMetricsTypes.OfferState.Cancelled), "state");
    }

    function testOffersWithState_DuplicatesPreservedPositional() public {
        _seedRichOffer(5, u1);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 5; ids[1] = 5;
        LibMetricsTypes.OfferView[] memory v = dash.getOffersWithState(ids);
        assertEq(v.length, 2, "no dedupe");
        assertEq(v[0].id, 5, "e0");
        assertEq(v[1].id, 5, "e1 duplicate");
        assertEq(v[0].creator, v[1].creator, "identical rows");
    }

    function testOffersWithState_Empty() public view {
        uint256[] memory ids = new uint256[](0);
        LibMetricsTypes.OfferView[] memory v = dash.getOffersWithState(ids);
        assertEq(v.length, 0, "empty");
    }

    // ─── getLoansBatch ───────────────────────────────────────────────────────

    function testLoansBatch_FieldParity() public {
        _seedLoan(1, u1, u2, LibVaipakam.LoanStatus.Active);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        LibMetricsTypes.LoanView[] memory v = dash.getLoansBatch(ids);
        assertEq(v.length, 1, "length");
        assertEq(v[0].lender, u1, "lender");
        assertEq(v[0].borrower, u2, "borrower");
        assertEq(v[0].loan.id, 1, "id");
        assertEq(v[0].loan.offerId, 101, "offerId");
        assertEq(v[0].loan.principal, 100 ether, "principal");
        assertEq(v[0].loan.principalAsset, mockERC20, "principalAsset");
        assertEq(v[0].loan.collateralAmount, 150 ether, "collateralAmount");
        assertEq(uint8(v[0].loan.status), uint8(LibVaipakam.LoanStatus.Active), "status");
        assertEq(v[0].loan.interestRateBps, 700, "rate");
        assertEq(v[0].loan.durationDays, 30, "duration");
        assertEq(v[0].loan.lenderTokenId, 11, "lenderTokenId");
        assertEq(v[0].loan.borrowerTokenId, 12, "borrowerTokenId");
        assertTrue(v[0].loan.allowsPartialRepay, "allowsPartialRepay");
    }

    function testLoansBatch_UnknownIsZeroValue() public view {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 987654;
        LibMetricsTypes.LoanView[] memory v = dash.getLoansBatch(ids);
        assertEq(v.length, 1, "length");
        assertEq(v[0].lender, address(0), "zero lender");
        assertEq(v[0].borrower, address(0), "zero borrower");
        assertEq(v[0].loan.id, 0, "zero id");
    }

    /// @dev Dual-role holder: the frontend passes the same loanId twice (one
    ///      per held position NFT). The view MUST echo two identical elements
    ///      positionally so the consumer can zip each back to its heldTokenId.
    function testLoansBatch_DualRoleDuplicatePreserved() public {
        _seedLoan(9, u1, u1, LibVaipakam.LoanStatus.Active); // same wallet both sides
        uint256[] memory ids = new uint256[](2);
        ids[0] = 9; ids[1] = 9;
        LibMetricsTypes.LoanView[] memory v = dash.getLoansBatch(ids);
        assertEq(v.length, 2, "no dedupe");
        assertEq(v[0].loan.id, 9, "e0");
        assertEq(v[1].loan.id, 9, "e1 duplicate");
        assertEq(v[0].loan.lenderTokenId, v[1].loan.lenderTokenId, "identical");
        assertEq(v[0].loan.borrowerTokenId, v[1].loan.borrowerTokenId, "identical");
    }

    function testLoansBatch_Empty() public view {
        uint256[] memory ids = new uint256[](0);
        LibMetricsTypes.LoanView[] memory v = dash.getLoansBatch(ids);
        assertEq(v.length, 0, "empty");
    }

    // ─── batch cap ───────────────────────────────────────────────────────────

    function testBatchCap_OverLimitReverts() public {
        uint256 max = dash.MAX_BATCH_IDS();
        uint256[] memory tooMany = new uint256[](max + 1);
        vm.expectRevert(
            abi.encodeWithSelector(MetricsDashboardFacet.BatchTooLarge.selector, max + 1, max)
        );
        dash.getOffersWithState(tooMany);

        vm.expectRevert(
            abi.encodeWithSelector(MetricsDashboardFacet.BatchTooLarge.selector, max + 1, max)
        );
        dash.getLoansBatch(tooMany);
    }

    /// @dev Boundary: exactly MAX_BATCH_IDS succeeds (all never-existed → zero
    ///      elements), also exercising the viaIR array-coder at full width.
    function testBatchCap_ExactLimitSucceeds() public view {
        uint256 max = dash.MAX_BATCH_IDS();
        uint256[] memory ids = new uint256[](max);
        for (uint256 i = 0; i < max; i++) ids[i] = 900000 + i; // all never-existed
        LibMetricsTypes.OfferView[] memory ov = dash.getOffersWithState(ids);
        assertEq(ov.length, max, "offers full width");
        LibMetricsTypes.LoanView[] memory lv = dash.getLoansBatch(ids);
        assertEq(lv.length, max, "loans full width");
    }
}
