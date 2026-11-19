// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {MarketLedgerFacet} from "../src/facets/MarketLedgerFacet.sol";
import {InstantMarketFacet} from "../src/facets/InstantMarketFacet.sol";
import {InstantFillFacet} from "../src/facets/InstantFillFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestCalmPair} from "./helpers/LibTestCalmPair.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  InstantMarketBase
 * @notice Instant market (#3656) — shared fixture: two Auto-lend lenders with
 *         slots on the (mockERC20, mockCollateralERC20) pair, both assets
 *         treated as blue-chip, and a borrower with funds approved.
 */
abstract contract InstantMarketBase is SetupTest {
    address internal lender2;
    address internal taker;

    uint16 internal constant MAX_INIT_LTV_BPS = 5000;
    uint32 internal constant TERM = 30;
    uint256 internal constant MIN_FILL = 100 ether;

    function setUp() public {
        setupHelper();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
        vm.prank(owner);
        InstantMarketFacet(address(diamond)).setInstantMarketEnabled(true);
        // Both pair assets read as liquidity tier 3 (blue-chip).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSignature("getEffectiveLiquidityTier(address)", mockERC20),
            abi.encode(uint8(3))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSignature("getEffectiveLiquidityTier(address)", mockCollateralERC20),
            abi.encode(uint8(3))
        );
        lender2 = _newParty("instantLender2");
        taker = _newParty("instantTaker");
    }

    function _newParty(string memory name) internal returns (address a) {
        a = makeAddr(name);
        ERC20Mock(mockERC20).mint(a, 1_000_000 ether);
        ERC20Mock(mockCollateralERC20).mint(a, 1_000_000 ether);
        vm.prank(a);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(a);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(a);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(a, LibVaipakam.KYCTier.Tier2);
    }

    /// @dev A funded slot 0 with the instant-market consents on.
    function _slot(address who, uint256 rateBps, uint256 maxExposure, bool consent) internal {
        vm.prank(who);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, maxExposure, rateBps, MAX_INIT_LTV_BPS,
            TERM, MIN_FILL, false, 0, true, true, LibVaipakam.IntentRateTerms(0, 0, false), type(uint64).max
        );
        ERC20Mock(mockERC20).mint(who, maxExposure);
        vm.prank(who);
        ERC20(mockERC20).approve(address(diamond), maxExposure);
        vm.prank(who);
        LenderIntentFacet(address(diamond)).fundLenderIntent(mockERC20, mockCollateralERC20, 0, maxExposure);
        if (consent) {
            vm.prank(who);
            InstantMarketFacet(address(diamond)).setInstantSlot(
                mockERC20, mockCollateralERC20, 0, true, true, true, true, type(uint64).max
            );
        }
    }

    /// @dev Age the slots past the intent delay, then write the hourly price
    ///      checkpoints a slot fill's calm-price check reads.
    function _age() internal {
        vm.warp(vm.getBlockTimestamp() + 1 days);
        LibTestCalmPair.checkpoint(address(diamond), mockERC20, mockCollateralERC20);
    }

    function _src(address who) internal pure returns (InstantFillFacet.InstantSource memory) {
        return InstantFillFacet.InstantSource({kind: 0, owner: who, slot: 0, offerId: 0});
    }

    function _offerSrc(uint256 offerId) internal pure returns (InstantFillFacet.InstantSource memory) {
        return InstantFillFacet.InstantSource({kind: 1, owner: address(0), slot: 0, offerId: offerId});
    }

    function _req(uint256 amount, uint256 coll, uint256 maxRate, uint256 least)
        internal
        view
        returns (InstantMarketFacet.InstantBorrowRequest memory)
    {
        return InstantMarketFacet.InstantBorrowRequest({
            lendingAsset: mockERC20,
            collateralAsset: mockCollateralERC20,
            amountWanted: amount,
            collateralOffered: coll,
            kind: 0,
            termDays: TERM,
            maxRateBps: maxRate,
            allowsPartialRepay: false,
            minTotal: least,
            validUntil: uint64(vm.getBlockTimestamp() + 1 hours),
            riskAndTermsConsent: true,
            rateFarFromAverageAcknowledged: false
        });
    }

    function _borrow(
        InstantMarketFacet.InstantBorrowRequest memory req,
        InstantFillFacet.InstantSource[] memory srcs
    ) internal returns (uint256 groupId, InstantMarketFacet.InstantFill[] memory fills) {
        vm.prank(taker);
        return InstantMarketFacet(address(diamond)).borrowInstant(req, srcs);
    }

    function _loan(uint256 loanId) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId);
    }

    function _vaultBal(address who, address asset) internal view returns (uint256) {
        address v = VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
        return ERC20(asset).balanceOf(v);
    }
}

