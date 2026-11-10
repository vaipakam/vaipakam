// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {ProtectedAccountFacet} from "../src/facets/ProtectedAccountFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibProtectedAccount} from "../src/libraries/LibProtectedAccount.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ProtectedLoanAuthorityTest
 * @notice Protected account mode on a live loan:
 *         - once a replacement retires a holder, the old wallet loses its
 *           authority over the position (an in-place extension, the
 *           extension consent) and the controller takes it over, while the
 *           retired wallet's earlier consent stops counting;
 *         - a payment a borrower makes from their own wallet to a protected
 *           lender lands in the lender's vault, credited to its depository
 *           record, and never in the lender's wallet.
 */
contract ProtectedLoanAuthorityTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint32 internal constant DELAY = 2 days;

    function setUp() public {
        setupHelper();
        AdminFacet(address(diamond)).setAutoExtendEnabled(true);
    }

    function _f() internal view returns (AutoLifecycleFacet) {
        return AutoLifecycleFacet(address(diamond));
    }

    function _pa() internal view returns (ProtectedAccountFacet) {
        return ProtectedAccountFacet(address(diamond));
    }

    function _openLoan(bool partialRepay) internal returns (uint256 loanId) {
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
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: partialRepay,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    /// @dev The holder hands its own account to `nominee` after the delay.
    function _retire(address holder, address nominee) internal {
        vm.startPrank(holder);
        _pa().enableProtectedMode(DELAY, false);
        _pa().proposeReplacement(holder, nominee);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        _pa().finalizeReplacement(holder);
    }

    /// A replacement moves the authority over a held position to the
    /// controller: the retired wallet can neither extend the loan nor give
    /// extension consent, the consent it gave before stops counting, and the
    /// controller gives it afresh and extends.
    function testRetiredBorrowerLosesExtensionAuthorityToTheController() public {
        uint256 loanId = _openLoan(false);
        uint64 farExpiry = uint64(block.timestamp + 400 days);
        vm.prank(borrower);
        _f().setAutoExtendBorrowerCaps(loanId, true, 0, 1000, farExpiry);
        vm.prank(lender);
        _f().setAutoExtendLenderCaps(loanId, true, 0, 1000, farExpiry);
        ERC20Mock(mockERC20).mint(borrower, 10 ether);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), 10 ether);
        _f().fundExtendReserve(loanId, 10 ether);
        vm.stopPrank();

        address nominee = makeAddr("borrowerController");
        _retire(borrower, nominee);
        (uint64 opensAt, ) = _f().getAutoExtendWindow(loanId);
        vm.warp(opensAt);

        // The retired wallet's consent no longer counts.
        assertFalse(_f().getAutoExtendBorrowerCaps(loanId).enabled, "old consent voided");
        // The old wallet can neither extend nor consent again.
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.KeeperAccessRequired.selector);
        _f().extendLoanInPlace(loanId, 500, 30);
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        _f().setAutoExtendBorrowerCaps(loanId, true, 0, 1000, farExpiry);

        // The controller consents and extends; the charge comes from the
        // account's reserve.
        vm.prank(nominee);
        _f().setAutoExtendBorrowerCaps(loanId, true, 0, 1000, farExpiry);
        assertTrue(_f().getAutoExtendBorrowerCaps(loanId).enabled, "controller consent counts");
        uint256 startBefore = LoanFacet(address(diamond)).getLoanDetails(loanId).startTime;
        vm.prank(nominee);
        _f().extendLoanInPlace(loanId, 500, 30);
        assertGt(LoanFacet(address(diamond)).getLoanDetails(loanId).startTime, startBefore, "extended");
    }

    /// A partial repayment the borrower pays from their wallet to a protected
    /// lender is credited to the lender's vault, never paid to its wallet.
    function testPartialRepaymentToAProtectedLenderLandsInItsVault() public {
        uint256 loanId = _openLoan(true);
        vm.prank(lender);
        _pa().enableProtectedMode(DELAY, false);
        vm.warp(block.timestamp + 10 days);

        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        uint256 walletBefore = ERC20(mockERC20).balanceOf(lender);
        uint256 vaultBefore = ERC20(mockERC20).balanceOf(lenderVault);
        uint256 heldBefore =
            VaultDepositoryFacet(address(diamond)).getDepositoryHolding(lender, mockERC20, 0);

        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        vm.stopPrank();

        uint256 arrived = ERC20(mockERC20).balanceOf(lenderVault) - vaultBefore;
        assertGt(arrived, PRINCIPAL / 2 - 1, "principal and interest reached the vault");
        assertEq(ERC20(mockERC20).balanceOf(lender), walletBefore, "nothing paid to the wallet");
        assertEq(
            VaultDepositoryFacet(address(diamond)).getDepositoryHolding(lender, mockERC20, 0) - heldBefore,
            arrived,
            "the whole payment is the lender's to withdraw through the delay"
        );
    }

    /// A retired wallet funds nothing: a deposit it made would be its
    /// controller's to withdraw, so it is refused.
    function testRetiredWalletCannotDepositIntoTheAccount() public {
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        address nominee = makeAddr("depositController");
        _retire(borrower, nominee);
        ERC20Mock(mockERC20).mint(borrower, 1 ether);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.NotAccountManager.selector, borrower, borrower));
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 1 ether);
        vm.stopPrank();
    }
}
