// test/RefinanceFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibEncumbrance} from "../src/libraries/LibEncumbrance.sol";
import {LibRefinanceNetting} from "../src/libraries/LibRefinanceNetting.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Drives {LibRefinanceNetting} directly. Each case runs inside ONE call,
///      because the record is transient: it is meant to live for one
///      transaction, and forge ≥ 1.8 gives each top-level test call its own.
contract RefinanceNettingHarness {
    LibVaipakam.Offer internal offer;

    function isRefinanceAccept(LibVaipakam.OfferType offerType, uint256 target)
        external
        returns (bool)
    {
        offer.offerType = offerType;
        offer.refinanceTargetLoanId = target;
        return LibRefinanceNetting.isRefinanceAccept(offer);
    }

    function parkThenTake(
        uint256 offerId,
        address lender,
        address asset,
        uint256 amount,
        address takeLender,
        address takeAsset
    ) external returns (uint256) {
        LibRefinanceNetting.park(offerId, lender, asset, amount);
        return LibRefinanceNetting.take(offerId, takeLender, takeAsset);
    }

    function takeTwice(uint256 offerId, address lender, address asset, uint256 amount)
        external
    {
        LibRefinanceNetting.park(offerId, lender, asset, amount);
        LibRefinanceNetting.take(offerId, lender, asset);
        LibRefinanceNetting.take(offerId, lender, asset);
    }

    function parkTwice(uint256 offerId, address lender, address asset, uint256 amount)
        external
    {
        LibRefinanceNetting.park(offerId, lender, asset, amount);
        LibRefinanceNetting.park(offerId, lender, asset, amount);
    }

    function parkTwoOffers(address lender, address asset) external returns (uint256, uint256) {
        LibRefinanceNetting.park(1, lender, asset, 11);
        LibRefinanceNetting.park(2, lender, asset, 22);
        return (
            LibRefinanceNetting.take(2, lender, asset),
            LibRefinanceNetting.take(1, lender, asset)
        );
    }

    function take(uint256 offerId, address lender, address asset) external returns (uint256) {
        return LibRefinanceNetting.take(offerId, lender, asset);
    }

    /// @dev The owner total and the free balance it hides, read while two
    ///      records are parked, after one take, and after both.
    function parkedAndFree(address lender, address asset, uint256 raw)
        external
        returns (uint256[6] memory r)
    {
        LibRefinanceNetting.park(1, lender, asset, 11);
        LibRefinanceNetting.park(2, lender, asset, 22);
        r[0] = LibRefinanceNetting.parkedOf(lender, asset);
        r[1] = LibEncumbrance.freeBalance(lender, asset, 0, raw);
        LibRefinanceNetting.take(1, lender, asset);
        r[2] = LibRefinanceNetting.parkedOf(lender, asset);
        r[3] = LibEncumbrance.freeBalance(lender, asset, 0, raw);
        LibRefinanceNetting.take(2, lender, asset);
        r[4] = LibRefinanceNetting.parkedOf(lender, asset);
        r[5] = LibEncumbrance.freeBalance(lender, asset, 0, raw);
    }
}

/**
 * @title  RefinanceFacetTest
 * @notice The refinance flow (#3042): a lender accepts — or the matcher fills —
 *         the borrower's refinance-tagged offer, and in that one transaction
 *         the new lender's net principal pays the old lender inside the
 *         Diamond, the borrower's wallet pays only the difference (the old
 *         loan's interest and the new loan's initiation fee), and the old loan
 *         closes as Repaid. Every amount here is measured on real balances:
 *         no vault call is mocked and the Diamond is never pre-funded, so a
 *         leg paid from the wrong place shows up as a wrong balance.
 */
