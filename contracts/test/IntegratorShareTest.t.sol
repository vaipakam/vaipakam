// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibIntegrator} from "../src/libraries/LibIntegrator.sol";
import {IntegratorFacet} from "../src/facets/IntegratorFacet.sol";
import {FeeLevelsFacet} from "../src/facets/FeeLevelsFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/// @title IntegratorShareTest — #3682 / #3719 / #3720
/// @notice The integrator registry and the integrator's share of the loan
///         initiation fee. On a 10,000 loan for 30 days the fee is 20 (0.2%);
///         the treasury's floor is 10 (0.1%), and from the 10 above it the
///         matcher takes 1% (0.1) and the integrator its rate (10% = 1). The
///         treasury leg is the rest: 18.9 when the share is paid, 19.9 when
///         it is not (an unpaid share is the reserve's). The borrower's net
///         principal is 9,980 either way.
contract IntegratorShareTest is SetupTest {
    event IntegratorShareSettled(
        uint256 indexed offerId,
        address indexed integrator,
        address indexed asset,
        uint256 amount,
        bool delivered,
        LibIntegrator.Refusal refusal
    );

    uint256 internal constant PRINCIPAL = 10_000 ether;
    uint256 internal constant FEE = 20 ether;
    uint256 internal constant MATCHER = 0.1 ether;
    uint256 internal constant SHARE_10PCT = 1 ether;

    address internal treasury;
    address internal integ;
    address internal payout;
    IntegratorFacet internal reg;

    function setUp() public {
        setupHelper();
        treasury = makeAddr("integTreasury");
        LibTestVaultBeacon.setTreasury(address(diamond), treasury);
        integ = makeAddr("integrator");
        payout = makeAddr("integratorPayout");
        reg = IntegratorFacet(address(diamond));
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _register(address id, address pay, uint16 rate, string memory name) internal {
        reg.setIntegrator(id, pay, rate, name, new address[](0));
    }

    function _params(LibVaipakam.OfferType kind, address integrator)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            integrator: integrator,
            lifecycleFlex: 0,
            offerType: kind,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: PRINCIPAL * 2,
            durationDays: 30,
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
            amountMax: PRINCIPAL,
            interestRateBpsMax: 500,
            collateralAmountMax: PRINCIPAL * 2,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _lenderOffer() internal returns (uint256 offerId) {
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, address(0)), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
    }

    /// @dev The borrower accepts a lender's offer naming `integrator` in its
    ///      signed accept terms.
    function _acceptVia(uint256 offerId, address integrator) internal returns (uint256) {
        return LibAcceptTestSigner.signAndAcceptVia(address(diamond), borrower, borrowerPk, offerId, integrator);
    }

    function _vaultBal(address owner_) internal view returns (uint256) {
        address v = VaultFactoryFacet(address(diamond)).getUserVaultAddress(owner_);
        return v == address(0) ? 0 : IERC20(mockERC20).balanceOf(v);
    }

    function _treasuryBal() internal view returns (uint256) {
        return IERC20(mockERC20).balanceOf(treasury);
    }

    // ── Registry ─────────────────────────────────────────────────────────

    function test_register_listsTheEntry() public {
        _register(integ, payout, 0, "Acme Wallet");
        IntegratorFacet.IntegratorView[] memory list = reg.getIntegrators();
        assertEq(list.length, 1);
        assertEq(list[0].integrator, integ);
        assertEq(list[0].payout, payout);
        assertEq(list[0].name, "Acme Wallet");
        assertEq(uint8(list[0].status), uint8(LibVaipakam.IntegratorStatus.Active));
        assertEq(list[0].rateBps, 1000, "no rate = the 10% default");
        assertEq(reg.integratorOf(payout), integ, "the payout account belongs to it");
        (uint256 dflt, uint256 ceiling) = reg.getIntegratorShareSettings();
        assertEq(dflt, 1000);
        assertEq(ceiling, 6000);
    }

    function test_names_uniqueRegardlessOfCase() public {
        _register(integ, payout, 0, "Acme Wallet");
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(IntegratorFacet.IntegratorNameTaken.selector, integ));
        _register(other, makeAddr("otherPayout"), 0, "ACME wallet");
    }

    function test_names_refuseEmptyLongAndControlCharacters() public {
        vm.expectRevert(IntegratorFacet.IntegratorNameInvalid.selector);
        _register(integ, payout, 0, "");
        vm.expectRevert(IntegratorFacet.IntegratorNameInvalid.selector);
        _register(integ, payout, 0, "a-name-that-is-longer-than-32-chars");
        vm.expectRevert(IntegratorFacet.IntegratorNameInvalid.selector);
        _register(integ, payout, 0, "bad\nname");
    }

    function test_addresses_belongToOneIntegrator() public {
        _register(integ, payout, 0, "Acme");
        address other = makeAddr("other");
        vm.expectRevert(abi.encodeWithSelector(IntegratorFacet.IntegratorAddressTaken.selector, payout, integ));
        _register(other, payout, 0, "Other");
    }

    function test_rate_atMostHalf() public {
        vm.expectRevert(abi.encodeWithSelector(IntegratorFacet.IntegratorRateInvalid.selector, uint256(5001)));
        _register(integ, payout, 5001, "Acme");
        vm.expectRevert(abi.encodeWithSelector(IntegratorFacet.IntegratorRateInvalid.selector, uint256(5001)));
        reg.setIntegratorDefaultRate(5001);
    }

    function test_roles_adminAndPauser() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        reg.setIntegrator(integ, payout, 0, "Acme", new address[](0));

        _register(integ, payout, 0, "Acme");
        vm.prank(stranger);
        vm.expectRevert();
        reg.suspendIntegrator(integ);
        vm.prank(stranger);
        vm.expectRevert();
        reg.removeIntegrator(integ);
    }

    function test_suspendRestoreRemove() public {
        _register(integ, payout, 0, "Acme");
        reg.suspendIntegrator(integ);
        (uint256 rate, LibIntegrator.Refusal why) = reg.integratorRateFor(integ, borrower);
        assertEq(rate, 0);
        assertEq(uint8(why), uint8(LibIntegrator.Refusal.Suspended));
        // A change keeps a suspended entry suspended.
        _register(integ, payout, 2000, "Acme");
        assertEq(uint8(reg.getIntegrator(integ).status), uint8(LibVaipakam.IntegratorStatus.Suspended));
        reg.restoreIntegrator(integ);
        (rate, why) = reg.integratorRateFor(integ, borrower);
        assertEq(rate, 2000);
        assertEq(uint8(why), uint8(LibIntegrator.Refusal.None));
        vm.expectRevert(abi.encodeWithSelector(IntegratorFacet.IntegratorNotSuspended.selector, integ));
        reg.restoreIntegrator(integ);

        reg.removeIntegrator(integ);
        assertEq(reg.getIntegrators().length, 0);
        assertEq(reg.integratorOf(payout), address(0), "addresses freed");
        // The name is free again.
        _register(makeAddr("next"), makeAddr("nextPayout"), 0, "acme");
    }

    function test_platformContracts_namesTheDiamond() public view {
        (address d, address beacon,,) = reg.getPlatformContracts();
        assertEq(d, address(diamond));
        assertTrue(beacon != address(0), "the vault beacon is named");
    }

    function test_intentAttribution_needsAnActiveIntent() public {
        vm.prank(lender);
        vm.expectRevert(IntegratorFacet.LenderIntentNotActive.selector);
        reg.nameLenderIntentIntegrator(mockERC20, mockCollateralERC20, 0, integ);
    }

    function test_deliver_isDiamondOnly() public {
        vm.expectRevert();
        reg.deliverIntegratorShare(lender, mockERC20, 1, integ, 1);
    }

    // ── The share at acceptance ──────────────────────────────────────────

    function test_paid_intoThePayoutVault() public {
        _register(integ, payout, 0, "Acme");
        uint256 offerId = _lenderOffer();
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit IntegratorShareSettled(offerId, integ, mockERC20, SHARE_10PCT, true, LibIntegrator.Refusal.None);
        _acceptVia(offerId, integ);

        assertEq(_vaultBal(payout), SHARE_10PCT, "the share lands in the payout account's vault");
        assertEq(_treasuryBal() - t0, FEE - MATCHER - SHARE_10PCT, "treasury leg is the rest");
        assertEq(_vaultBal(borrower), PRINCIPAL - FEE, "the borrower's net principal is unchanged");
        assertEq(reg.getIntegrator(integ).loansBrought, 1, "the loan is counted");
    }

    function test_noIntegratorNamed_noEventAndAllToTreasuryLeg() public {
        uint256 offerId = _lenderOffer();
        uint256 t0 = _treasuryBal();
        _acceptVia(offerId, address(0));
        assertEq(_treasuryBal() - t0, FEE - MATCHER);
        assertEq(_vaultBal(borrower), PRINCIPAL - FEE);
    }

    function test_unregistered_shareToTheReserve() public {
        uint256 offerId = _lenderOffer();
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit IntegratorShareSettled(offerId, integ, mockERC20, 0, false, LibIntegrator.Refusal.NotRegistered);
        _acceptVia(offerId, integ);
        assertEq(_treasuryBal() - t0, FEE - MATCHER, "the unpaid share stays in the treasury leg");
        assertEq(_vaultBal(borrower), PRINCIPAL - FEE);
    }

    function test_suspended_shareToTheReserve() public {
        _register(integ, payout, 0, "Acme");
        reg.suspendIntegrator(integ);
        uint256 offerId = _lenderOffer();
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit IntegratorShareSettled(offerId, integ, mockERC20, 0, false, LibIntegrator.Refusal.Suspended);
        _acceptVia(offerId, integ);
        assertEq(_vaultBal(payout), 0);
        assertEq(_treasuryBal() - t0, FEE - MATCHER);
        assertEq(reg.getIntegrator(integ).loansBrought, 1, "a suspended entry's loans still count");
    }

    function test_borrowerIsDeclaredContract_paysNothing() public {
        address[] memory declared = new address[](1);
        declared[0] = borrower;
        reg.setIntegrator(integ, payout, 0, "Acme", declared);
        uint256 offerId = _lenderOffer();
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit IntegratorShareSettled(offerId, integ, mockERC20, 0, false, LibIntegrator.Refusal.BorrowerIsIntegrator);
        _acceptVia(offerId, integ);
        assertEq(_vaultBal(payout), 0);
        assertEq(_treasuryBal() - t0, FEE - MATCHER);
    }

    function test_failedDelivery_shareToTheReserve_loanStillOpens() public {
        _register(integ, payout, 0, "Acme");
        uint256 offerId = _lenderOffer();
        vm.mockCallRevert(
            address(diamond), abi.encodeWithSelector(IntegratorFacet.deliverIntegratorShare.selector), "no"
        );
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit IntegratorShareSettled(offerId, integ, mockERC20, SHARE_10PCT, false, LibIntegrator.Refusal.None);
        uint256 loanId = _acceptVia(offerId, integ);
        assertGt(loanId, 0);
        assertEq(_vaultBal(payout), 0);
        assertEq(_treasuryBal() - t0, FEE - MATCHER, "the undelivered share went to the reserve");
        assertEq(_vaultBal(borrower), PRINCIPAL - FEE);
    }

    function test_ceilingBindsTheIntegrator() public {
        _register(integ, payout, 5000, "Acme");
        FeeLevelsFacet(address(diamond)).setFeeShareCeiling(4000);
        uint256 offerId = _lenderOffer();
        uint256 t0 = _treasuryBal();
        // 40% of the 10 above the floor is 4; the matcher's 0.1 is filled
        // first, so the integrator's 5 is held to 3.9.
        uint256 cut = 4 ether - MATCHER;
        vm.expectEmit(true, true, true, true, address(diamond));
        emit IntegratorShareSettled(offerId, integ, mockERC20, cut, true, LibIntegrator.Refusal.None);
        _acceptVia(offerId, integ);
        assertEq(_vaultBal(payout), cut);
        assertEq(_treasuryBal() - t0, FEE - 4 ether);
    }

    function test_ceiling_bounds() public {
        FeeLevelsFacet levels = FeeLevelsFacet(address(diamond));
        vm.expectRevert();
        levels.setFeeShareCeiling(3999);
        vm.expectRevert();
        levels.setFeeShareCeiling(7001);
        levels.setFeeShareCeiling(7000);
        assertEq(levels.getFeeShareCeiling(), 7000);
        levels.setFeeShareCeiling(0);
        assertEq(levels.getFeeShareCeiling(), 6000, "0 restores the default");
    }

    function test_borrowerOffer_integratorPaidOnAccept() public {
        _register(integ, payout, 0, "Acme");
        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, integ), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit IntegratorShareSettled(offerId, integ, mockERC20, SHARE_10PCT, true, LibIntegrator.Refusal.None);
        // The lender accepts; any integrator it names is ignored.
        LibAcceptTestSigner.signAndAcceptVia(address(diamond), lender, lenderPk, offerId, makeAddr("lenderDoor"));
        assertEq(_vaultBal(payout), SHARE_10PCT);
        assertEq(_treasuryBal() - t0, FEE - SHARE_10PCT - _matcherOf(lender));
    }

    function test_lenderOffer_lenderNamedIntegratorIgnored() public {
        _register(integ, payout, 0, "Acme");
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, integ);
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
        uint256 t0 = _treasuryBal();
        _acceptVia(offerId, address(0));
        assertEq(_vaultBal(payout), 0, "a lender's offer earns no share");
        assertEq(_treasuryBal() - t0, FEE - MATCHER);
        assertEq(reg.getIntegrator(integ).loansBrought, 0);
    }

    /// @dev The matcher's 1% of the above-floor part (the accepting caller is
    ///      the matcher on a direct accept).
    function _matcherOf(address) internal pure returns (uint256) {
        return MATCHER;
    }
}
