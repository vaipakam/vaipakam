// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibTestProtection} from "./helpers/LibTestProtection.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OfferPriceGuardFacet} from "../src/facets/OfferPriceGuardFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  RetiredAccountAuthorityTest
 * @notice #3526 — after a protected-account replacement retires a wallet:
 *         - the old wallet cannot unlock its position NFTs, cannot move them
 *           (directly or through an operator it approved before), and the
 *           Diamond's transfer check refuses any move out of the account
 *           except to the replacement wallet;
 *         - anyone can move the retired account's tokens to the replacement
 *           wallet, which the NFT contract confirms from the account's own
 *           vault, even while the holder lock is on;
 *         - every position action follows the manager rule: the replacement
 *           wallet may act, the retired wallet may not, and a repayment and a
 *           claim credit the replacement side;
 *         - the self-dealing exclusion compares managers.
 */
contract RetiredAccountAuthorityTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint32 internal constant DELAY = 2 days;

    event PositionRecovered(address indexed from, address indexed to, uint256 indexed tokenId, address by);

    function setUp() public {
        setupHelper();
    }

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

    /// @dev `holder` hands its account to `nominee` after the delay.
    function _retire(address holder, address nominee) internal {
        LibTestProtection.enable(address(diamond), holder, DELAY);
        LibTestProtection.propose(address(diamond), holder, holder, nominee);
        vm.warp(block.timestamp + DELAY);
        LibTestProtection.finalizeReplacement(address(diamond), holder);
    }

    function _recover(uint256 tokenId) internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(makeAddr("anyone"));
        _core().recover(ids);
    }

    /// The core finds each holder's vault where the factory creates it.
    function test_coreFindsTheVaultTheFactoryCreates() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        assertEq(_core().vaultOf(lender), vault, "predicted vault");
        (bool retired, address replacement) = _core().retiredRecordOf(lender);
        assertFalse(retired, "a vault with no replacement is not retired");
        assertEq(replacement, address(0));
    }

    /// The retired wallet can neither unlock nor move its positions, by any
    /// route, and the Diamond refuses a move out of the account to anyone but
    /// the replacement wallet.
    function test_retiredWalletCannotUnlockOrMovePositions() public {
        uint256 loanId = _openLoan();
        uint256 tokenId = _loan(loanId).borrowerTokenId;
        address operator = makeAddr("operatorApprovedBefore");
        address attacker = makeAddr("attacker");
        vm.prank(borrower);
        _core().setApprovalForAll(operator, true);

        address nominee = makeAddr("borrowerReplacement");
        _retire(borrower, nominee);
        (bool retired, address replacement) = _core().retiredRecordOf(borrower);
        assertTrue(retired, "core reads the retirement from the vault");
        assertEq(replacement, nominee, "and the replacement wallet");

        // No unlock: the request is refused, so nothing matures for a keeper.
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderRetired.selector, borrower));
        _core().requestUnlock();
        vm.warp(block.timestamp + 30 days);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.NoUnlockPending.selector, borrower));
        _core().executeUnlock(borrower);

        // No move by the wallet or by its earlier operator.
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderIsLocked.selector, borrower));
        _core().transferFrom(borrower, attacker, tokenId);
        vm.prank(operator);
        vm.expectRevert();
        _core().transferFrom(borrower, attacker, tokenId);

        // The Diamond's own check refuses the move out, whatever the core does.
        vm.prank(address(_core()));
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamNFTFacet.TransferFromRetiredAccount.selector, borrower, attacker)
        );
        VaipakamNFTFacet(address(diamond)).checkPositionTransfer(operator, borrower, attacker, tokenId);

        assertEq(_core().ownerOf(tokenId), borrower, "still with the account");
    }

    /// Anyone moves a retired account's token to the replacement wallet, while
    /// the holder lock is on; a token of a holder that is not retired cannot
    /// be moved this way.
    function test_anyoneRecoversARetiredTokenToTheReplacement() public {
        uint256 loanId = _openLoan();
        LibVaipakam.Loan memory l = _loan(loanId);
        address nominee = makeAddr("borrowerReplacement");
        _retire(borrower, nominee);
        (bool locked,,,,) = _core().lockOf(borrower);
        assertTrue(locked, "the replacement locked the old wallet's tokens");

        uint256[] memory ids = new uint256[](1);
        ids[0] = l.borrowerTokenId;
        LibTestPositionNFT.waitOutCooldown(address(diamond), l.borrowerTokenId);
        address anyone = makeAddr("anyone");
        vm.expectEmit(true, true, true, true, address(_core()));
        emit PositionRecovered(borrower, nominee, l.borrowerTokenId, anyone);
        vm.prank(anyone);
        _core().recover(ids);
        assertEq(_core().ownerOf(l.borrowerTokenId), nominee, "with the replacement wallet");

        ids[0] = l.lenderTokenId;
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderNotRetired.selector, lender));
        _core().recover(ids);
    }

    /// Without any recovery, the replacement wallet acts for the account and
    /// the retired wallet does not; the payout stays with the account.
    function test_controllerClaimsForARetiredLender_oldWalletCannot() public {
        uint256 loanId = _openLoan();
        address nominee = makeAddr("lenderReplacement");
        _retire(lender, nominee);

        vm.warp(block.timestamp + 10 days);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();

        uint256 walletBefore = ERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ClaimFacet(address(diamond)).claimAsLender(loanId);

        vm.prank(nominee);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        assertEq(ERC20(mockERC20).balanceOf(lender), walletBefore, "nothing to the retired wallet");
    }

    /// After recovery the replacement wallet is the holder: the repayment and
    /// the claim credit it, and nothing reaches the retired wallet.
    function test_afterRecoveryRepaymentAndClaimCreditTheReplacement() public {
        uint256 loanId = _openLoan();
        uint256 lenderTokenId = _loan(loanId).lenderTokenId;
        address nominee = makeAddr("lenderReplacement");
        _retire(lender, nominee);
        _recover(lenderTokenId);

        uint256 lenderWallet = ERC20(mockERC20).balanceOf(lender);
        uint256 lenderHeld = VaultDepositoryFacet(address(diamond)).getDepositoryHolding(lender, mockERC20, 0);
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

        uint256 nomineeGot = ERC20(mockERC20).balanceOf(nominee)
            + VaultDepositoryFacet(address(diamond)).getDepositoryHolding(nominee, mockERC20, 0);
        assertGe(nomineeGot, PRINCIPAL, "principal and interest reached the replacement side");
        assertEq(ERC20(mockERC20).balanceOf(lender), lenderWallet, "nothing to the retired wallet");
        assertEq(
            VaultDepositoryFacet(address(diamond)).getDepositoryHolding(lender, mockERC20, 0),
            lenderHeld,
            "nothing to the retired account"
        );
    }

    /// The replacement wallet of a retired lender may not repay that loan.
    function test_controllerOfTheLenderCannotRepay() public {
        uint256 loanId = _openLoan();
        address nominee = makeAddr("lenderReplacement");
        _retire(lender, nominee);
        deal(mockERC20, nominee, 2 * PRINCIPAL);
        vm.startPrank(nominee);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.expectRevert(IVaipakamErrors.LenderCannotRepayOwnLoan.selector);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
    }

    /// The per-loan keeper toggle follows the manager rule.
    function test_loanKeeperToggleIsTheManagers() public {
        uint256 loanId = _openLoan();
        address nominee = makeAddr("borrowerReplacement");
        address keeper = makeAddr("keeper");
        _retire(borrower, nominee);
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ProfileFacet(address(diamond)).setLoanKeeperEnabled(loanId, keeper, true);
        vm.prank(nominee);
        ProfileFacet(address(diamond)).setLoanKeeperEnabled(loanId, keeper, true);
    }

    /// A retired creator's offer can never be accepted, so its creator
    /// settings are refused to the old wallet and to the replacement alike.
    function test_retiredCreatorSettingsRefused() public {
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        vm.prank(lender);
        ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        uint256 offerId = _offer(lender);
        address nominee = makeAddr("lenderReplacement");
        _retire(lender, nominee);
        address keeper = makeAddr("keeper");
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ProfileFacet(address(diamond)).setOfferKeeperEnabled(offerId, keeper, true);
        vm.prank(nominee);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        ProfileFacet(address(diamond)).setOfferKeeperEnabled(offerId, keeper, true);
        // The maker's price-move guard follows the same rule.
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotOfferCreator.selector);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, 500);
        vm.prank(nominee);
        vm.expectRevert(IVaipakamErrors.NotOfferCreator.selector);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, 500);
    }
}
