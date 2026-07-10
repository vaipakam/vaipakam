// src/seaport/IVaipakamSanctionsView.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IVaipakamSanctionsView
 * @author Vaipakam Developer Team
 * @notice Minimal call-shape interface for the Vaipakam diamond's read-only
 *         sanctions screen (`ProfileFacet.isSanctionedAddress`, which proxies
 *         `LibVaipakam.isSanctionedAddress` — fail-open when the oracle is
 *         unset, never reverts).
 * @dev    Standalone on purpose: no facet `is IVaipakamSanctionsView`, so adding
 *         it can't force a facet abstract or collide with the existing
 *         `ProfileFacet.isSanctionedAddress` / `isSanctionsConfirmedFlagged`
 *         selectors. The diamond routes each selector through its fallback to
 *         `ProfileFacet`. Used by `CollateralListingExecutor` to RE-screen a
 *         prepay-listing fill's recipients at fill time (#825-r3), since a
 *         recipient clean at sign time could be flagged before the order fills.
 */
interface IVaipakamSanctionsView {
    /// @notice Fail-OPEN oracle screen (returns false when the oracle is unset /
    ///         reverts). The primary at-fill recipient check.
    function isSanctionedAddress(address who) external view returns (bool);

    /// @notice #1144 (S10 Invariant B) — the COMMITTED `sanctionsConfirmedFlagged`
    ///         registry read (`ProfileFacet.isSanctionsConfirmedFlagged`). The
    ///         fill-time recipient screen ORs this in as the fail-CLOSED backstop:
    ///         a recipient registered by `syncPrepaySale*` / `refreshSanctionsFlag`
    ///         is barred from the fill even while the oracle is unavailable.
    function isSanctionsConfirmedFlagged(address who) external view returns (bool);
}
