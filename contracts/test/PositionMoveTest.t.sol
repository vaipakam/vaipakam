// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibTestProtection as P} from "./helpers/LibTestProtection.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultRecovery} from "../src/vault/VaultRecovery.sol";
import {VaultProtectionBase} from "../src/vault/VaultProtectionBase.sol";
import {VaultOutflowTypes} from "../src/vault/VaultOutflowTypes.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {RecoveryClawbackFacet} from "../src/facets/RecoveryClawbackFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  PositionMoveTest
 * @notice #3246 part 2 — moving a replaced account's position tokens to the
 *         wallet that replaced it (owner decision 2026-11-18: the move waits
 *         the delay, a lock stops it). Only the replacing wallet asks, after
 *         the replacement is complete; the request waits the account's delay;
 *         the owner or any signer cancels it; a lock drops it and refuses the
 *         move, matured or not; a clawback refuses it for good.
 */
contract PositionMoveTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint32 internal constant DELAY = 2 days;
    uint256 internal constant REC_KEY = 0xBEEF;

    address internal rec;
    address internal nominee = makeAddr("replacementWallet");
    address internal anyone = makeAddr("anyone");
    address internal s1 = makeAddr("signer1");
    address internal s2 = makeAddr("signer2");
    address internal s3 = makeAddr("signer3");

    uint256 internal loanId;
    uint256 internal lenderToken;

    function setUp() public {
        setupHelper();
        rec = vm.addr(REC_KEY);
        loanId = _openLoan();
        lenderToken = _loan().lenderTokenId;
        P.requestRecovery(address(diamond), lender, lender, REC_KEY);
        vm.warp(block.timestamp + 2 * 2 days);
        P.enable(address(diamond), lender, DELAY);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _core() internal view returns (PositionNFT) {
        return LibTestPositionNFT.core(address(diamond));
    }

    function _vault() internal returns (VaipakamVaultImplementation) {
        return P.vaultOf(address(diamond), lender);
    }

    function _loan() internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId);
    }

    function _openLoan() internal returns (uint256 id) {
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
                durationDays: 60,
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
        id = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    /// @dev The owner hands the lender's account to {nominee} after the delay.
    function _replace() internal {
        P.propose(address(diamond), lender, lender, nominee);
        vm.warp(block.timestamp + DELAY);
        P.finalizeReplacement(address(diamond), lender);
    }

    function _pastCooldown() internal {
        (,,, uint64 cooldownUntil,,,) = _vault().protectionState();
        if (block.timestamp < cooldownUntil) vm.warp(cooldownUntil);
    }

    function _request(address key) internal {
        P.requestPositionMove(address(diamond), lender, key);
    }

    function _expectRequestRefused(address key, bytes memory err) internal {
        VaipakamVaultImplementation v = _vault();
        vm.prank(key);
        vm.expectRevert(err);
        v.protect(abi.encodeCall(VaultRecovery.requestPositionMove, (P.direct(key))));
    }

    function _ids() internal view returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = lenderToken;
    }

    function _expectMoveRefused(uint256 readyAt) internal {
        LibTestPositionNFT.waitOutCooldown(address(diamond), lenderToken);
        uint256[] memory ids = _ids();
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.PositionMoveNotOpen.selector, lender, readyAt));
        _core().recover(ids);
        assertEq(_core().ownerOf(lenderToken), lender, "the token stays with the account");
    }

    function _move() internal {
        LibTestPositionNFT.waitOutCooldown(address(diamond), lenderToken);
        uint256[] memory ids = _ids();
        vm.prank(anyone);
        _core().recover(ids);
    }

    function _assets() internal view returns (VaultOutflowTypes.ClawbackAsset[] memory a) {
        a = new VaultOutflowTypes.ClawbackAsset[](1);
        a[0] = VaultOutflowTypes.ClawbackAsset({kind: VaultOutflowTypes.AssetKind.ERC20, asset: mockERC20, tokenId: 0});
    }

    // ─── Tests ──────────────────────────────────────────────────────────

    /// No request, no move — including in the replacement's own block.
    function test_noRequest_moveRefused_evenInTheReplacementsBlock() public {
        _replace();
        _expectMoveRefused(0);
        vm.warp(block.timestamp + 30 days);
        _expectMoveRefused(0);
    }

    /// Only the replacing wallet asks, only after the replacement and its
    /// cool-down.
    function test_requestByAnyoneButTheManagerRefused() public {
        P.addSigner(address(diamond), lender, lender, s1, DELAY);
        _expectRequestRefused(lender, abi.encodeWithSelector(VaultProtectionBase.NotReplaced.selector));
        _replace();
        _expectRequestRefused(nominee, abi.encodeWithSelector(VaultProtectionBase.InCooldown.selector, uint64(block.timestamp + DELAY)));
        _pastCooldown();
        _expectRequestRefused(lender, abi.encodeWithSelector(VaultProtectionBase.NotOwner.selector, lender));
        _expectRequestRefused(s1, abi.encodeWithSelector(VaultProtectionBase.NotOwner.selector, s1));
        _expectRequestRefused(anyone, abi.encodeWithSelector(VaultProtectionBase.NotOwner.selector, anyone));
        _request(nominee);
    }

    /// The request waits the delay, and expires one further delay later.
    function test_refusedBeforeMaturity_andAfterExpiry() public {
        _replace();
        _pastCooldown();
        _request(nominee);
        uint64 at = uint64(block.timestamp + DELAY);
        _expectMoveRefused(at);
        vm.warp(at - 1);
        _expectMoveRefused(at);
        vm.warp(uint256(at) + DELAY + 1);
        _expectMoveRefused(at);
    }

    /// A signer cancels the request; nothing matures.
    function test_aSignersCancel() public {
        P.addSigner(address(diamond), lender, lender, s1, DELAY);
        _replace();
        _pastCooldown();
        _request(nominee);
        uint64 at = uint64(block.timestamp + DELAY);
        vm.expectEmit(true, false, false, true);
        emit VaultProtectionBase.PositionMoveCancelled(lender, at, s1);
        P.cancelPositionMove(address(diamond), lender, s1);
        vm.warp(at);
        _expectMoveRefused(0);
    }

    /// A lock after the request drops it; a lock after maturity refuses the
    /// matured move too, and the request does not come back on unlock.
    function test_lockDropsTheRequest_andRefusesAMaturedOne() public {
        P.addSigner(address(diamond), lender, lender, s1, DELAY);
        _replace();
        _pastCooldown();
        _request(nominee);
        uint64 at = uint64(block.timestamp + DELAY);
        vm.warp(at);
        (bool open,) = _vault().positionMoveState();
        assertTrue(open, "matured");
        vm.expectEmit(true, false, false, true);
        emit VaultProtectionBase.PositionMoveDropped(lender, at);
        P.lock(address(diamond), lender, s1);
        _expectMoveRefused(0);
        // Locked, a new request is refused too.
        _expectRequestRefused(nominee, abi.encodeWithSelector(VaultProtectionBase.Locked.selector));
    }

    /// After a signer-majority replacement and a move request, a lock and a
    /// clawback keep the positions with the account and every payout reaches
    /// the recovery address.
    function test_lockAndClawbackAfterARequest_keepPositions_andPayTheRecoveryAddress() public {
        P.addSigner(address(diamond), lender, lender, s1, DELAY);
        P.addSigner(address(diamond), lender, lender, s2, DELAY);
        P.addSigner(address(diamond), lender, lender, s3, DELAY);
        P.propose(address(diamond), lender, s1, nominee);
        P.approve(address(diamond), lender, s2, nominee);
        vm.warp(block.timestamp + DELAY);
        P.finalizeReplacement(address(diamond), lender);
        _pastCooldown();
        _request(nominee);
        uint64 at = uint64(block.timestamp + DELAY);

        // A signer locks before maturity and claws back.
        P.lock(address(diamond), lender, s3);
        VaipakamVaultImplementation v = _vault();
        vm.prank(s3);
        v.protect(abi.encodeCall(VaultRecovery.clawback, (_assets(), P.direct(s3))));
        vm.warp(uint256(at) + 1);
        _expectMoveRefused(0);
        _expectRequestRefused(nominee, abi.encodeWithSelector(VaultProtectionBase.RecoveredAccount.selector));

        // The loan is repaid; the claim pays the account, and the sweep pays
        // the recovery address, never the replacing wallet.
        uint256 recBefore = ERC20(mockERC20).balanceOf(rec);
        uint256 nomBefore = ERC20(mockERC20).balanceOf(nominee);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        vm.prank(nominee);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        vm.prank(anyone);
        RecoveryClawbackFacet(address(diamond)).sweepRecovered(lender, _assets());
        assertGe(ERC20(mockERC20).balanceOf(rec) - recBefore, PRINCIPAL, "the payout reaches the recovery address");
        assertEq(ERC20(mockERC20).balanceOf(nominee), nomBefore, "nothing to the replacing wallet");
        assertEq(_core().ownerOf(lenderToken), lender, "the position never left the account");
    }

    /// After the full wait with no lock the tokens move, and the position
    /// then pays the new wallet as its own.
    function test_afterTheFullWait_theTokensMove_andPayTheNewWallet() public {
        _replace();
        _pastCooldown();
        _request(nominee);
        vm.warp(block.timestamp + DELAY);
        _move();
        assertEq(_core().ownerOf(lenderToken), nominee, "with the new wallet");

        // The repayment lands in the holder's vault and the claim releases it
        // there (#3629), so the measure spans both steps.
        address nomVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(nominee);
        uint256 before = ERC20(mockERC20).balanceOf(nominee) + ERC20(mockERC20).balanceOf(nomVault);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        vm.prank(nominee);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        uint256 afterBal = ERC20(mockERC20).balanceOf(nominee) + ERC20(mockERC20).balanceOf(nomVault);
        assertGe(afterBal - before, PRINCIPAL, "the claim pays the new wallet");
    }

    /// A request made in one epoch never opens the move in a later one, also
    /// when an unlock ends the lock that dropped it.
    function test_aRequestNeverOpensInALaterEpoch_evenAfterUnlock() public {
        _replace();
        _pastCooldown();
        _request(nominee);
        uint64 at = uint64(block.timestamp + DELAY);
        P.lock(address(diamond), lender, nominee);
        P.requestUnlock(address(diamond), lender, nominee);
        vm.warp(block.timestamp + DELAY);
        P.finalizeSettings(address(diamond), lender);
        (, bool locked,,,) = _vault().protectionCore();
        assertFalse(locked, "unlocked");
        vm.warp(at);
        (bool open, uint64 readyAt) = _vault().positionMoveState();
        assertFalse(open, "the old request does not open the move");
        assertEq(readyAt, 0, "and is not pending");
        _expectMoveRefused(0);
        vm.warp(uint256(at) + DELAY);
        _expectMoveRefused(0);
    }
}
