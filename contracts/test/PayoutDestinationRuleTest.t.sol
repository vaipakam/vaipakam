// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {VaultOutflowFacet} from "../src/facets/VaultOutflowFacet.sol";
import {VaultPayoutFacet} from "../src/facets/VaultPayoutFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MulticallFacet} from "../src/facets/MulticallFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {VaultOutflowTypes, OutflowReason} from "../src/vault/VaultOutflowTypes.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {LibTestProtection} from "./helpers/LibTestProtection.sol";
import {LibTestGuard} from "./helpers/LibTestGuard.sol";

/// @title PayoutDestinationRuleTest
/// @notice The payout rule (owner decision 2026-11-19,
///         PayoutDestinationRuleDesign.md) and #3744: what an open offer
///         returns goes to the vault of the holder of the offer's position
///         token as free balance, never to a wallet; the rights to cancel and
///         edit follow that holder; a step someone else triggers is never
///         blocked by a holder who cannot be paid. And the own-balance
///         release never credits more than the vault holds unencumbered.
contract PayoutDestinationRuleTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    address internal newHolder;
    address internal stranger;

    function setUp() public {
        setupHelper();
        newHolder = makeAddr("offerNewHolder");
        stranger = makeAddr("offerStranger");
        deal(mockERC20, lender, 1_000_000 ether);
        deal(mockERC20, newHolder, 1_000_000 ether);
        vm.prank(lender);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(newHolder);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _params(uint64 expiresAt) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: 5000 ether,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: PRINCIPAL,
            interestRateBpsMax: 500,
            collateralAmountMax: 5000 ether,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: expiresAt,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _createLenderOffer(uint64 expiresAt) internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(_params(expiresAt), type(uint64).max);
    }

    function _token(uint256 offerId) internal view returns (uint256) {
        return OfferCancelFacet(address(diamond)).getOffer(offerId).positionTokenId;
    }

    function _free(address who) internal view returns (uint256) {
        return VaultDepositoryFacet(address(diamond)).getDepositoryHolding(who, mockERC20, 0);
    }

    function _wallet(address who) internal view returns (uint256) {
        return ERC20Mock(mockERC20).balanceOf(who);
    }

    function _pastCooldown() internal {
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY + 1);
    }

    // ─── Cancel ─────────────────────────────────────────────────────────

    /// @dev The creator still holds the token: the escrow becomes free in its
    ///      own vault; nothing moves and the wallet is untouched.
    function test_cancel_byCreator_releasesIntoItsOwnFreeBalance() public {
        uint256 offerId = _createLenderOffer(0);
        _pastCooldown();
        uint256 wallet0 = _wallet(lender);
        uint256 free0 = _free(lender);
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(_wallet(lender), wallet0, "wallet untouched");
        assertEq(_free(lender) - free0, PRINCIPAL, "free in the creator's vault");
    }

    /// @dev #3744 — after the offer's token moved, its new holder cancels and
    ///      is credited; the creator may no longer cancel and gets nothing.
    function test_cancel_afterTransfer_paysTheHoldersVault() public {
        uint256 offerId = _createLenderOffer(0);
        LibTestPositionNFT.move(address(diamond), _token(offerId), newHolder);
        _pastCooldown();

        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(OfferCancelFacet.NotCreatorOrNotExpired.selector, newHolder, uint64(0))
        );
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);

        uint256 creatorFree0 = _free(lender);
        uint256 creatorWallet0 = _wallet(lender);
        uint256 holderWallet0 = _wallet(newHolder);
        vm.prank(newHolder);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(_free(newHolder), PRINCIPAL, "free in the holder's vault");
        assertEq(_free(lender), creatorFree0, "creator credited nothing");
        assertEq(_wallet(lender), creatorWallet0, "creator wallet untouched");
        assertEq(_wallet(newHolder), holderWallet0, "holder wallet untouched");
    }

    /// @dev #3744 — anyone may clear an expired offer, and the escrow goes to
    ///      the holder's vault, never to the cleaner.
    function test_expiredCleanup_afterTransfer_paysTheHolder() public {
        uint64 deadline = uint64(block.timestamp + 2 hours);
        uint256 offerId = _createLenderOffer(deadline);
        LibTestPositionNFT.move(address(diamond), _token(offerId), newHolder);
        vm.warp(uint256(deadline) + 1);
        vm.prank(stranger);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(_free(newHolder), PRINCIPAL, "the holder is credited");
        assertEq(_wallet(stranger), 0, "nothing to the cleaner");
    }

    /// @dev #3744 — a holder who cannot be paid (a flagged wallet with no
    ///      vault) never blocks a step someone else triggers: the escrow stays
    ///      in the creator's vault, held for the token, out of the creator's
    ///      reach, and the token's holder collects it once it reads clean.
    function test_expiredCleanup_unpayableHolder_holdsForTheToken_thenCollects() public {
        uint64 deadline = uint64(block.timestamp + 2 hours);
        uint256 offerId = _createLenderOffer(deadline);
        uint256 token = _token(offerId);
        LibTestPositionNFT.move(address(diamond), token, newHolder);

        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(newHolder, true);

        vm.warp(uint256(deadline) + 1);
        uint256 creatorFree0 = _free(lender);
        vm.prank(stranger);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(
            OfferCancelFacet(address(diamond)).getOfferRefundHeld(token, mockERC20, 0), PRINCIPAL, "held for the token"
        );
        assertEq(_free(lender), creatorFree0, "not the creator's free balance");
        assertEq(
            VaultDepositoryFacet(address(diamond)).freeHolding(lender, 0, mockERC20, 0), 0, "out of the creator's reach"
        );

        // While flagged, the holder cannot collect.
        vm.prank(newHolder);
        vm.expectRevert();
        OfferCancelFacet(address(diamond)).collectOfferRefund(token, 0, mockERC20, 0);

        m.setFlagged(newHolder, false);
        // A stranger cannot collect it either.
        vm.prank(stranger);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        OfferCancelFacet(address(diamond)).collectOfferRefund(token, 0, mockERC20, 0);

        vm.prank(newHolder);
        OfferCancelFacet(address(diamond)).collectOfferRefund(token, 0, mockERC20, 0);
        assertEq(_free(newHolder), PRINCIPAL, "collected into the holder's free balance");
        assertEq(OfferCancelFacet(address(diamond)).getOfferRefundHeld(token, mockERC20, 0), 0, "nothing left held");

        vm.prank(newHolder);
        vm.expectRevert(
            abi.encodeWithSelector(OfferCancelFacet.NothingHeldForOfferToken.selector, token, mockERC20, uint256(0))
        );
        OfferCancelFacet(address(diamond)).collectOfferRefund(token, 0, mockERC20, 0);
    }

    /// @dev Test 2 / 4 — a protected creator's cancel queues nothing and uses
    ///      no payout room: the escrow is free in its vault.
    function test_cancel_protectedCreator_queuesNothing() public {
        uint256 offerId = _createLenderOffer(0);
        LibTestProtection.enableWithNfts(address(diamond), lender, 2 days);
        _pastCooldown();
        uint256 free0 = _free(lender);
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(VaultPayoutFacet(address(diamond)).getPendingPayoutIds(lender).length, 0, "nothing queued");
        assertEq(_free(lender) - free0, PRINCIPAL, "free in the vault");
    }

    // ─── Edit ───────────────────────────────────────────────────────────

    /// @dev #3744 — the holder edits the offer; a size-down's released part
    ///      goes to its vault, and the creator may no longer edit.
    function test_sizeDown_afterTransfer_paysTheHolder() public {
        uint256 offerId = _createLenderOffer(0);
        LibTestPositionNFT.move(address(diamond), _token(offerId), newHolder);

        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        OfferMutateFacet(address(diamond)).setOfferAmount(offerId, 600 ether, 600 ether, type(uint64).max);

        uint256 holderWallet0 = _wallet(newHolder);
        vm.prank(newHolder);
        OfferMutateFacet(address(diamond)).setOfferAmount(offerId, 600 ether, 600 ether, type(uint64).max);
        assertEq(_free(newHolder), 400 ether, "released part free in the holder's vault");
        assertEq(_wallet(newHolder), holderWallet0, "holder wallet untouched");
    }

    /// @dev #3744 — a holder's size-up is paid from its wallet into the
    ///      creator's vault, where the offer's escrow and lien live, so a
    ///      later cancel returns the whole escrow to the holder.
    function test_sizeUp_afterTransfer_fundsTheEscrow() public {
        uint256 offerId = _createLenderOffer(0);
        LibTestPositionNFT.move(address(diamond), _token(offerId), newHolder);
        uint256 holderWallet0 = _wallet(newHolder);
        vm.prank(newHolder);
        OfferMutateFacet(address(diamond)).setOfferAmount(offerId, 1500 ether, 1500 ether, type(uint64).max);
        assertEq(holderWallet0 - _wallet(newHolder), 500 ether, "paid by the holder");
        _pastCooldown();
        vm.prank(newHolder);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(_free(newHolder), 1500 ether, "the whole escrow to the holder's vault");
    }

    // ─── The own-balance release ────────────────────────────────────────

    /// @dev Test 16 — a release against a vault that does not hold the amount
    ///      unencumbered is refused, and a release never lifts the free-balance
    ///      ledger above what the vault holds unencumbered.
    function test_ownRelease_isBoundedByTheUnencumberedBalance() public {
        // 1000 under the offer's lien in the lender's vault: nothing free.
        _createLenderOffer(0);
        LibTestGuard.hold(address(diamond));
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultOutflowFacet.WithdrawWouldUnderflowLien.selector, lender, mockERC20, uint256(0), uint256(1), uint256(0)
            )
        );
        VaultOutflowFacet(address(diamond)).vaultOutflowArgs(
            lender, 0, mockERC20, 0, 1, address(0), uint8(VaultOutflowTypes.OutflowClass.OwnRelease), 0, 0, OutflowReason.WITHDRAW
        );
        LibTestGuard.release(address(diamond));

        // 100 deposited free (credited); a release of those same 100 tokens
        // credits nothing more: the ledger never exceeds the vault's free part.
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).depositToVault(0, mockERC20, 0, 100 ether);
        assertEq(_free(lender), 100 ether);
        LibTestGuard.hold(address(diamond));
        vm.prank(address(diamond));
        VaultOutflowFacet(address(diamond)).vaultOutflowArgs(
            lender, 0, mockERC20, 0, 100 ether, address(0), uint8(VaultOutflowTypes.OutflowClass.OwnRelease), 0, 0, OutflowReason.WITHDRAW
        );
        LibTestGuard.release(address(diamond));
        assertEq(_free(lender), 100 ether, "no unbacked credit");
    }

    // ─── "And withdraw" (§4.4) ──────────────────────────────────────────

    function _cancelAndWithdraw(uint256 offerId) internal returns (MulticallFacet.Result[] memory r) {
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](2);
        calls[0] = MulticallFacet.Call({
            callData: abi.encodeCall(OfferCancelFacet.cancelOffer, (offerId)),
            allowFailure: false
        });
        calls[1] = MulticallFacet.Call({
            callData: abi.encodeCall(VaultDepositoryFacet.withdrawCredited, (uint8(0), mockERC20, uint256(0))),
            allowFailure: false
        });
        vm.prank(lender);
        r = MulticallFacet(address(diamond)).multicall(calls);
    }

    /// @dev Tests 7 / 8 — a cancel and its withdraw in one transaction: the
    ///      batch withdraws exactly what the cancel released and leaves the
    ///      free balance the account already had where it was.
    function test_andWithdraw_withdrawsOnlyWhatTheBatchCredited() public {
        uint256 offerId = _createLenderOffer(0);
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).depositToVault(0, mockERC20, 0, 100 ether);
        _pastCooldown();
        uint256 wallet0 = _wallet(lender);
        MulticallFacet.Result[] memory r = _cancelAndWithdraw(offerId);
        (uint256 amount, uint256 queuedId) = abi.decode(r[1].returnData, (uint256, uint256));
        assertEq(amount, PRINCIPAL, "the batch figure");
        assertEq(queuedId, 0);
        assertEq(_wallet(lender) - wallet0, PRINCIPAL, "paid to the wallet");
        assertEq(_free(lender), 100 ether, "earlier free balance stays");
    }

    /// @dev Test 9 — outside a batch the figure is zero: nothing moves.
    function test_andWithdraw_outsideABatch_movesNothing() public {
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).depositToVault(0, mockERC20, 0, 100 ether);
        uint256 wallet0 = _wallet(lender);
        vm.prank(lender);
        (uint256 amount,) = VaultDepositoryFacet(address(diamond)).withdrawCredited(0, mockERC20, 0);
        assertEq(amount, 0);
        assertEq(_wallet(lender), wallet0);
        assertEq(_free(lender), 100 ether);
    }

    /// @dev Test 10 — a second withdrawCredited in the same batch finds the
    ///      figure spent by the first one.
    function test_andWithdraw_twiceInABatch_paysOnce() public {
        uint256 offerId = _createLenderOffer(0);
        _pastCooldown();
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](3);
        calls[0] = MulticallFacet.Call({
            callData: abi.encodeCall(OfferCancelFacet.cancelOffer, (offerId)),
            allowFailure: false
        });
        bytes memory w = abi.encodeCall(VaultDepositoryFacet.withdrawCredited, (uint8(0), mockERC20, uint256(0)));
        calls[1] = MulticallFacet.Call({callData: w, allowFailure: false});
        calls[2] = MulticallFacet.Call({callData: w, allowFailure: false});
        uint256 wallet0 = _wallet(lender);
        vm.prank(lender);
        MulticallFacet.Result[] memory r = MulticallFacet(address(diamond)).multicall(calls);
        (uint256 second,) = abi.decode(r[2].returnData, (uint256, uint256));
        assertEq(second, 0, "figure spent");
        assertEq(_wallet(lender) - wallet0, PRINCIPAL);
    }

    /// @dev Test 11 — a protected account's "and withdraw" is the ordinary
    ///      Withdraw: it queues behind the delay instead of paying at once.
    function test_andWithdraw_protectedAccount_queues() public {
        uint256 offerId = _createLenderOffer(0);
        LibTestProtection.enableWithNfts(address(diamond), lender, 2 days);
        _pastCooldown();
        uint256 wallet0 = _wallet(lender);
        MulticallFacet.Result[] memory r = _cancelAndWithdraw(offerId);
        (uint256 amount, uint256 queuedId) = abi.decode(r[1].returnData, (uint256, uint256));
        assertEq(amount, PRINCIPAL);
        assertTrue(queuedId != 0, "queued");
        assertEq(_wallet(lender), wallet0, "nothing paid yet");
    }
}
