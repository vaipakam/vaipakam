// test/OfferPrincipalLockTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";

/// @title  OfferPrincipalLockTest
/// @notice T-407-C (#566) — end-to-end lifecycle coverage for the
///         offer-principal lock. An ERC-20 Lender offer pre-vaults its
///         `amountMax` principal into the creator's own vault at create
///         time; this lock marks that principal in the unified
///         encumbrance aggregate (`s.encumbered[creator][lendingAsset][0]`)
///         so the creator cannot withdraw it out from under a live
///         offer, and the lock is released / decremented / grown exactly
///         in step with the principal as the offer is accepted,
///         cancelled, or modified.
///
/// @dev    Division of coverage:
///         - The chokepoint's revert math (raw − lien) is unit-tested in
///           {VaultFactoryFacetWithdrawGuardTest} against a directly-pinned
///           aggregate.
///         - The partial-fill match DECREMENT + dust-close RELEASE are
///           regression-covered by {CancelAfterPartialFillTest} and
///           {BorrowerPartialFillTest}: those drive successful matches,
///           and a wrong decrement-before-withdraw order would revert
///           them with `WithdrawWouldUnderflowLien`.
///         - THIS file proves the create / accept / cancel / modify legs
///           end-to-end against the live guard, reading the lock through
///           the production `MetricsFacet.getFreeBalance` view.
contract OfferPrincipalLockTest is SetupTest {
    /// @dev Large probe balance for the lock reader. Any value ≥ the
    ///      lock works — `getFreeBalance` subtracts the aggregate from
    ///      the caller-supplied raw balance, so `lock = probe − free`.
    uint256 internal constant PROBE = 100_000_000 ether;

    function setUp() public {
        setupHelper();
        deal(mockERC20, lender, 1_000_000 ether);
        deal(mockERC20, borrower, 1_000_000 ether);
        deal(mockCollateralERC20, lender, 1_000_000 ether);
        deal(mockCollateralERC20, borrower, 1_000_000 ether);
        vm.prank(lender);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    /// @dev A funded ERC-20 Lender offer with an independent floor
    ///      (`amount`) and ceiling (`amountMax`) so the ranged-pre-vault
    ///      case is exercised (`amountMax` is what gets locked).
    function _lenderParams(uint256 amount, uint256 amountMax)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockERC20,
            amount: amount,
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
            amountMax: amountMax,
            interestRateBpsMax: 500,
            collateralAmountMax: 5000 ether,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _createLenderOffer(uint256 amount, uint256 amountMax)
        internal
        returns (uint256)
    {
        vm.prank(lender);
        return OfferCreateFacet(address(diamond)).createOffer(
            _lenderParams(amount, amountMax)
        );
    }

    function _lenderVault() internal returns (address) {
        return VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
    }

    /// @dev The live offer-principal lock on the lender's `mockERC20`
    ///      slot, read through the production free-balance view. In these
    ///      focused tests `mockERC20` carries no other lien, so the
    ///      aggregate IS the offer-principal lock.
    function _lock() internal view returns (uint256) {
        return PROBE
            - MetricsFacet(address(diamond)).getFreeBalance(
                lender, mockERC20, 0, PROBE
            );
    }

    // ─── create — the lock latches the full pre-vaulted ceiling ──────

    function test_create_locksFullAmountMax_singleValue() public {
        _createLenderOffer(1000 ether, 1000 ether);
        assertEq(_lock(), 1000 ether, "single-value offer locks amount");
    }

    function test_create_locksFullAmountMax_ranged() public {
        // Ranged offer pre-vaults the CEILING; the lock must be the
        // ceiling (`amountMax`), not the floor (`amount`).
        _createLenderOffer(200 ether, 1000 ether);
        assertEq(_lock(), 1000 ether, "ranged offer locks amountMax, not amount");
    }

    // ─── the lock actually protects the principal ───────────────────

    function test_lockedPrincipal_blocksLenderWithdraw() public {
        _createLenderOffer(1000 ether, 1000 ether);
        // The whole pre-vaulted balance is locked ⇒ free == 0 ⇒ even a
        // 1-wei cross-facet withdraw of the principal reverts. Pranking
        // the diamond models a (hypothetical) drifted release-wire.
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactoryFacet.WithdrawWouldUnderflowLien.selector,
                lender,
                mockERC20,
                uint256(0),
                uint256(1),
                uint256(0)
            )
        );
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            lender, mockERC20, lender, 1
        );
    }

    // ─── accept — full single-fill consumption releases the lock ─────

    function test_accept_releasesLock() public {
        uint256 id = _createLenderOffer(1000 ether, 1000 ether);
        assertEq(_lock(), 1000 ether, "locked pre-accept");

        _signAndAcceptOffer(borrower, borrowerPk, id);

        // Principal was disbursed into the loan; the lock is gone so the
        // aggregate no longer encumbers the (now-empty) lender slot.
        assertEq(_lock(), 0, "lock released on single-fill accept");
    }

    // ─── cancel — release + refund, and the refund is NOT self-blocked ─

    function test_cancel_releasesLockAndRefunds() public {
        uint256 id = _createLenderOffer(1000 ether, 1000 ether);
        uint256 walletBefore = ERC20Mock(mockERC20).balanceOf(lender);

        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(id);

        assertEq(_lock(), 0, "lock released on cancel");
        assertEq(
            ERC20Mock(mockERC20).balanceOf(lender) - walletBefore,
            1000 ether,
            "full principal refunded to lender wallet (refund not self-blocked)"
        );
    }

    // ─── modify — the lock tracks the amountMax delta in lock-step ────

    function test_modifyShrink_decrementsLock_refundNotSelfBlocked() public {
        uint256 id = _createLenderOffer(1000 ether, 1000 ether);
        uint256 walletBefore = ERC20Mock(mockERC20).balanceOf(lender);

        // Shrink the ceiling 1000 → 600. The 400 delta refunds to the
        // lender's wallet — which is only possible because the lock is
        // decremented BEFORE the refund withdraw (else the chokepoint
        // would treat the 400 as still encumbered and revert).
        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 500 ether, 600 ether);

        assertEq(_lock(), 600 ether, "lock follows the new ceiling");
        assertEq(
            ERC20Mock(mockERC20).balanceOf(lender) - walletBefore,
            400 ether,
            "shrink delta refunded (no self-block)"
        );
    }

    function test_modifyShrink_remainderStillLocked() public {
        uint256 id = _createLenderOffer(1000 ether, 1000 ether);
        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 500 ether, 600 ether);

        // The post-shrink 600 stays locked — the decrement freed exactly
        // the 400 refunded, never the live remainder.
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactoryFacet.WithdrawWouldUnderflowLien.selector,
                lender,
                mockERC20,
                uint256(0),
                uint256(1),
                uint256(0)
            )
        );
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            lender, mockERC20, lender, 1
        );
    }

    function test_modifyGrow_incrementsLock() public {
        uint256 id = _createLenderOffer(1000 ether, 1000 ether);
        uint256 walletBefore = ERC20Mock(mockERC20).balanceOf(lender);

        // Grow the ceiling 1000 → 1500: 500 more pulled in + locked.
        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 1000 ether, 1500 ether);

        assertEq(_lock(), 1500 ether, "lock grows with the ceiling");
        assertEq(
            walletBefore - ERC20Mock(mockERC20).balanceOf(lender),
            500 ether,
            "grow delta pulled from lender wallet"
        );
    }

    // ─── P1 (Codex) — direct accept of a partially-filled offer rejected ─

    /// @notice A lender offer that `matchOffers` has partially filled
    ///         (`amountFilled > 0`, not yet dust-closed) must not be
    ///         direct-acceptable: the direct path would size the loan off
    ///         the full ceiling (not the residual) and, after releasing
    ///         the residual lock, over-commit the lender's free balance.
    ///         Only the matcher may advance such an offer.
    /// @dev    Stamps the partial-fill state directly to isolate the
    ///         direct-accept guard; the end-to-end matchOffers partial
    ///         fill is exercised by {BorrowerPartialFillTest} /
    ///         {CancelAfterPartialFillTest}.
    function test_directAccept_rejectedAfterPartialFill() public {
        uint256 id = _createLenderOffer(200 ether, 1000 ether);

        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOffer(id);
        o.amountFilled = 300 ether;
        TestMutatorFacet(address(diamond)).setOffer(id, o);

        // Build + sign FIRST so the helper's diamond view-calls don't consume
        // the expectRevert; the partial-fill guard then fires.
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, id, true, 0);
        bytes memory _sig =
            LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferAcceptFacet.OfferPartiallyFilled.selector,
                id,
                uint256(300 ether)
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(id, _t, _sig);
    }

    /// @notice `previewAccept` must mirror the direct-accept partial-fill
    ///         guard so off-chain quoters never propose an accept that
    ///         deterministically reverts on-chain.
    function test_previewAccept_classifiesPartialFill() public {
        uint256 id = _createLenderOffer(200 ether, 1000 ether);

        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOffer(id);
        o.amountFilled = 300 ether;
        TestMutatorFacet(address(diamond)).setOffer(id, o);

        OfferAcceptFacet.AcceptPreview memory p =
            OfferPreviewFacet(address(diamond)).previewAccept(id, borrower);
        assertEq(
            uint8(p.errorCode),
            uint8(OfferAcceptFacet.AcceptError.OfferPartiallyFilled),
            "preview classifies a partially-filled offer as non-acceptable"
        );
    }
}
