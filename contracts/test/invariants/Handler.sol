// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {OfferFacet} from "../../src/facets/OfferFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../../src/facets/DefaultedFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/**
 * @title Handler
 * @notice Shared stateful fuzz handler for Vaipakam invariant suites. Drives
 *         createOffer / acceptOffer / repay / partialRepay / addCollateral /
 *         triggerDefault / claim against a bounded actor set (3 lenders,
 *         3 borrowers), tracks ghost deposits and withdrawals per ERC-20
 *         asset, and exposes accessors the invariant suites read.
 *
 *         Fuzz surface is deliberately restricted to ERC-20-only offers
 *         (USDC principal, WETH collateral) so invariants over token flow
 *         and claim state remain tractable. NFT rental and illiquid paths
 *         are covered by scenario tests.
 */
contract Handler is Test {
    InvariantBase public base;
    address public diamond;
    address public usdc;
    address public weth;

    // Active (not-yet-accepted) lender offer IDs
    uint256[] public lenderOfferIds;
    // Active (not-yet-accepted) borrower offer IDs
    uint256[] public borrowerOfferIds;
    // All initiated loan IDs (may be Repaid/Defaulted/Settled later)
    uint256[] public loanIds;

    // Ghost bookkeeping — monotonically increasing flow counters.
    // Deposits: tokens moved from actors into diamond/escrow scope.
    // Withdrawals: tokens moved out of that scope back to actors.
    mapping(address => uint256) public ghostDeposits;   // asset => cumulative in
    mapping(address => uint256) public ghostWithdrawals; // asset => cumulative out

    // Per-loan claim flags tracked independently of protocol state so
    // invariants can assert monotonicity and exclusivity without relying
    // on internal storage reads.
    mapping(uint256 => bool) public ghostClaimedLender;
    mapping(uint256 => bool) public ghostClaimedBorrower;

    // Call-count telemetry surfaced to invariants for sanity / coverage.
    mapping(bytes32 => uint256) public callCount;

    constructor(InvariantBase _base) {
        base = _base;
        diamond = address(_base.diamond());
        usdc = _base.mockUSDC();
        weth = _base.mockWETH();
    }

    // ── Actor selection helpers ─────────────────────────────────────────
    function _lender(uint256 seed) internal view returns (address) {
        return base.lenderAt(seed);
    }
    function _borrower(uint256 seed) internal view returns (address) {
        return base.borrowerAt(seed);
    }

    // ── Handler actions ────────────────────────────────────────────────

    /// @notice Lender creates an ERC-20 lending offer (USDC principal, WETH collateral).
    function createLenderOffer(
        uint256 lenderSeed,
        uint256 amount,
        uint256 durationDays,
        uint256 rateBps,
        uint256 collateralAmount
    ) external {
        callCount["createLenderOffer"]++;
        address lender = _lender(lenderSeed);

        amount = bound(amount, 100 ether, 10_000 ether);
        durationDays = bound(durationDays, 1, 365);
        rateBps = bound(rateBps, 100, 2000);
        collateralAmount = bound(collateralAmount, 1 ether, 100 ether);

        // Pre-funded balance check — skip if lender has spent down their pool
        if (ERC20Mock(usdc).balanceOf(lender) < amount) return;

        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: usdc,
            amount: amount,
            interestRateBps: rateBps,
            collateralAsset: weth,
            collateralAmount: collateralAmount,
            durationDays: durationDays,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorFallbackConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0
        });

        vm.prank(lender);
        try OfferFacet(diamond).createOffer(p) returns (uint256 id) {
            lenderOfferIds.push(id);
            ghostDeposits[usdc] += amount;
        } catch {}
    }

    /// @notice Borrower creates an ERC-20 borrow request (WETH collateral posted up-front).
    function createBorrowerOffer(
        uint256 borrowerSeed,
        uint256 amount,
        uint256 durationDays,
        uint256 rateBps,
        uint256 collateralAmount
    ) external {
        callCount["createBorrowerOffer"]++;
        address borrower = _borrower(borrowerSeed);

        amount = bound(amount, 100 ether, 10_000 ether);
        durationDays = bound(durationDays, 1, 365);
        rateBps = bound(rateBps, 100, 2000);
        collateralAmount = bound(collateralAmount, 1 ether, 100 ether);

        if (ERC20Mock(weth).balanceOf(borrower) < collateralAmount) return;

        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: usdc,
            amount: amount,
            interestRateBps: rateBps,
            collateralAsset: weth,
            collateralAmount: collateralAmount,
            durationDays: durationDays,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorFallbackConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0
        });

        vm.prank(borrower);
        try OfferFacet(diamond).createOffer(p) returns (uint256 id) {
            borrowerOfferIds.push(id);
            ghostDeposits[weth] += collateralAmount;
        } catch {}
    }

    /// @notice Borrower accepts an open lender offer — collateral posted on accept.
    function acceptLenderOffer(uint256 borrowerSeed, uint256 offerIdx) external {
        callCount["acceptLenderOffer"]++;
        if (lenderOfferIds.length == 0) return;
        address borrower = _borrower(borrowerSeed);
        uint256 idx = bound(offerIdx, 0, lenderOfferIds.length - 1);
        uint256 offerId = lenderOfferIds[idx];

        LibVaipakam.Offer memory o = OfferFacet(diamond).getOffer(offerId);
        if (o.accepted || o.creator == address(0)) {
            _popOfferAt(lenderOfferIds, idx);
            return;
        }
        if (ERC20Mock(weth).balanceOf(borrower) < o.collateralAmount) return;

        vm.prank(borrower);
        try OfferFacet(diamond).acceptOffer(offerId, true) returns (uint256 loanId) {
            loanIds.push(loanId);
            ghostDeposits[weth] += o.collateralAmount;
            ghostWithdrawals[usdc] += o.amount; // principal leaves escrow to borrower wallet
            _popOfferAt(lenderOfferIds, idx);
        } catch {}
    }

    /// @notice Lender accepts an open borrower request — principal funded on accept.
    function acceptBorrowerOffer(uint256 lenderSeed, uint256 offerIdx) external {
        callCount["acceptBorrowerOffer"]++;
        if (borrowerOfferIds.length == 0) return;
        address lender = _lender(lenderSeed);
        uint256 idx = bound(offerIdx, 0, borrowerOfferIds.length - 1);
        uint256 offerId = borrowerOfferIds[idx];

        LibVaipakam.Offer memory o = OfferFacet(diamond).getOffer(offerId);
        if (o.accepted || o.creator == address(0)) {
            _popOfferAt(borrowerOfferIds, idx);
            return;
        }
        if (ERC20Mock(usdc).balanceOf(lender) < o.amount) return;

        vm.prank(lender);
        try OfferFacet(diamond).acceptOffer(offerId, true) returns (uint256 loanId) {
            loanIds.push(loanId);
            ghostDeposits[usdc] += o.amount;
            ghostWithdrawals[usdc] += o.amount; // principal flows lender→borrower through escrow
            _popOfferAt(borrowerOfferIds, idx);
        } catch {}
    }

    /// @notice Borrower repays loan in full.
    function repay(uint256 loanIdx) external {
        callCount["repay"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        vm.prank(L.borrower);
        try RepayFacet(diamond).repayLoan(loanId) {
            // repayment funds flow borrower→lender through escrow + collateral
            // released to borrower. We don't track exact amounts here — the
            // funds-conservation invariant reads balances directly.
        } catch {}
    }

    /// @notice Borrower makes a partial repayment.
    function repayPartial(uint256 loanIdx, uint256 amount) external {
        callCount["repayPartial"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        amount = bound(amount, 1 ether, L.principal);
        if (ERC20Mock(L.principalAsset).balanceOf(L.borrower) < amount) return;

        vm.prank(L.borrower);
        try RepayFacet(diamond).repayPartial(loanId, amount) {} catch {}
    }

    /// @notice Borrower tops up collateral on an active loan.
    function addCollateral(uint256 loanIdx, uint256 amount) external {
        callCount["addCollateral"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        amount = bound(amount, 1 ether, 50 ether);
        if (ERC20Mock(L.collateralAsset).balanceOf(L.borrower) < amount) return;

        vm.prank(L.borrower);
        try AddCollateralFacet(diamond).addCollateral(loanId, amount) {
            ghostDeposits[L.collateralAsset] += amount;
        } catch {}
    }

    /// @notice Warps time forward and attempts default trigger past the grace window.
    function triggerDefault(uint256 loanIdx) external {
        callCount["triggerDefault"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active) return;

        // Jump past duration + generous grace so the call has a chance to
        // land. Only warp FORWARD — an absolute warp could rewind the clock
        // relative to other handler calls and retroactively violate timing
        // invariants on previously-defaulted long-duration loans.
        uint256 target = L.startTime + L.durationDays * 1 days + 30 days;
        if (target > block.timestamp) vm.warp(target);

        try DefaultedFacet(diamond).triggerDefault(loanId) {} catch {}
    }

    /// @notice Lender claims on a defaulted / fallback-pending loan.
    function claimAsLender(uint256 loanIdx) external {
        callCount["claimAsLender"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (ghostClaimedLender[loanId]) return;

        vm.prank(L.lender);
        try ClaimFacet(diamond).claimAsLender(loanId) {
            ghostClaimedLender[loanId] = true;
        } catch {}
    }

    /// @notice Borrower claims repaid collateral.
    function claimAsBorrower(uint256 loanIdx) external {
        callCount["claimAsBorrower"]++;
        if (loanIds.length == 0) return;
        uint256 idx = bound(loanIdx, 0, loanIds.length - 1);
        uint256 loanId = loanIds[idx];

        LibVaipakam.Loan memory L = _getLoan(loanId);
        if (ghostClaimedBorrower[loanId]) return;

        vm.prank(L.borrower);
        try ClaimFacet(diamond).claimAsBorrower(loanId) {
            ghostClaimedBorrower[loanId] = true;
        } catch {}
    }

    /// @notice Time jump only — lets fuzz sequences interleave age without a state change.
    function warp(uint256 delta) external {
        callCount["warp"]++;
        delta = bound(delta, 1 hours, 30 days);
        vm.warp(block.timestamp + delta);
    }

    // ── Accessors for invariant suites ──────────────────────────────────

    function loanIdsLength() external view returns (uint256) {
        return loanIds.length;
    }

    function loanIdAt(uint256 i) external view returns (uint256) {
        return loanIds[i];
    }

    function lenderOfferIdsLength() external view returns (uint256) {
        return lenderOfferIds.length;
    }

    function borrowerOfferIdsLength() external view returns (uint256) {
        return borrowerOfferIds.length;
    }

    // ── Internals ──────────────────────────────────────────────────────

    function _getLoan(uint256 loanId) internal view returns (LibVaipakam.Loan memory L) {
        L = LoanFacet(diamond).getLoanDetails(loanId);
    }

    function _popOfferAt(uint256[] storage arr, uint256 idx) internal {
        uint256 last = arr.length - 1;
        if (idx != last) arr[idx] = arr[last];
        arr.pop();
    }
}
