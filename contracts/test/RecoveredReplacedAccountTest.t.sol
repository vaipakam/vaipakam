// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibTestProtection as P} from "./helpers/LibTestProtection.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultRecovery} from "../src/vault/VaultRecovery.sol";
import {VaultOutflowTypes} from "../src/vault/VaultOutflowTypes.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {RecoveryClawbackFacet} from "../src/facets/RecoveryClawbackFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  RecoveredReplacedAccountTest
 * @notice #3246 part 2 — a replacement (#3526) and a clawback on one
 *         account, in either order (design 4.4 / 4.5):
 *         - the #3526 move of the retired wallet's tokens to the current
 *           wallet is refused with the recovered error, the recovered rule
 *           running first;
 *         - the current wallet still claims, repays, adds collateral and
 *           cancels the account's offers on those tokens;
 *         - every payout reaches the recovery address, never the retired
 *           wallet and never the current one, because the recovered record is
 *           read from the account itself.
 */
contract RecoveredReplacedAccountTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint32 internal constant DELAY = 2 days;
    uint256 internal constant REC_KEY = 0xBEEF;

    address internal rec;
    address internal nominee = makeAddr("replacementWallet");
    address internal anyone = makeAddr("anyone");

    function setUp() public {
        setupHelper();
        rec = vm.addr(REC_KEY);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _core() internal view returns (PositionNFT) {
        return LibTestPositionNFT.core(address(diamond));
    }

    function _offer(address creator) internal returns (uint256 offerId) {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
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
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false,
                lifecycleFlex: 0
            }),
            type(uint64).max
        );
    }

    function _openLoan() internal returns (uint256 loanId) {
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
        loanId = _signAndAcceptOffer(borrower, borrowerPk, _offer(lender));
    }

    function _loan(uint256 loanId) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId);
    }

    function _assets() internal view returns (VaultOutflowTypes.ClawbackAsset[] memory a) {
        a = new VaultOutflowTypes.ClawbackAsset[](2);
        a[0] = VaultOutflowTypes.ClawbackAsset({
            kind: VaultOutflowTypes.AssetKind.ERC20, asset: mockERC20, tokenId: 0
        });
        a[1] = VaultOutflowTypes.ClawbackAsset({
            kind: VaultOutflowTypes.AssetKind.ERC20, asset: mockCollateralERC20, tokenId: 0
        });
    }

    /// @dev `rec` set and in force on `account`, then protected mode on.
    function _protect(address account) internal {
        P.requestRecovery(address(diamond), account, account, REC_KEY);
        vm.warp(block.timestamp + 2 * 2 days);
        P.enable(address(diamond), account, DELAY);
    }

    /// @dev The owner hands `account` to {nominee} after the delay.
    function _replace(address account) internal {
        P.propose(address(diamond), account, account, nominee);
        vm.warp(block.timestamp + DELAY);
        P.finalizeReplacement(address(diamond), account);
    }

    function _clawback(address account, address key) internal {
        VaipakamVaultImplementation v = P.vaultOf(address(diamond), account);
        vm.prank(key);
        v.protect(
            abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(key)))
        );
    }

    /// @dev The #3526 move of `account`'s token to {nominee} is refused with
    ///      the recovered error, not the retired-holder one.
    function _expectMoveRefused(address account, uint256 tokenId) internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(anyone);
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamNFTFacet.TransferFromRecoveredAccount.selector, account, nominee)
        );
        _core().recover(ids);
        assertEq(_core().ownerOf(tokenId), account, "the token stays with the account");
    }

    function _sweep(address account) internal {
        vm.prank(anyone);
        try RecoveryClawbackFacet(address(diamond)).sweepRecovered(account, _assets()) {} catch {}
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return ERC20(token).balanceOf(who);
    }

    // ─── Lender side ────────────────────────────────────────────────────

    /// @dev The lender account, replaced and recovered in the given order,
    ///      with its loan token and a spare offer still at the retired wallet.
    function _lenderCase(bool replaceFirst) internal {
        uint256 loanId = _openLoan();
        uint256 lenderTokenId = _loan(loanId).lenderTokenId;
        uint256 spare = _offer(lender);
        _protect(lender);
        if (replaceFirst) {
            _replace(lender);
            _clawback(lender, nominee);
        } else {
            _clawback(lender, lender);
            _replace(lender);
        }
        uint256 retiredBefore = _bal(mockERC20, lender);
        uint256 currentBefore = _bal(mockERC20, nominee);
        uint256 recBefore = _bal(mockERC20, rec);

        _expectMoveRefused(lender, lenderTokenId);

        // The current wallet cancels the account's offer. (Anyone may on a
        // recovered account; the backing returns to the account either way.)
        vm.prank(nominee);
        OfferCancelFacet(address(diamond)).cancelOffer(spare);

        // The loan is repaid; the retired wallet cannot claim, the current
        // wallet can, and the payout lands with the account.
        vm.warp(block.timestamp + 10 days);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.prank(nominee);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        _sweep(lender);
        assertGe(_bal(mockERC20, rec) - recBefore, 2 * PRINCIPAL, "the loan and the offer reach the recovery address");
        assertEq(_bal(mockERC20, lender), retiredBefore, "nothing to the retired wallet");
        assertEq(_bal(mockERC20, nominee), currentBefore, "nothing to the current wallet");
    }

    function test_a_replacedThenRecovered_lender() public {
        _lenderCase(true);
    }

    function test_b_recoveredThenReplaced_lender() public {
        _lenderCase(false);
    }

    // ─── Borrower side ──────────────────────────────────────────────────

    function _borrowerCase(bool replaceFirst) internal {
        uint256 loanId = _openLoan();
        uint256 borrowerTokenId = _loan(loanId).borrowerTokenId;
        _protect(borrower);
        if (replaceFirst) {
            _replace(borrower);
            _clawback(borrower, nominee);
        } else {
            _clawback(borrower, borrower);
            _replace(borrower);
        }
        _expectMoveRefused(borrower, borrowerTokenId);

        // The current wallet adds collateral and repays from its own funds.
        deal(mockCollateralERC20, nominee, 100 ether);
        deal(mockERC20, nominee, 2 * PRINCIPAL);
        vm.startPrank(nominee);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        address bv = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(nominee);
        ERC20(mockCollateralERC20).approve(bv, type(uint256).max);
        vm.stopPrank();
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.prank(nominee);
        ERC20(mockCollateralERC20).approve(borrowerVault, type(uint256).max);
        vm.prank(nominee);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 100 ether);
        vm.warp(block.timestamp + 10 days);
        vm.prank(nominee);
        RepayFacet(address(diamond)).repayLoan(loanId);

        uint256 retiredBefore = _bal(mockCollateralERC20, borrower);
        uint256 currentBefore = _bal(mockCollateralERC20, nominee);
        uint256 recBefore = _bal(mockCollateralERC20, rec);
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);
        vm.prank(nominee);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        _sweep(borrower);
        assertGe(_bal(mockCollateralERC20, rec) - recBefore, COLLATERAL + 100 ether, "the collateral reaches the recovery address");
        assertEq(_bal(mockCollateralERC20, borrower), retiredBefore, "nothing to the retired wallet");
        assertEq(_bal(mockCollateralERC20, nominee), currentBefore, "nothing to the current wallet");
    }

    function test_a_replacedThenRecovered_borrower() public {
        _borrowerCase(true);
    }

    function test_b_recoveredThenReplaced_borrower() public {
        _borrowerCase(false);
    }
}
