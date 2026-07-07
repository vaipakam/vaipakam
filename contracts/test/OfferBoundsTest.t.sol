// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferBounds} from "../src/libraries/LibOfferBounds.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title OfferBoundsTest
 * @notice #998 S15 (#900) — the system-derived floor/ceiling admission bound is
 *         now enforced at offer CREATE and offer MUTATE (previously gated behind
 *         the dead `rangeAmountEnabled` flag AND reading an un-stamped
 *         `offer.amountMax` == 0, so it never fired), keyed on the offer being
 *         liquid-both-legs ERC-20.
 *
 *         SetupTest convention: `mockERC20` (lend) + `mockCollateralERC20`
 *         (collateral) are both $1, both Liquid, tier-liquidation LTV 85%, and
 *         the non-tiered admission HF floor is 1.5. So for a 1000-principal
 *         lender offer the collateral floor is ceil(1000 × 1.5 / 0.85) ≈ 1765,
 *         and for a 1000-collateral borrower offer the lending ceiling is
 *         floor(1000 × 0.85 / 1.5) ≈ 566.
 */
contract OfferBoundsTest is SetupTest {
    function setUp() public {
        setupHelper();
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _createLender(uint256 amount, uint256 collateral)
        internal
        returns (uint256 offerId)
    {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: 500,
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
                amountMax: amount, // single-value
                interestRateBpsMax: 500,
                collateralAmountMax: collateral,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    function _createBorrower(uint256 amount, uint256 collateral)
        internal
        returns (uint256 offerId)
    {
        vm.prank(borrower);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: 500,
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
                amountMax: amount, // single-value
                interestRateBpsMax: 500,
                collateralAmountMax: collateral,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    function _mutate() internal view returns (OfferMutateFacet) {
        return OfferMutateFacet(address(diamond));
    }

    // ── CREATE: lender floor ─────────────────────────────────────────────────

    /// @dev A lender offer whose required collateral sits below the system floor
    ///      is rejected at create (it could never clear the loan-init HF gate).
    function test_S15_createLenderFloorRejectsThinCollateral() public {
        vm.expectPartialRevert(LibOfferBounds.MinCollateralBelowFloor.selector);
        _createLender(1000 ether, 1500 ether); // 1500 < floor ~1765
    }

    /// @dev A valid collateral ratio (≥ floor) creates fine.
    function test_S15_createLenderFloorPassesValidCollateral() public {
        uint256 id = _createLender(1000 ether, 2000 ether); // 2000 > floor ~1765
        assertGt(id, 0);
    }

    /// @dev Single-value (amount == amountMax) offers ARE bounded — the check is
    ///      keyed on liquid-both-legs, not on the offer being a range shape.
    function test_S15_singleValueOfferIsBounded() public {
        vm.expectPartialRevert(LibOfferBounds.MinCollateralBelowFloor.selector);
        _createLender(1000 ether, 1000 ether); // single-value, thin
    }

    // ── CREATE: borrower ceiling ─────────────────────────────────────────────

    /// @dev A borrower offer whose accepted lending exceeds what its collateral
    ///      can back is rejected at create.
    function test_S15_createBorrowerCeilingRejectsOverLeverage() public {
        vm.expectPartialRevert(LibOfferBounds.MaxLendingAboveCeiling.selector);
        _createBorrower(1000 ether, 1000 ether); // amount 1000 > ceiling ~566
    }

    /// @dev A borrower offer within the ceiling creates fine.
    function test_S15_createBorrowerCeilingPassesValidAmount() public {
        uint256 id = _createBorrower(500 ether, 1000 ether); // 500 < ceiling ~566
        assertGt(id, 0);
    }

    // ── MUTATE ───────────────────────────────────────────────────────────────

    /// @dev A mutate can't drop a lender offer's collateral below the floor a
    ///      createOffer would reject.
    function test_S15_mutateCollateralBelowFloorRejects() public {
        uint256 id = _createLender(1000 ether, 2000 ether); // valid
        vm.prank(lender);
        vm.expectPartialRevert(LibOfferBounds.MinCollateralBelowFloor.selector);
        _mutate().setOfferCollateral(id, 1500 ether, 1500 ether); // 1500 < floor
    }

    /// @dev A mutate can't raise a borrower offer's amount past the ceiling.
    function test_S15_mutateAmountAboveCeilingRejects() public {
        uint256 id = _createBorrower(500 ether, 1000 ether); // valid
        vm.prank(borrower);
        vm.expectPartialRevert(LibOfferBounds.MaxLendingAboveCeiling.selector);
        _mutate().setOfferAmount(id, 1000 ether, 1000 ether); // 1000 > ceiling ~566
    }

    /// @dev An in-bounds mutate settles fine (raise collateral, still valid).
    function test_S15_mutateWithinBoundsPasses() public {
        uint256 id = _createLender(1000 ether, 2000 ether);
        vm.prank(lender);
        _mutate().setOfferCollateral(id, 2500 ether, 2500 ether); // still ≥ floor
        assertGt(id, 0);
    }

    // ── Keying: illiquid legs skip the bound ─────────────────────────────────

    /// @dev A thin offer whose collateral leg is illiquid is NOT bounded — the
    ///      mutual-consent illiquid path is intentionally exempt from the HF
    ///      admission (LoanFacet), so create/mutate must not gate it either.
    function test_S15_illiquidCollateralLegSkipsBound() public {
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Illiquid);
        uint256 id = _createLender(1000 ether, 1500 ether); // thin, but illiquid → no bound
        assertGt(id, 0);
    }
}
