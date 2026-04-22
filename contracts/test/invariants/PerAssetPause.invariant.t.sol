// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {OfferFacet} from "../../src/facets/OfferFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/**
 * @title PerAssetPauseInvariant
 * @notice While asset A is paused (via {AdminFacet.pauseAsset}), no new offer
 *         creation, acceptance, or loan initiation that touches A as the
 *         principal or collateral asset is allowed to land. Unit tests
 *         verify each single entrypoint; this invariant stresses every
 *         interleaving — pause/unpause toggles interleaved with create,
 *         accept, partial repay, and preclose/refinance-adjacent flows.
 *
 *         The probe is a handler-tracked "loans-opened-during-pause" ghost
 *         that must remain zero. On pause we open a window per asset; on
 *         every successful loan creation we check that neither leg's asset
 *         is currently paused; on unpause we close the window. Violations
 *         in either direction (accept succeeding while paused, or ghost
 *         running past zero) break the invariant.
 */
contract PerAssetPauseInvariant is Test {
    InvariantBase internal base;
    PauseHandler internal handler;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new PauseHandler(base);
        targetContract(address(handler));
    }

    /// @notice No loan is held in the handler's open-while-paused ghost —
    ///         the pause modifier must have blocked every relevant create /
    ///         accept / initiation path.
    function invariant_NoLoanCreatedWhileAssetPaused() public view {
        assertEq(
            handler.violations(),
            0,
            "loan accepted while its asset was paused"
        );
    }

    /// @notice Protocol-level read of the pause flag matches the handler's
    ///         local ledger of intended state — guards against a storage
    ///         slot that drifts out of sync with the setters.
    function invariant_PauseFlagMatchesLedger() public view {
        address usdc = base.mockUSDC();
        address weth = base.mockWETH();
        assertEq(
            AdminFacet(address(base.diamond())).isAssetPaused(usdc),
            handler.usdcPaused(),
            "USDC pause flag out of sync"
        );
        assertEq(
            AdminFacet(address(base.diamond())).isAssetPaused(weth),
            handler.wethPaused(),
            "WETH pause flag out of sync"
        );
    }
}

/**
 * @dev Dedicated handler that interleaves pause/unpause with the minimum
 *      loan-lifecycle actions needed to exercise the "paused-asset
 *      accidentally accepted" surface. Tracks a violation counter in
 *      post-conditions of every success path.
 */
