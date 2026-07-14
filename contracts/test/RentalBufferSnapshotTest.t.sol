// test/RentalBufferSnapshotTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title RentalBufferSnapshotTest
 * @notice #1193 (Pass-2 D3) — the NFT-rental buffer BPS is snapshotted on the
 *         offer at create and every later economic site funds/refunds/reset the
 *         SAME buffer that was vaulted, immune to a `cfgRentalBufferBps()`
 *         governance retune. These tests raise the live config AFTER an offer is
 *         posted and assert the accept pull, loan-init `bufferAmount`, cancel
 *         refund, and modify delta all track the offer's create-time snapshot,
 *         not the mutated live config.
 */
contract RentalBufferSnapshotTest is SetupTest {
    uint256 constant BPS = 10000;

    function setUp() public {
        setupHelper();
        deal(mockERC20, lender, 1_000_000 ether);
        deal(mockERC20, borrower, 1_000_000 ether);
        deal(mockCollateralERC20, borrower, 1_000_000 ether);
        vm.prank(lender);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
    }

    /// @dev Lender rental offer posted at the default 5% buffer; governance
    ///      raises it to 10% before the borrower accepts. The accept pull AND
    ///      the recorded `loan.bufferAmount` must use the offer's 5% snapshot,
    ///      not the live 10% — otherwise the borrower overpays and the loan
    ///      records a buffer the borrower never funded.
    function test_D3_lenderRentalAcceptUsesOfferBufferSnapshot() public {
        uint256 dailyFee = 10 ether;
        uint256 duration = 7;
        uint256 rental = dailyFee * duration;          // 70e
        uint256 buffer5 = (rental * 500) / BPS;        // 3.5e (default 5%)
        uint256 totalPrepay5 = rental + buffer5;       // 73.5e

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _lenderRentalParams(dailyFee, duration, totalPrepay5)
        );

        // Governance RAISES the rental buffer to 10% AFTER the offer is posted.
        TestMutatorFacet(address(diamond)).setRentalBufferBpsRaw(1000);

        uint256 borrowerBefore = IERC20(mockERC20).balanceOf(borrower);
        LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);

        // The borrower paid the offer's 5%-snapshot prepay, not the live 10%.
        assertEq(
            borrowerBefore - IERC20(mockERC20).balanceOf(borrower),
            totalPrepay5,
            "accept pull must use the offer's buffer snapshot"
        );
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(
            loan.bufferAmount,
            buffer5,
            "loan.bufferAmount must come from the offer snapshot, not live config"
        );
    }

    /// @dev Borrower rental offer posted at 5% (vaults its prepay at create);
    ///      governance raises the buffer to 20% (max) before cancel. The refund
    ///      must return exactly the vaulted 5% prepay — reading live config would
    ///      try to withdraw more than the vault holds and BRICK the cancel (the
    ///      exact D3 failure mode).
    function test_D3_borrowerRentalCancelRefundsSnapshotNotLiveConfig() public {
        uint256 dailyFee = 10 ether;
        uint256 duration = 5;
        uint256 rental = dailyFee * duration;          // 50e
        uint256 buffer5 = (rental * 500) / BPS;        // 2.5e
        uint256 totalPrepay5 = rental + buffer5;       // 52.5e

        uint256 borrowerBefore = IERC20(mockERC20).balanceOf(borrower);
        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _borrowerRentalParams(dailyFee, duration, 1)
        );
        // Create vaulted exactly the 5% prepay.
        assertEq(
            borrowerBefore - IERC20(mockERC20).balanceOf(borrower),
            totalPrepay5,
            "create must vault the 5% prepay"
        );

        // Governance RAISES the buffer to 20% after create.
        TestMutatorFacet(address(diamond)).setRentalBufferBpsRaw(2000);

        // Cancel must refund exactly the vaulted 5% prepay. Pre-#1193 the refund
        // was re-derived at the live 20% (60e) against a vault holding 52.5e →
        // vault shortfall revert (cancel bricked).
        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(
            IERC20(mockERC20).balanceOf(borrower),
            borrowerBefore,
            "cancel must refund exactly the vaulted prepay - no brick, no strand"
        );
    }

    /// @dev Modify raises the daily fee after a governance buffer bump. Both
    ///      sides of the prepay delta use the offer's 5% snapshot (the rate is
    ///      fixed at create; only `amount` changes), so the net pull matches the
    ///      snapshot and a later cancel still refunds exactly.
    function test_D3_borrowerRentalModifyDeltaUsesSnapshotNotLiveConfig() public {
        uint256 duration = 5;

        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _borrowerRentalParams(10 ether, duration, 2)
        );

        // Governance RAISES the buffer to 20% after create.
        TestMutatorFacet(address(diamond)).setRentalBufferBpsRaw(2000);

        // Raise the daily fee 10e -> 12e. Delta prepay at the 5% snapshot:
        //   old = 10 * 5 * 1.05 = 52.5e ; new = 12 * 5 * 1.05 = 63e → pull 10.5e.
        // At the live 20% the delta would be 12e (60->72), so the exact assert
        // distinguishes snapshot from live config.
        uint256 borrowerBefore = IERC20(mockERC20).balanceOf(borrower);
        vm.prank(borrower);
        OfferMutateFacet(address(diamond)).modifyOffer(
            offerId,
            LibVaipakam.OfferModifyParams({
                amount: 12 ether,
                amountMax: 12 ether,
                interestRateBps: 0,
                interestRateBpsMax: 0,
                collateralAmount: 1 ether, // unchanged
                collateralAmountMax: 1 ether // unchanged
            })
        );
        assertEq(
            borrowerBefore - IERC20(mockERC20).balanceOf(borrower),
            10.5 ether,
            "modify delta must use the offer's 5% snapshot, not live 20%"
        );
    }

    // ─── Offer-shape helpers ────────────────────────────────────────────────

    function _lenderRentalParams(uint256 dailyFee, uint256 duration, uint256 totalPrepay)
        private
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockNft721,
            amount: dailyFee,
            interestRateBps: 0,
            collateralAsset: mockERC20,
            collateralAmount: totalPrepay,
            durationDays: duration,
            assetType: LibVaipakam.AssetType.ERC721,
            tokenId: 1,
            quantity: 1,
            creatorRiskAndTermsConsent: true,
            prepayAsset: mockERC20,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: dailyFee,
            interestRateBpsMax: 0,
            collateralAmountMax: totalPrepay,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _borrowerRentalParams(uint256 dailyFee, uint256 duration, uint256 tokenId)
        private
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: mockNft721,
            amount: dailyFee,
            interestRateBps: 0,
            collateralAsset: mockCollateralERC20,
            collateralAmount: 1 ether,
            durationDays: duration,
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
            amountMax: dailyFee,
            interestRateBpsMax: 0,
            collateralAmountMax: 1 ether,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }
}
