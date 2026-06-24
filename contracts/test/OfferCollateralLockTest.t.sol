// test/OfferCollateralLockTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @title  OfferCollateralLockTest
/// @notice #573 — borrower-offer collateral lock. The security mirror of
///         the #566 offer-principal lock: a Borrower ERC20-borrow offer
///         with ERC20 collateral pre-vaults `collateralAmountMax` into the
///         creator's own vault at create, and this lock marks it in the
///         unified encumbrance aggregate so it cannot be drained (e.g. via
///         `withdrawVPFIFromVault` unstaking pledged VPFI) before a lender
///         accepts — which would otherwise mint an under-collateralized
///         loan. The lock is handed off to the loan-collateral lien at
///         acceptance, released on cancel, decremented per partial fill,
///         and synced on in-place collateral edits.
///
/// @dev    Reuses the asset-agnostic offer-creator-lien primitive on the
///         collateral key (an offer has one creator-side escrow). The
///         partial-fill match decrement + dust-close release are
///         regression-covered by {BorrowerPartialFillTest} /
///         {CancelAfterPartialFillTest}. This file proves create / drain-
///         block / accept-hand-off / cancel / modify end-to-end against
///         the live withdraw guard.
contract OfferCollateralLockTest is SetupTest {
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

    /// @dev A funded ERC20-borrow Borrower offer with ERC20 collateral and
    ///      an independent collateral floor (`collateralAmount`) / ceiling
    ///      (`collateralAmountMax`) — the ceiling is what gets locked.
    function _borrowerParams(uint256 collateralAmount, uint256 collateralAmountMax)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: mockERC20,
            amount: 1000 ether,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: collateralAmount,
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
            amountMax: 1000 ether,
            interestRateBpsMax: 500,
            collateralAmountMax: collateralAmountMax,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _createBorrowerOffer(uint256 collateralAmount, uint256 collateralAmountMax)
        internal
        returns (uint256)
    {
        vm.prank(borrower);
        return OfferCreateFacet(address(diamond)).createOffer(
            _borrowerParams(collateralAmount, collateralAmountMax)
        );
    }

    /// @dev The live lock on the borrower's collateral slot, read through
    ///      the production free-balance view. In these focused tests
    ///      `mockCollateralERC20` carries no other lien on `borrower`, so
    ///      the aggregate IS the offer-collateral (or, post-accept,
    ///      loan-collateral) lien.
    function _collateralLock() internal view returns (uint256) {
        return PROBE
            - MetricsFacet(address(diamond)).getFreeBalance(
                borrower, mockCollateralERC20, 0, PROBE
            );
    }

    // ─── create — the lock latches the pre-vaulted ceiling ───────────

    function test_create_locksCollateralMax_singleValue() public {
        _createBorrowerOffer(5000 ether, 5000 ether);
        assertEq(_collateralLock(), 5000 ether, "single-value locks collateralAmount");
    }

    function test_create_locksCollateralMax_ranged() public {
        _createBorrowerOffer(3000 ether, 5000 ether);
        assertEq(_collateralLock(), 5000 ether, "ranged locks collateralAmountMax, not floor");
    }

    // ─── the lock closes the pre-acceptance drain door ───────────────

    function test_lockedCollateral_blocksDrain() public {
        _createBorrowerOffer(5000 ether, 5000 ether);
        // All pre-vaulted collateral is locked ⇒ free == 0. The VPFI
        // drain door (`withdrawVPFIFromVault`) reads this same aggregate
        // via `freeBalance`; here we exercise the generic ERC20 withdraw
        // chokepoint, which is the same protection.
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactoryFacet.WithdrawWouldUnderflowLien.selector,
                borrower,
                mockCollateralERC20,
                uint256(0),
                uint256(1),
                uint256(0)
            )
        );
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower, mockCollateralERC20, borrower, 1
        );
    }

    // ─── accept — hand-off to the loan-collateral lien (no double/leak) ─

    function test_accept_handsOffToLoanLien() public {
        // Ranged offer: lock latches the ceiling (5000); a direct accept
        // makes a loan on the floor collateral (3000) and refunds the
        // 2000 residual. Post-accept the aggregate must equal exactly the
        // loan lien (3000) — proving the offer lock was released (no
        // double-count) and the loan lien re-encumbers the backing slice.
        uint256 id = _createBorrowerOffer(3000 ether, 5000 ether);
        assertEq(_collateralLock(), 5000 ether, "locked at ceiling pre-accept");
        uint256 walletBefore = ERC20Mock(mockCollateralERC20).balanceOf(borrower);

        _signAndAcceptOffer(lender, lenderPk, id);

        assertEq(_collateralLock(), 3000 ether, "aggregate == loan lien after hand-off");
        assertEq(
            ERC20Mock(mockCollateralERC20).balanceOf(borrower) - walletBefore,
            2000 ether,
            "ceiling residual refunded (hand-off didn't block it)"
        );
    }

    // ─── cancel — release + refund, refund not self-blocked ──────────

    function test_cancel_releasesLockAndRefunds() public {
        uint256 id = _createBorrowerOffer(5000 ether, 5000 ether);
        uint256 walletBefore = ERC20Mock(mockCollateralERC20).balanceOf(borrower);

        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(id);

        assertEq(_collateralLock(), 0, "lock released on cancel");
        assertEq(
            ERC20Mock(mockCollateralERC20).balanceOf(borrower) - walletBefore,
            5000 ether,
            "full collateral refunded (refund not self-blocked)"
        );
    }

    // ─── modify — the lock tracks the collateralAmountMax delta ───────

    function test_modifyShrink_decrementsLock_refundNotSelfBlocked() public {
        uint256 id = _createBorrowerOffer(5000 ether, 5000 ether);
        uint256 walletBefore = ERC20Mock(mockCollateralERC20).balanceOf(borrower);

        // Shrink the collateral ceiling 5000 → 3000; the 2000 delta refunds
        // — only possible because the lock decrements BEFORE the refund.
        vm.prank(borrower);
        OfferMutateFacet(address(diamond)).setOfferCollateral(id, 3000 ether, 3000 ether);

        assertEq(_collateralLock(), 3000 ether, "lock follows the new ceiling");
        assertEq(
            ERC20Mock(mockCollateralERC20).balanceOf(borrower) - walletBefore,
            2000 ether,
            "shrink delta refunded (no self-block)"
        );
    }

    function test_modifyGrow_incrementsLock() public {
        uint256 id = _createBorrowerOffer(5000 ether, 5000 ether);
        uint256 walletBefore = ERC20Mock(mockCollateralERC20).balanceOf(borrower);

        // Grow the collateral ceiling 5000 → 8000: 3000 more pulled + locked.
        vm.prank(borrower);
        OfferMutateFacet(address(diamond)).setOfferCollateral(id, 8000 ether, 8000 ether);

        assertEq(_collateralLock(), 8000 ether, "lock grows with the ceiling");
        assertEq(
            walletBefore - ERC20Mock(mockCollateralERC20).balanceOf(borrower),
            3000 ether,
            "grow delta pulled from borrower wallet"
        );
    }
}
