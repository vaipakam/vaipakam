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
 *         `ProfileFacet.isSanctionedAddress` / `isRecipientBarred` selectors. The
 *         diamond routes each selector through its fallback to `ProfileFacet`. Used
 *         by `CollateralListingExecutor` to RE-screen a prepay-listing fill's
 *         recipients at fill time (#825-r3), since a recipient clean at sign time
 *         could be flagged before the order fills.
 */
interface IVaipakamSanctionsView {
    /// @notice Fail-OPEN oracle screen (returns false when the oracle is unset /
    ///         reverts). Retained for callers that want the raw oracle read.
    function isSanctionedAddress(address who) external view returns (bool);

    /// @notice #1144 (S10 Invariant B) — the registry-aware, outage-hardened
    ///         "barred from this fill?" read (`ProfileFacet.isRecipientBarred`).
    ///         Bars on an authoritative `Flagged` read, and — during a genuine
    ///         oracle outage (oracle set but unreachable) — on a COMMITTED
    ///         `sanctionsConfirmedFlagged` marker. A disabled regime (no oracle) or
    ///         an oracle-up-clean wallet is NOT barred by a stale marker, so this is
    ///         the safe fail-closed backstop for the at-fill recipient screen.
    function isRecipientBarred(address who) external view returns (bool);
}
