// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibRiskMath} from "./LibRiskMath.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/**
 * @title LibOfferBounds
 * @author Vaipakam Developer Team
 * @notice Shared floor/ceiling admission bounds for ERC-20-on-both-legs LIQUID
 *         offers, applied identically at offer CREATE, offer MUTATE, and
 *         internal-match slice materialization (#998 S15 / #900).
 *
 *         Before this, the create-time floor/ceiling check was gated behind the
 *         now-dead `rangeAmountEnabled` flag and had NO mutate/slice
 *         counterpart, so (a) a mutate could move an offer into a shape
 *         `createOffer` would reject, and (b) in the live (flag-off) config the
 *         bound was enforced nowhere — admission was left entirely to the
 *         loan-init HF gate. This library re-homes the bound as one definition
 *         keyed on the offer actually being liquid-both-legs ERC-20 (NOT the
 *         dead flag), enforced at every write surface.
 *
 *         Two layers so the non-reverting preview API
 *         (`LibOfferMatch.previewIntent`, which returns structured `IntentError`
 *         codes and must never revert) can share the same math:
 *           • {checkOfferBounds} — view, returns `(ok, BoundsFail)`; never
 *             reverts. The match/preview path maps `BoundsFail` → `IntentError`.
 *           • {assertOfferBounds} — reverting wrapper for create/mutate
 *             (`MinCollateralBelowFloor` / `MaxLendingAboveCeiling`).
 */
library LibOfferBounds {
    /// @dev Reason an offer failed the shared bounds check (non-reverting core).
    enum BoundsFail {
        None, // within bounds, or no bound applies
        CollateralBelowFloor, // lender-side: required collateral < floor
        LendingAboveCeiling // borrower-side: amountMax > ceiling
    }

    /// @notice Lender's required collateral is below the system-derived floor
    ///         for its worst-case lending size.
    error MinCollateralBelowFloor(uint256 provided, uint256 floor);
    /// @notice Borrower's accepted lending ceiling exceeds the system-derived
    ///         ceiling implied by the collateral they will lock.
    error MaxLendingAboveCeiling(uint256 provided, uint256 ceiling);

    /**
     * @notice Non-reverting bounds check. Returns `(true, None)` when no bound
     *         applies — a non-ERC-20 leg, an illiquid leg, or a shape within
     *         bounds. Only liquid-both-legs ERC-20 offers are bounded (matches
     *         the runtime HF gate's scope; NFT rentals + illiquid pairs go
     *         through different gates, incl. `LoanFacet`'s mutual-consent path).
     * @param isLender            true = Lender offer (floor on required
     *                            collateral); false = Borrower offer (ceiling on
     *                            accepted lending).
     * @param assetType           principal-leg asset type.
     * @param collateralAssetType collateral-leg asset type.
     * @param amountMax           worst-case lending size (lender/borrower).
     * @param collateralAmount    lender's required collateral (floor check).
     * @param borrowerCollMax     borrower's collateral max (ceiling check).
     * @param lendingAsset        principal ERC-20.
     * @param collateralAsset     collateral ERC-20.
     * @param skipCeiling         exempt the borrower-side ceiling — the
     *                            protocol-authored lender-sale vehicle mimics a
     *                            Borrower offer with `collateralAmount == 0` (the
     *                            real collateral stays on the linked live loan).
     */
    function checkOfferBounds(
        bool isLender,
        LibVaipakam.AssetType assetType,
        LibVaipakam.AssetType collateralAssetType,
        uint256 amountMax,
        uint256 collateralAmount,
        uint256 borrowerCollMax,
        address lendingAsset,
        address collateralAsset,
        bool skipCeiling
    ) internal view returns (bool ok, BoundsFail fail) {
        // ── Keying: ERC-20-on-both-legs, LIQUID-on-both-legs only. ──────────
        if (
            assetType != LibVaipakam.AssetType.ERC20 ||
            collateralAssetType != LibVaipakam.AssetType.ERC20
        ) {
            return (true, BoundsFail.None);
        }
        OracleFacet oracle = OracleFacet(address(this));
        if (
            oracle.checkLiquidity(lendingAsset) != LibVaipakam.LiquidityStatus.Liquid ||
            oracle.checkLiquidity(collateralAsset) != LibVaipakam.LiquidityStatus.Liquid
        ) {
            return (true, BoundsFail.None);
        }

        if (isLender) {
            // Tiered tier-0 no-borrow: a lender offer against effective-tier-0
            // collateral can never fill — loan-init rejects any positive LTV
            // when `effectiveTierMaxInitLtvBps(0) == 0`. `LibRiskMath` returns a
            // finite HF-derived floor for a liquid tier-0 asset (the LTV-cap
            // clamp is skipped when the cap is 0), so we must reject explicitly
            // here to keep create/mutate parity with init admission.
            if (noBorrowCollateral(collateralAsset)) {
                return (false, BoundsFail.CollateralBelowFloor);
            }
            uint256 floor = LibRiskMath.minCollateralForLending(
                amountMax,
                lendingAsset,
                collateralAsset
            );
            if (floor > 0 && collateralAmount < floor) {
                return (false, BoundsFail.CollateralBelowFloor);
            }
        } else {
            if (skipCeiling) return (true, BoundsFail.None); // sale vehicle
            if (noBorrowCollateral(collateralAsset)) {
                return (false, BoundsFail.LendingAboveCeiling);
            }
            uint256 ceiling = LibRiskMath.maxLendingForCollateral(
                borrowerCollMax,
                lendingAsset,
                collateralAsset
            );
            if (ceiling != type(uint256).max && amountMax > ceiling) {
                return (false, BoundsFail.LendingAboveCeiling);
            }
        }
        return (true, BoundsFail.None);
    }

    /**
     * @notice Reverting wrapper for the create/mutate write paths. Reverts
     *         `MinCollateralBelowFloor` / `MaxLendingAboveCeiling` on a failed
     *         bound; returns silently otherwise.
     */
    function assertOfferBounds(
        bool isLender,
        LibVaipakam.AssetType assetType,
        LibVaipakam.AssetType collateralAssetType,
        uint256 amountMax,
        uint256 collateralAmount,
        uint256 borrowerCollMax,
        address lendingAsset,
        address collateralAsset,
        bool skipCeiling
    ) internal view {
        (bool ok, BoundsFail fail) = checkOfferBounds(
            isLender,
            assetType,
            collateralAssetType,
            amountMax,
            collateralAmount,
            borrowerCollMax,
            lendingAsset,
            collateralAsset,
            skipCeiling
        );
        if (ok) return;
        if (fail == BoundsFail.CollateralBelowFloor) {
            // Re-derive the floor for the revert payload. For a tiered tier-0
            // reject the finite HF floor is shown (the collateral is below the
            // effective admission bound either way).
            uint256 floor = LibRiskMath.minCollateralForLending(
                amountMax,
                lendingAsset,
                collateralAsset
            );
            revert MinCollateralBelowFloor(collateralAmount, floor);
        } else {
            // Tiered tier-0 reject surfaces ceiling 0 (no borrow); otherwise the
            // HF/LTV-derived ceiling.
            uint256 ceiling = noBorrowCollateral(collateralAsset)
                ? 0
                : LibRiskMath.maxLendingForCollateral(
                    borrowerCollMax,
                    lendingAsset,
                    collateralAsset
                );
            revert MaxLendingAboveCeiling(amountMax, ceiling);
        }
    }

    /// @dev True when the collateral admits NO new borrow at loan-init, so an
    ///      offer against it can never become a loan and must be rejected
    ///      fail-fast at create/mutate. Mirrors `LoanFacet._checkInitialLtvAndHf`,
    ///      whose effective cap is `min(per-asset loanInitMaxLtvBps, tier cap)`:
    ///        • per-asset `loanInitMaxLtvBps == 0` (unconfigured / explicit
    ///          no-borrow) rejects any positive LTV in BOTH modes (non-tiered
    ///          `ltv > 0` reverts `LTVExceeded`; tiered `min(0, tierCap) == 0`);
    ///        • in the depth-tiered regime an effective tier-0 collateral
    ///          (`effectiveTierMaxInitLtvBps == 0`) likewise admits no borrow.
    ///      `LibRiskMath`'s LTV clamp skips a `capBps == 0` and returns a finite
    ///      HF-derived bound, so without this guard create/mutate would admit
    ///      offers acceptance always rejects (Codex #1101 P2).
    /// @dev `internal` (not `private`) so the non-reverting intent preview
    ///      (`LibOfferMatch.previewIntent`) can mirror the SAME no-borrow guard
    ///      in its lean slice check — closing the preview-vs-materialize
    ///      divergence for tier-0 collateral (#1104). Enabled by the
    ///      RiskAccessFacet→RiskPreviewFacet split's freed EIP-170 headroom.
    function noBorrowCollateral(address collateralAsset) internal view returns (bool) {
        if (
            LibVaipakam.storageSlot().assetRiskParams[collateralAsset].loanInitMaxLtvBps == 0
        ) {
            return true;
        }
        if (LibVaipakam.cfgDepthTieredLtvEnabled()) {
            uint8 tier = OracleFacet(address(this)).getEffectiveLiquidityTier(
                collateralAsset
            );
            if (LibVaipakam.effectiveTierMaxInitLtvBps(tier) == 0) return true;
        }
        return false;
    }
}