/// @notice The instant borrow (design §4, tests §12.1–2, §12.7).
contract InstantMarketTest is InstantMarketBase {
    /// @dev Two slots, cheapest first: each fill is its own loan at its slot's
    ///      own minimum rate, collateral split in proportion to principal, the
    ///      loans share a group, and the ledger counts them as instant and
    ///      slot-lent.
    function test_fillsSlotsInOrderAtEachSlotsRate() public {
        _slot(lender, 500, 1000 ether, true);
        _slot(lender2, 600, 1000 ether, true);
        _age();
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](2);
        srcs[0] = _src(lender);
        srcs[1] = _src(lender2);
        (uint256 groupId, InstantMarketFacet.InstantFill[] memory fills) =
            _borrow(_req(1500 ether, 3000 ether, 700, 1500 ether), srcs);

        assertEq(fills.length, 2, "two loans");
        assertEq(fills[0].amount, 1000 ether, "first slot fully");
        assertEq(fills[0].rateBps, 500, "first slot's own rate");
        assertEq(fills[0].collateral, 2000 ether, "collateral pro rata");
        assertEq(fills[1].amount, 500 ether, "second slot the rest");
        assertEq(fills[1].rateBps, 600, "second slot's own rate");
        assertEq(fills[1].collateral, 1000 ether, "last fill takes the remainder");

        LibVaipakam.Loan memory l0 = _loan(fills[0].loanId);
        LibVaipakam.Loan memory l1 = _loan(fills[1].loanId);
        assertEq(l0.lender, lender);
        assertEq(l1.lender, lender2);
        assertEq(l0.borrower, taker);
        assertEq(l0.interestRateBps, 500);
        assertEq(l1.interestRateBps, 600);
        assertFalse(l0.useFullTermInterest, "interest by time");
        assertEq(l0.matcher, address(0), "no matcher");

        assertEq(InstantMarketFacet(address(diamond)).getInstantGroup(fills[0].loanId), groupId);
        assertEq(InstantMarketFacet(address(diamond)).getInstantGroup(fills[1].loanId), groupId);

        (, , uint256 lent, uint256 fromSlots, uint256 instant) =
            MarketLedgerFacet(address(diamond)).getPairLedger(mockERC20, mockCollateralERC20);
        assertEq(lent, 1500 ether, "lent");
        assertEq(fromSlots, 1500 ether, "from slots");
        assertEq(instant, 1500 ether, "instant");
    }

    /// @dev No match share is paid: the borrower's vault receives exactly the
    ///      principal less the initiation fee.
    function test_borrowerIsNeverPaidAShare() public {
        _slot(lender, 500, 1000 ether, true);
        _age();
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](1);
        srcs[0] = _src(lender);
        uint256 before = _vaultBal(taker, mockERC20);
        _borrow(_req(1000 ether, 2000 ether, 700, 1000 ether), srcs);
        uint256 fee = (1000 ether * LibVaipakam.LOAN_INITIATION_FEE_BPS) / LibVaipakam.BASIS_POINTS;
        assertEq(_vaultBal(taker, mockERC20) - before, 1000 ether - fee, "net principal only");
    }

    /// @dev A slot without the consent, and one dearer than the limit, are
    ///      skipped and reported; the fill comes from the next source.
    function test_skipsUnfitSourcesAndReports() public {
        _slot(lender, 500, 1000 ether, false); // no instant consent
        _slot(lender2, 600, 1000 ether, true);
        address dear = _newParty("dearLender");
        _slot(dear, 900, 1000 ether, true);
        _age();
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](3);
        srcs[0] = _src(lender);
        srcs[1] = _src(dear);
        srcs[2] = _src(lender2);
        vm.recordLogs();
        (, InstantMarketFacet.InstantFill[] memory fills) =
            _borrow(_req(800 ether, 1600 ether, 700, 800 ether), srcs);
        assertEq(fills.length, 1);
        assertEq(fills[0].sourceIndex, 2);
        assertEq(_loan(fills[0].loanId).lender, lender2);
    }

    /// @dev The call reverts only when what was received is below the least.
    function test_revertsBelowLeast() public {
        _slot(lender, 500, 1000 ether, true);
        _age();
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](1);
        srcs[0] = _src(lender);
        InstantMarketFacet.InstantBorrowRequest memory req = _req(1500 ether, 3000 ether, 700, 1200 ether);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(InstantMarketFacet.InstantBelowLeast.selector, 1000 ether, 1200 ether)
        );
        InstantMarketFacet(address(diamond)).borrowInstant(req, srcs);
    }

    /// @dev Unused collateral is not taken: half filled, half the collateral
    ///      locked, and the wallet supplies only what the fill needed.
    function test_unusedCollateralNotTaken() public {
        _slot(lender, 500, 1000 ether, true);
        _age();
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](1);
        srcs[0] = _src(lender);
        uint256 walletBefore = ERC20(mockCollateralERC20).balanceOf(taker);
        (, InstantMarketFacet.InstantFill[] memory fills) =
            _borrow(_req(2000 ether, 4000 ether, 700, 1000 ether), srcs);
        assertEq(fills[0].amount, 1000 ether);
        assertEq(fills[0].collateral, 2000 ether, "share of the filled half");
        assertEq(walletBefore - ERC20(mockCollateralERC20).balanceOf(taker), 2000 ether, "wallet gave only that");
        assertEq(_loan(fills[0].loanId).collateralAmount, 2000 ether);
    }

    /// @dev A standing lender offer with interest by time is a source, at its
    ///      own rate; one owed for the full term is skipped.
    function test_offerSourceAtItsOwnRate() public {
        uint256 offerId = _lenderOffer(lender, 550, false);
        uint256 fullTerm = _lenderOffer(lender2, 450, true);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](2);
        srcs[0] = _offerSrc(fullTerm);
        srcs[1] = _offerSrc(offerId);
        (, InstantMarketFacet.InstantFill[] memory fills) =
            _borrow(_req(500 ether, 1000 ether, 700, 500 ether), srcs);
        assertEq(fills.length, 1);
        assertEq(fills[0].sourceIndex, 1, "full-term offer skipped");
        assertEq(fills[0].rateBps, 550);
        LibVaipakam.Loan memory l = _loan(fills[0].loanId);
        assertEq(l.lender, lender);
        assertEq(l.interestRateBps, 550);
        (, , , uint256 fromSlots, uint256 instant) =
            MarketLedgerFacet(address(diamond)).getPairLedger(mockERC20, mockCollateralERC20);
        assertEq(fromSlots, 0, "an offer is not a slot");
        assertEq(instant, 500 ether);
    }

    /// @dev With the master switch off every entry refuses.
    function test_masterSwitchOffRefuses() public {
        _slot(lender, 500, 1000 ether, true);
        vm.prank(owner);
        InstantMarketFacet(address(diamond)).setInstantMarketEnabled(false);
        _age();
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](1);
        srcs[0] = _src(lender);
        InstantMarketFacet.InstantBorrowRequest memory req = _req(500 ether, 1000 ether, 700, 1);
        vm.prank(taker);
        vm.expectRevert(InstantMarketFacet.InstantMarketDisabled.selector);
        InstantMarketFacet(address(diamond)).borrowInstant(req, srcs);
    }

    /// @dev The standing-intent fill switch stops instant fills from slots
    ///      too: with it off the slot source is skipped and nothing is lent.
    function test_intentSwitchOffSkipsSlots() public {
        _slot(lender, 500, 1000 ether, true);
        _age();
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(false);
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](1);
        srcs[0] = _src(lender);
        InstantMarketFacet.InstantBorrowRequest memory req = _req(500 ether, 1000 ether, 700, 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(InstantMarketFacet.InstantBelowLeast.selector, 0, 1));
        InstantMarketFacet(address(diamond)).borrowInstant(req, srcs);
    }

    /// @dev A pair asset that is not blue-chip is refused.
    function test_pairMustBeBlueChip() public {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSignature("getEffectiveLiquidityTier(address)", mockCollateralERC20),
            abi.encode(uint8(2))
        );
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, 1000 ether, 500, MAX_INIT_LTV_BPS,
            TERM, MIN_FILL, false, 0, true, true, LibVaipakam.IntentRateTerms(0, 0, false), type(uint64).max
        );
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                InstantMarketFacet.InstantPairNotEligible.selector, mockERC20, mockCollateralERC20
            )
        );
        InstantMarketFacet(address(diamond)).setInstantSlot(
            mockERC20, mockCollateralERC20, 0, true, false, false, true, type(uint64).max
        );
    }

    /// @dev The instant consent needs interest by time on the slot, and
    ///      setting the slot's terms again clears it.
    function test_consentNeedsProRataAndResetsWithTerms() public {
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, 1000 ether, 500, MAX_INIT_LTV_BPS,
            TERM, MIN_FILL, false, 0, false, true, LibVaipakam.IntentRateTerms(0, 0, false), type(uint64).max
        );
        vm.prank(lender);
        vm.expectRevert(InstantMarketFacet.InstantSlotNeedsProRata.selector);
        InstantMarketFacet(address(diamond)).setInstantSlot(
            mockERC20, mockCollateralERC20, 0, true, false, false, true, type(uint64).max
        );
        _slot(lender, 500, 1000 ether, true);
        assertTrue(InstantMarketFacet(address(diamond)).getInstantSlot(lender, mockERC20, mockCollateralERC20, 0).fills);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, 1000 ether, 400, MAX_INIT_LTV_BPS,
            TERM, MIN_FILL, false, 0, true, true, LibVaipakam.IntentRateTerms(0, 0, false), type(uint64).max
        );
        assertFalse(
            InstantMarketFacet(address(diamond)).getInstantSlot(lender, mockERC20, mockCollateralERC20, 0).fills,
            "new terms clear the consent"
        );
    }

    /// @dev A consent given this moment cannot be filled this moment (#3443).
    function test_freshConsentWaitsTheAge() public {
        _slot(lender, 500, 1000 ether, false);
        _age();
        vm.prank(lender);
        InstantMarketFacet(address(diamond)).setInstantSlot(
            mockERC20, mockCollateralERC20, 0, true, true, true, true, type(uint64).max
        );
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](1);
        srcs[0] = _src(lender);
        InstantMarketFacet.InstantBorrowRequest memory req = _req(500 ether, 1000 ether, 700, 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(InstantMarketFacet.InstantBelowLeast.selector, 0, 1));
        InstantMarketFacet(address(diamond)).borrowInstant(req, srcs);
    }

    /// @dev The fill entry is Diamond-internal.
    function test_fillIsDiamondInternal() public {
        InstantFillFacet.FillRequest memory r;
        vm.expectRevert(InstantFillFacet.OnlyDiamondInternal.selector);
        InstantFillFacet(address(diamond)).fillInstant(r);
    }

    function _lenderOffer(address who, uint256 rateBps, bool fullTerm) internal returns (uint256 offerId) {
        vm.prank(who);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 100 ether,
                interestRateBps: rateBps,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 2000 ether,
                durationDays: TERM,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000 ether,
                interestRateBpsMax: rateBps + 200,
                collateralAmountMax: 2000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: fullTerm,
                linkKind: 0,
                linkMarginBps: 0,
                rateFarFromAverageAcknowledged: false
            }),
            type(uint64).max
        );
    }
}