contract RefinanceFacetTest is SetupTest {
    uint256 internal constant P = 100 ether;
    uint256 internal constant COLLATERAL = 1800 ether;
    uint256 internal constant OLD_RATE_BPS = 500;
    uint256 internal constant NEW_RATE_BPS = 400;
    /// @dev The fee constants the fixture loan is born under (#1352 freeze):
    ///      2% treasury cut on interest, 0.2% initiation fee, of which the
    ///      matcher (on a direct accept, the accepting lender) takes 1%.
    uint256 internal constant TREASURY_FEE_BPS = 200;
    uint256 internal constant LIF_BPS = 20;
    uint256 internal constant MATCHER_BPS = 100;

    address internal newLender;
    uint256 internal newLenderPk;
    uint256 internal oldLoanId;
    uint256 internal taggedOfferId;

    function setUp() public {
        setupHelper();
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);

        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.prank(lender);
        ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(borrowerVault, type(uint256).max);

        vm.prank(lender);
        uint256 lenderOfferId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, OLD_RATE_BPS, COLLATERAL, 0)
        );
        oldLoanId = _signAndAcceptOffer(borrower, borrowerPk, lenderOfferId);

        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            oldLoanId, true, 600, uint64(block.timestamp + 365 days)
        );
        vm.prank(borrower);
        taggedOfferId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, NEW_RATE_BPS, COLLATERAL, oldLoanId)
        );

        // The accept pulls the new lender's principal from their WALLET into
        // their vault, so the new lender holds exactly P there and nothing in
        // the vault beforehand — the netting then has nothing to hide behind.
        (newLender, newLenderPk) = makeAddrAndKey("refiNewLender");
        ERC20Mock(mockERC20).mint(newLender, P);
        vm.prank(newLender);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── Fixture helpers ──────────────────────────────────────────────

    function _params(
        LibVaipakam.OfferType offerType,
        uint256 rateBps,
        uint256 collateral,
        uint256 target
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: offerType,
            lendingAsset: mockERC20,
            amount: P,
            interestRateBps: rateBps,
            collateralAsset: mockCollateralERC20,
            collateralAmount: collateral,
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
            amountMax: P,
            interestRateBpsMax: rateBps,
            collateralAmountMax: collateral,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            // A refinance request is all-or-nothing; a plain lender offer here
            // is partial-fillable so the matcher can fill it.
            fillMode: target != 0 ? LibVaipakam.FillMode.Aon : LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: target,
            useFullTermInterest: false
        });
    }

    function _vault(address user) internal returns (address) {
        return VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user);
    }

    function _bal(address who) internal view returns (uint256) {
        return ERC20(mockERC20).balanceOf(who);
    }

    function _treasury() internal view returns (uint256) {
        return TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
    }

    function _accept() internal returns (uint256) {
        return _signAndAcceptOffer(newLender, newLenderPk, taggedOfferId);
    }

    /// @dev The old lender's settlement for an opt-out (pro-rata) loan after
    ///      `elapsed`, within term: interest accrued, its treasury cut, and
    ///      what the old lender is owed.
    function _expectedSettlement(uint256 elapsed)
        internal
        pure
        returns (uint256 interest, uint256 treasuryFee, uint256 lenderDue)
    {
        interest = (P * OLD_RATE_BPS * elapsed) / (10_000 * 365 days);
        treasuryFee = (interest * TREASURY_FEE_BPS) / 10_000;
        lenderDue = P + interest - treasuryFee;
    }

    /// @dev Reads the one `RefinancePayoffSettled` the recorded logs carry.
    function _payoffLegs(Vm.Log[] memory logs)
        internal
        pure
        returns (uint256 newLenderToOldLender, uint256 borrowerToOldLender, uint256 borrowerToTreasury)
    {
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != RefinanceFacet.RefinancePayoffSettled.selector) continue;
            require(!found, "one payoff event per refinance");
            found = true;
            (newLenderToOldLender, borrowerToOldLender, borrowerToTreasury) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
        }
        require(found, "RefinancePayoffSettled not emitted");
    }

    // ─── The netted payoff ────────────────────────────────────────────

    /// @notice The new lender's net principal goes straight to the old lender's
    ///         vault; the borrower's wallet pays exactly the old loan's interest
    ///         plus the new loan's initiation fee, and nothing else moves.
    function test_NetPrincipalPaysOldLender_BorrowerPaysOnlyTheDifference() public {
        vm.warp(block.timestamp + 15 days);
        (uint256 interest, uint256 treasuryFee, uint256 lenderDue) = _expectedSettlement(15 days);
        uint256 lif = (P * LIF_BPS) / 10_000;
        uint256 matcherCut = (lif * MATCHER_BPS) / 10_000;
        uint256 net = P - lif;

        uint256 oldLenderVaultBefore = _bal(_vault(lender));
        uint256 newLenderVaultBefore = _bal(_vault(newLender));
        uint256 newLenderWalletBefore = _bal(newLender);
        uint256 borrowerWalletBefore = _bal(borrower);
        uint256 diamondBefore = _bal(address(diamond));
        uint256 treasuryBefore = _treasury();

        vm.recordLogs();
        uint256 newLoanId = _accept();
        (uint256 a, uint256 b, uint256 d) = _payoffLegs(vm.getRecordedLogs());

        assertEq(a, net, "leg: the whole net principal goes to the old lender");
        assertEq(b, lenderDue - net, "leg: the borrower tops up the old lender's due");
        assertEq(d, treasuryFee, "leg: the borrower pays the treasury fee");

        assertEq(_bal(_vault(lender)) - oldLenderVaultBefore, lenderDue, "old lender's vault receives exactly the due");
        // The principal passes through the new lender's vault: in from their
        // wallet, out as LIF + net principal, nothing left behind.
        assertEq(_bal(_vault(newLender)), newLenderVaultBefore, "new lender's vault holds nothing afterwards");
        assertEq(
            newLenderWalletBefore - _bal(newLender),
            P - matcherCut,
            "new lender's wallet funds the principal and takes back the matcher share"
        );
        assertEq(
            borrowerWalletBefore - _bal(borrower),
            interest + lif,
            "borrower pays only the old interest and the initiation fee"
        );
        assertEq(
            _treasury() - treasuryBefore,
            treasuryFee + lif - matcherCut,
            "treasury accrues the interest cut and its share of the initiation fee"
        );
        // Treasury is the Diamond in this fixture: the Diamond's balance moves
        // by the treasury's accrual and nothing else, so no leg left funds
        // sitting in the Diamond.
        assertEq(_bal(address(diamond)) - diamondBefore, _treasury() - treasuryBefore, "no Diamond-held residue");

        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "old loan Repaid in the same transaction"
        );
        LibVaipakam.Loan memory newLoan = LoanFacet(address(diamond)).getLoanDetails(newLoanId);
        assertEq(uint8(newLoan.status), uint8(LibVaipakam.LoanStatus.Active), "new loan Active");
        assertEq(newLoan.principal, P, "new loan owes the whole principal");
        assertEq(newLoan.lender, newLender, "new loan funded by the accepting lender");
        (, uint256 claim, ) = ClaimFacet(address(diamond)).getClaimableAmount(oldLoanId, true);
        assertEq(claim, lenderDue, "old lender's claim is the due");
    }

    /// @notice The borrower's approval needs to cover only the difference: an
    ///         allowance of exactly the old interest plus the initiation fee
    ///         completes the refinance, and one wei less refuses the whole
    ///         accept, leaving both loans and every balance untouched.
    function test_BorrowerApprovalCoversOnlyTheDifference() public {
        vm.warp(block.timestamp + 15 days);
        (uint256 interest, , ) = _expectedSettlement(15 days);
        uint256 difference = interest + (P * LIF_BPS) / 10_000;

        vm.prank(borrower);
        ERC20(mockERC20).approve(address(diamond), difference - 1);
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(
            address(diamond), newLender, taggedOfferId, true, 0
        );
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, newLenderPk);
        uint256 newLenderVaultBefore = _bal(_vault(newLender));
        vm.prank(newLender);
        vm.expectRevert();
        OfferAcceptFacet(address(diamond)).acceptOffer(taggedOfferId, t, sig);
        assertEq(_bal(_vault(newLender)), newLenderVaultBefore, "a refused refinance moves nothing");
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "old loan still Active after the refused accept"
        );

        vm.prank(borrower);
        ERC20(mockERC20).approve(address(diamond), difference);
        _accept();
        assertEq(ERC20(mockERC20).allowance(borrower, address(diamond)), 0, "the difference used the approval exactly");
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "old loan Repaid"
        );
    }

    /// @notice The old lender claims their due out of their vault afterwards.
    function test_OldLenderClaimsTheDue() public {
        vm.warp(block.timestamp + 15 days);
        (, , uint256 lenderDue) = _expectedSettlement(15 days);
        _accept();
        uint256 walletBefore = _bal(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(oldLoanId);
        assertEq(_bal(lender) - walletBefore, lenderDue, "old lender claims exactly the due");
    }

    /// @notice A refinance in the grace window completes, and the late fee it
    ///         charges reaches the old lender through the same legs: their
    ///         vault receives the whole recorded claim and the borrower pays
    ///         the rest of it beyond the net principal.
    function test_GraceWindow_CompletesAndPaysTheLateFee() public {
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(oldLoanId);
        vm.warp(uint256(l.startTime) + uint256(l.durationDays) * 1 days + 3 days);
        uint256 net = P - (P * LIF_BPS) / 10_000;
        uint256 oldLenderVaultBefore = _bal(_vault(lender));

        vm.recordLogs();
        _accept();
        (uint256 a, uint256 b, ) = _payoffLegs(vm.getRecordedLogs());

        (, uint256 claim, ) = ClaimFacet(address(diamond)).getClaimableAmount(oldLoanId, true);
        (, , uint256 inTermDue) = _expectedSettlement(30 days);
        assertGt(claim, inTermDue, "the grace late fee is part of the due");
        assertEq(_bal(_vault(lender)) - oldLenderVaultBefore, claim, "old lender's vault receives the whole due");
        assertEq(a, net, "net principal to the old lender");
        assertEq(b, claim - net, "borrower pays the rest of the due, late fee included");
    }

    // ─── Collateral ───────────────────────────────────────────────────

    /// @notice A carry-over refinance keeps the collateral under one lien.
    function test_CarryOver_CollateralStaysLockedOnce() public {
        _accept();
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(borrower, mockCollateralERC20, 0),
            COLLATERAL,
            "one lien, carried over"
        );
    }

    /// @notice A request that pledges fresh collateral returns the old
    ///         collateral to the borrower, and the payoff nets the same way.
    function test_FreshPledge_ReturnsOldCollateral() public {
        uint256 fresh = COLLATERAL + 1 ether;
        // The fixture's request is the loan's recorded one; this test needs a
        // fresh-pledge request instead, so cancel the fixture's first (after
        // the protocol-wide cancel cooldown).
        vm.warp(block.timestamp + 5 minutes + 1);
        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(taggedOfferId);
        vm.prank(borrower);
        taggedOfferId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, NEW_RATE_BPS, fresh, oldLoanId)
        );
        assertFalse(
            OfferCancelFacet(address(diamond)).getOfferDetails(taggedOfferId).refinanceCarryOver,
            "fresh-pledge request"
        );
        uint256 walletBefore = ERC20(mockCollateralERC20).balanceOf(borrower);
        uint256 oldLenderVaultBefore = _bal(_vault(lender));

        _accept();

        assertEq(
            ERC20(mockCollateralERC20).balanceOf(borrower) - walletBefore,
            COLLATERAL,
            "old collateral returned to the borrower"
        );
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(borrower, mockCollateralERC20, 0),
            fresh,
            "only the fresh pledge stays locked"
        );
        (, uint256 claim, ) = ClaimFacet(address(diamond)).getClaimableAmount(oldLoanId, true);
        assertEq(_bal(_vault(lender)) - oldLenderVaultBefore, claim, "old lender paid the due");
    }

    // ─── Sanctions: the old lender is closed out, never bricks the refinance ──

    /// @notice A flagged old lender's proceeds are parked in their existing
    ///         vault and the frozen-claimant marker is recorded; the borrower's
    ///         refinance completes.
    function test_FlaggedOldLender_ParksNotBricks_RecordsMarker() public {
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        // Resolve the old lender's vault BEFORE flagging: creating or
        // resolving a vault for a flagged address is itself refused.
        address oldLenderVault = _vault(lender);
        uint256 oldLenderVaultBefore = _bal(oldLenderVault);
        m.setFlagged(lender, true);

        _accept();

        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "refinance completed for a flagged old lender"
        );
        (, uint256 claim, ) = ClaimFacet(address(diamond)).getClaimableAmount(oldLoanId, true);
        assertEq(_bal(oldLenderVault) - oldLenderVaultBefore, claim, "proceeds parked in the old lender's vault");
        assertEq(
            TestMutatorFacet(address(diamond)).getSanctionsFrozenClaimant(oldLoanId, true),
            lender,
            "frozen old-lender claimant recorded"
        );
        assertTrue(
            ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(lender),
            "flagged holder registered"
        );
    }

    /// @notice A clean old lender records no marker.
    function test_CleanOldLender_RecordsNoMarker() public {
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        _accept();
        assertEq(
            TestMutatorFacet(address(diamond)).getSanctionsFrozenClaimant(oldLoanId, true),
            address(0),
            "no marker for a clean old lender"
        );
        assertFalse(ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(lender), "not registered");
    }

    // ─── The matcher route nets the same way ──────────────────────────

    /// @notice A matched fill pays the old lender from the standing lender
    ///         offer's funded principal; the borrower pays only the
    ///         difference and the matcher takes its initiation-fee share.
    function test_MatchedFill_NetsThePayoff() public {
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        AdminFacet(address(diamond)).setAutoRefinanceEnabled(true);
        vm.warp(block.timestamp + 15 days);
        (uint256 interest, , uint256 lenderDue) = _expectedSettlement(15 days);
        uint256 lif = (P * LIF_BPS) / 10_000;

        address standing = _provisionFundedActor("refiStandingLender", mockERC20, P);
        vm.prank(standing);
        ERC20(mockERC20).approve(_vault(standing), type(uint256).max);
        vm.prank(standing);
        uint256 lenderOfferId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, NEW_RATE_BPS, COLLATERAL, 0)
        );

        uint256 oldLenderVaultBefore = _bal(_vault(lender));
        uint256 borrowerWalletBefore = _bal(borrower);
        uint256 matcherBefore = _bal(address(this));

        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, taggedOfferId);

        assertEq(_bal(_vault(lender)) - oldLenderVaultBefore, lenderDue, "old lender paid the due");
        assertEq(borrowerWalletBefore - _bal(borrower), interest + lif, "borrower pays only the difference");
        assertEq(_bal(address(this)) - matcherBefore, (lif * MATCHER_BPS) / 10_000, "matcher share");
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "old loan Repaid by the fill"
        );
    }

    // ─── Risk gates on the replacement ────────────────────────────────

    /// @notice Tiering off: a replacement whose health factor is under the
    ///         1.5 floor refuses the whole accept.
    function test_TieredOff_RefusesHFBelowFloor() public {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(14e17))
        );
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(
            address(diamond), newLender, taggedOfferId, true, 0
        );
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, newLenderPk);
        vm.prank(newLender);
        vm.expectRevert(IVaipakamErrors.HealthFactorTooLow.selector);
        OfferAcceptFacet(address(diamond)).acceptOffer(taggedOfferId, t, sig);
        vm.clearMockedCalls();
    }

    /// @notice Tiering on: the floor relaxes to 1.0, so a 1.2 health factor
    ///         completes, and 0.9 still refuses.
    function test_TieredOn_HFFloorRelaxedToOne() public {
        TestMutatorFacet(address(diamond)).setDepthTieredLtvEnabledRaw(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getEffectiveLiquidityTier.selector, mockCollateralERC20),
            abi.encode(uint8(3))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(5000))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(9e17))
        );
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(
            address(diamond), newLender, taggedOfferId, true, 0
        );
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, newLenderPk);
        vm.prank(newLender);
        vm.expectRevert(IVaipakamErrors.HealthFactorTooLow.selector);
        OfferAcceptFacet(address(diamond)).acceptOffer(taggedOfferId, t, sig);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(12e17))
        );
        _accept();
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "relaxed floor admits HF 1.2"
        );
        vm.clearMockedCalls();
    }

    // ─── Entry points ─────────────────────────────────────────────────

    /// @notice Both completions are reachable only from inside the Diamond.
    function test_EntriesRefuseExternalCallers() public {
        vm.expectRevert(RefinanceFacet.OnlyDiamondInternal.selector);
        RefinanceFacet(address(diamond)).refinanceLoanFromAccept(oldLoanId, taggedOfferId);
        vm.expectRevert(RefinanceFacet.OnlyDiamondInternal.selector);
        RefinanceFacet(address(diamond)).refinanceLoanFromMatch(oldLoanId, taggedOfferId);
    }

    /// @notice The standalone completion is gone: nothing routes its selector.
    function test_StandaloneCompletionIsRetired() public {
        (bool ok, bytes memory ret) = address(diamond).call(
            abi.encodeWithSignature("refinanceLoan(uint256,uint256)", oldLoanId, taggedOfferId)
        );
        assertFalse(ok, "retired selector must not route");
        assertEq(bytes4(ret), bytes4(keccak256("FunctionDoesNotExist()")), "unrouted");
    }

    /// @notice An untagged Borrower offer is an ordinary new loan: accepting it
    ///         delivers the net principal to the borrower and leaves the old
    ///         loan alone.
    function test_UntaggedBorrowerOffer_IsAnOrdinaryLoan() public {
        vm.prank(borrower);
        uint256 plain = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, NEW_RATE_BPS, COLLATERAL, 0)
        );
        uint256 walletBefore = _bal(borrower);
        _signAndAcceptOffer(newLender, newLenderPk, plain);
        assertEq(_bal(borrower) - walletBefore, P - (P * LIF_BPS) / 10_000, "net principal delivered");
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "old loan untouched"
        );
    }

    // ─── LibRefinanceNetting ──────────────────────────────────────────

    function test_Netting_PredicateIsTaggedBorrowerOffer() public {
        RefinanceNettingHarness h = new RefinanceNettingHarness();
        assertTrue(h.isRefinanceAccept(LibVaipakam.OfferType.Borrower, 7), "tagged borrower offer");
        assertFalse(h.isRefinanceAccept(LibVaipakam.OfferType.Lender, 7), "tagged lender offer");
        assertFalse(h.isRefinanceAccept(LibVaipakam.OfferType.Borrower, 0), "untagged borrower offer");
    }

    function test_Netting_TakeReturnsWhatWasParked() public {
        RefinanceNettingHarness h = new RefinanceNettingHarness();
        address a = makeAddr("nettingLender");
        address t = makeAddr("nettingAsset");
        assertEq(h.parkThenTake(5, a, t, 42, a, t), 42, "parked amount");
        (uint256 two, uint256 one) = h.parkTwoOffers(a, t);
        assertEq(two, 22, "records are per offer");
        assertEq(one, 11, "records are per offer");
    }

    /// @dev The parked net is promised to the old lender, so every free-balance
    ///      read (the withdraw guard, the Full tariff's) treats it as held until
    ///      the payoff takes it. Without this, a VPFI-principal refinance whose
    ///      new lender opted into Full could pay `C*` out of the parked net and
    ///      leave the payoff short.
    function test_Netting_ParkedAmountIsNotFree() public {
        RefinanceNettingHarness h = new RefinanceNettingHarness();
        address a = makeAddr("nettingLender");
        address t = makeAddr("nettingAsset");
        uint256[6] memory r = h.parkedAndFree(a, t, 100);
        assertEq(r[0], 33, "both parks counted");
        assertEq(r[1], 67, "parked amount hidden from free balance");
        assertEq(r[2], 22, "a take releases only its own record");
        assertEq(r[3], 78, "free balance recovers by the amount taken");
        assertEq(r[4], 0, "nothing parked after both takes");
        assertEq(r[5], 100, "free balance whole again");
        assertEq(h.parkedAndFree(a, t, 20)[1], 0, "free balance floors at zero");
    }

    function test_Netting_RefusesMissingOrMismatchedRecord() public {
        RefinanceNettingHarness h = new RefinanceNettingHarness();
        address a = makeAddr("nettingLender");
        address t = makeAddr("nettingAsset");
        address other = makeAddr("nettingOther");
        vm.expectRevert(abi.encodeWithSelector(LibRefinanceNetting.RefinanceNetPrincipalMissing.selector, 5));
        h.take(5, a, t);
        vm.expectRevert(abi.encodeWithSelector(LibRefinanceNetting.RefinanceNetPrincipalMissing.selector, 5));
        h.parkThenTake(5, a, t, 42, other, t);
        vm.expectRevert(abi.encodeWithSelector(LibRefinanceNetting.RefinanceNetPrincipalMissing.selector, 5));
        h.parkThenTake(5, a, t, 42, a, other);
        vm.expectRevert(abi.encodeWithSelector(LibRefinanceNetting.RefinanceNetPrincipalMissing.selector, 5));
        h.takeTwice(5, a, t, 42);
        vm.expectRevert(abi.encodeWithSelector(LibRefinanceNetting.RefinanceNetPrincipalAlreadyParked.selector, 5));
        h.parkTwice(5, a, t, 42);
    }
}