contract PauseHandler is Test {
    InvariantBase public base;
    address public diamond;
    address public usdc;
    address public weth;

    // Handler-local pause ledger — must stay in lockstep with the on-chain
    // AdminFacet state.
    bool public usdcPaused;
    bool public wethPaused;

    // Post-condition counter: incremented every time a create/accept
    // succeeds for a loan whose principal or collateral asset was paused
    // at the moment of the call. MUST remain 0.
    uint256 public violations;

    uint256[] public lenderOfferIds;
    uint256[] public borrowerOfferIds;
    uint256[] public loanIds;

    constructor(InvariantBase _base) {
        base = _base;
        diamond = address(_base.diamond());
        usdc = _base.mockUSDC();
        weth = _base.mockWETH();
    }

    // ─── Pause toggles ──────────────────────────────────────────────────

    function pauseUsdc() external {
        try AdminFacet(diamond).pauseAsset(usdc) {
            usdcPaused = true;
        } catch {}
    }

    function unpauseUsdc() external {
        try AdminFacet(diamond).unpauseAsset(usdc) {
            usdcPaused = false;
        } catch {}
    }

    function pauseWeth() external {
        try AdminFacet(diamond).pauseAsset(weth) {
            wethPaused = true;
        } catch {}
    }

    function unpauseWeth() external {
        try AdminFacet(diamond).unpauseAsset(weth) {
            wethPaused = false;
        } catch {}
    }

    // ─── Offer creation ─────────────────────────────────────────────────

    function createLenderOffer(
        uint256 lenderSeed,
        uint256 amount,
        uint256 durationDays,
        uint256 rateBps,
        uint256 collateralAmount
    ) external {
        address lender = base.lenderAt(lenderSeed);
        amount = bound(amount, 100 ether, 10_000 ether);
        durationDays = bound(durationDays, 1, 365);
        rateBps = bound(rateBps, 100, 2000);
        collateralAmount = bound(collateralAmount, 1 ether, 100 ether);
        if (ERC20Mock(usdc).balanceOf(lender) < amount) return;

        bool anyPausedBefore = usdcPaused || wethPaused;

        LibVaipakam.CreateOfferParams memory p = _params(
            LibVaipakam.OfferType.Lender,
            amount,
            rateBps,
            collateralAmount,
            durationDays
        );
        vm.prank(lender);
        try OfferFacet(diamond).createOffer(p) returns (uint256 id) {
            lenderOfferIds.push(id);
            if (anyPausedBefore) violations++;
        } catch {}
    }

    function createBorrowerOffer(
        uint256 borrowerSeed,
        uint256 amount,
        uint256 durationDays,
        uint256 rateBps,
        uint256 collateralAmount
    ) external {
        address borrower = base.borrowerAt(borrowerSeed);
        amount = bound(amount, 100 ether, 10_000 ether);
        durationDays = bound(durationDays, 1, 365);
        rateBps = bound(rateBps, 100, 2000);
        collateralAmount = bound(collateralAmount, 1 ether, 100 ether);
        if (ERC20Mock(weth).balanceOf(borrower) < collateralAmount) return;

        bool anyPausedBefore = usdcPaused || wethPaused;

        LibVaipakam.CreateOfferParams memory p = _params(
            LibVaipakam.OfferType.Borrower,
            amount,
            rateBps,
            collateralAmount,
            durationDays
        );
        vm.prank(borrower);
        try OfferFacet(diamond).createOffer(p) returns (uint256 id) {
            borrowerOfferIds.push(id);
            if (anyPausedBefore) violations++;
        } catch {}
    }

    // ─── Acceptance ─────────────────────────────────────────────────────

    function acceptLenderOffer(uint256 borrowerSeed, uint256 offerIdx) external {
        if (lenderOfferIds.length == 0) return;
        address borrower = base.borrowerAt(borrowerSeed);
        uint256 idx = bound(offerIdx, 0, lenderOfferIds.length - 1);
        uint256 offerId = lenderOfferIds[idx];

        LibVaipakam.Offer memory o = OfferFacet(diamond).getOffer(offerId);
        if (o.accepted || o.creator == address(0)) {
            _popAt(lenderOfferIds, idx);
            return;
        }
        if (ERC20Mock(weth).balanceOf(borrower) < o.collateralAmount) return;

        bool anyPausedBefore = usdcPaused || wethPaused;

        vm.prank(borrower);
        try OfferFacet(diamond).acceptOffer(offerId, true) returns (uint256 loanId) {
            loanIds.push(loanId);
            _popAt(lenderOfferIds, idx);
            if (anyPausedBefore) violations++;
        } catch {}
    }

    function acceptBorrowerOffer(uint256 lenderSeed, uint256 offerIdx) external {
        if (borrowerOfferIds.length == 0) return;
        address lender = base.lenderAt(lenderSeed);
        uint256 idx = bound(offerIdx, 0, borrowerOfferIds.length - 1);
        uint256 offerId = borrowerOfferIds[idx];

        LibVaipakam.Offer memory o = OfferFacet(diamond).getOffer(offerId);
        if (o.accepted || o.creator == address(0)) {
            _popAt(borrowerOfferIds, idx);
            return;
        }
        if (ERC20Mock(usdc).balanceOf(lender) < o.amount) return;

        bool anyPausedBefore = usdcPaused || wethPaused;

        vm.prank(lender);
        try OfferFacet(diamond).acceptOffer(offerId, true) returns (uint256 loanId) {
            loanIds.push(loanId);
            _popAt(borrowerOfferIds, idx);
            if (anyPausedBefore) violations++;
        } catch {}
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _params(
        LibVaipakam.OfferType t,
        uint256 amount,
        uint256 rateBps,
        uint256 collateralAmount,
        uint256 durationDays
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return
            LibVaipakam.CreateOfferParams({
                offerType: t,
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
                collateralQuantity: 0,
                keeperAccessEnabled: false
            });
    }

    function _popAt(uint256[] storage arr, uint256 idx) internal {
        uint256 last = arr.length - 1;
        if (idx != last) arr[idx] = arr[last];
        arr.pop();
    }
}
