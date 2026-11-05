// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {defaultQuote} from "./helpers/ForcedSaleQuote.sol";
import {LibUserVault} from "../src/libraries/LibUserVault.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice #3178 (owner decision 2026-11-05, final) — a lender whose vault is
///         below a mandatory vault version (pinned or not) never traps the
///         renter: every close-out delivers the lender's share into the
///         lender's vault whatever its version, and the Diamond lets nothing
///         leave that vault (the lender's claim included) until it is upgraded.
///         A pinned vault can be upgraded only by its owner.
contract PinnedRentalCloseoutTest is SetupTest {
    uint256 internal constant DAILY_FEE = 10 ether;
    uint256 internal constant RENTAL_DAYS = 7;

    function setUp() public {
        setupHelper();
    }

    // -- Fixture ------------------------------------------------------------

    /// @dev An open 7-day ERC-721 rental, then the lender pins the vault it
    ///      runs and the protocol releases a newer, MANDATORY vault version.
    function _pinnedBelowMandatoryRental() internal returns (uint256 loanId) {
        loanId = _openRental();
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).pinVaultImplementation();
        VaultFactoryFacet vf = VaultFactoryFacet(address(diamond));
        vf.upgradeVaultImplementation(address(new VaipakamVaultImplementation()));
        (,uint256 current,,) = vf.getVaultVersionInfo(lender);
        vf.setMandatoryVaultUpgrade(current);
        assertTrue(_upgradeRequired(lender), "fixture: the lender's vault is below the mandatory version");
        // The gate itself is still on for any resolution that is not a delivery.
        vm.expectRevert(VaultFactoryFacet.VaultUpgradeRequired.selector);
        vf.getOrCreateUserVault(lender);
        assertTrue(
            VaultDepositoryFacet(address(diamond)).getVaultPin(lender) != address(0),
            "fixture: the lender's vault is pinned"
        );
    }

    function _upgradeRequired(address user) internal view returns (bool required) {
        (,,, required) = VaultFactoryFacet(address(diamond)).getVaultVersionInfo(user);
    }

    function _status(uint256 loanId) internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId).status;
    }

    // -- The renter is never trapped; the share lands in the lender's vault ---

    function _vaultOf(address who) internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
    }

    /// @dev Kills: the repayment's lender deposit reverting on the lender's
    ///      vault version (VaultUpgradeRequired), and the renter's own
    ///      below-mandatory vault blocking the prepay draw (the fixture puts
    ///      every vault below the mandatory version).
    function test_RenterRepays_ShareLandsInTheLendersVault() public {
        uint256 loanId = _pinnedBelowMandatoryRental();
        assertTrue(_upgradeRequired(borrower), "fixture: the renter's vault is below mandatory too");
        uint256 lVault0 = IERC20(mockERC20).balanceOf(_vaultOf(lender));
        vm.warp(block.timestamp + 2 days);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the rental closed");
        (, uint256 claim,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(claim, 0, "fixture: rent is owed");
        assertEq(IERC20(mockERC20).balanceOf(_vaultOf(lender)) - lVault0, claim, "into the lender's vault");
        assertTrue(VaultDepositoryFacet(address(diamond)).getVaultPin(lender) != address(0), "the pin is untouched");
    }

    /// @dev Kills: the early close resolving the lender's vault outside the
    ///      receive window (it reverted on the version gate).
    function test_RenterPrecloses_ShareLandsInTheLendersVault() public {
        uint256 loanId = _pinnedBelowMandatoryRental();
        uint256 lVault0 = IERC20(mockERC20).balanceOf(_vaultOf(lender));
        vm.warp(block.timestamp + 2 days);

        vm.prank(borrower);
        PrecloseFacet(address(diamond)).precloseDirect(loanId);

        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "the rental closed early");
        (, uint256 claim,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(claim, 0, "fixture: rent is owed");
        assertEq(IERC20(mockERC20).balanceOf(_vaultOf(lender)) - lVault0, claim, "into the lender's vault");
    }

    /// @dev Kills: the default's prepay deposit to the lender reverting, which
    ///      rolled back the whole default of an overdue rental.
    function test_OverdueRentalDefaults_ShareLandsInTheLendersVault() public {
        uint256 loanId = _pinnedBelowMandatoryRental();
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 lVault0 = IERC20(mockERC20).balanceOf(_vaultOf(lender));
        vm.warp(uint256(l.startTime) + RENTAL_DAYS * 1 days + 30 days);

        uint256 sellQuote = defaultQuote(address(diamond), loanId);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, sellQuote, defaultAdapterCalls());

        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Defaulted), "the overdue rental defaulted");
        (, uint256 claim,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(IERC20(mockERC20).balanceOf(_vaultOf(lender)) - lVault0, claim, "into the lender's vault");
    }

    // -- Nothing leaves the lender's vault until it is upgraded -------------

    /// @dev Kills: a claim (an outflow) paying out of a vault below the
    ///      mandatory version, and a gate that stays shut after the upgrade.
    function test_LenderClaimWaitsForTheUpgradeThenPays() public {
        uint256 loanId = _pinnedBelowMandatoryRental();
        vm.warp(block.timestamp + 2 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        (, uint256 claim,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);

        vm.prank(lender);
        vm.expectRevert();
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        vm.prank(lender);
        VaultFactoryFacet(address(diamond)).upgradeUserVault(lender);
        assertFalse(_upgradeRequired(lender), "upgraded");

        uint256 wallet0 = IERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        assertEq(IERC20(mockERC20).balanceOf(lender) - wallet0, claim, "the claim paid in full");
        assertEq(IERC721(mockNft721).ownerOf(1), lender, "and the NFT came home");
    }

    /// @dev #3178 (owner decision 2026-11-05) — a PINNED vault below the
    ///      mandatory version has no depository exception: its owner's own
    ///      withdrawal waits for the upgrade like every other owner outflow,
    ///      and the owner's own upgrade (which clears their pin) lifts it.
    ///      Kills: the retired pinned-depository exception.
    function test_PinnedOwnerDepositoryWithdrawalWaitsForTheUpgrade() public {
        vm.startPrank(lender);
        IERC20(mockERC20).approve(address(diamond), 5 ether);
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 5 ether);
        vm.stopPrank();
        _pinnedBelowMandatoryRental();

        vm.prank(lender);
        vm.expectRevert();
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            lender, uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 5 ether, lender
        );

        vm.prank(lender);
        VaultFactoryFacet(address(diamond)).upgradeUserVault(lender);
        uint256 wallet0 = IERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            lender, uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 5 ether, lender
        );
        assertEq(IERC20(mockERC20).balanceOf(lender) - wallet0, 5 ether, "withdrawn after the upgrade");
    }

    /// @dev Kills: the receive exemption leaking to a resolution that is not a
    ///      delivery: a lender below the mandatory version still cannot post.
    function test_PinnedLenderBelowMandatoryCannotPostARentalOffer() public {
        _pinnedBelowMandatoryRental();
        MockRentableNFT721(mockNft721).mint(lender, 2);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(LibUserVault.GetUserVaultFailed.selector, "Get User Vault failed"));
        OfferCreateFacet(address(diamond)).createOffer(_rentalParams(2));
    }

    // -- Helpers -------------------------------------------------------------

    function _rentalParams(uint256 tokenId) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockNft721,
            amount: DAILY_FEE,
            interestRateBps: 0,
            collateralAsset: address(0),
            collateralAmount: 0,
            durationDays: RENTAL_DAYS,
            assetType: LibVaipakam.AssetType.ERC721,
            tokenId: tokenId,
            quantity: 1,
            creatorRiskAndTermsConsent: true,
            prepayAsset: mockERC20,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: DAILY_FEE,
            interestRateBpsMax: 0,
            collateralAmountMax: 0,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _openRental() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(_rentalParams(1));
        loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Active), "fixture: the rental is open");
    }
}
