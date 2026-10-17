// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ISanctionsList} from "../interfaces/ISanctionsList.sol";

/**
 * @title  ComposedSanctionsList
 * @notice The one composition rule every Vaipakam-operated sanctions list
 *         follows: an address is sanctioned when the list's OWN record flags
 *         it, OR when an optional, immutable SECONDARY sanctions oracle
 *         reports it.
 *
 * @dev    #2443. Two concrete lists share this base so that the rule —
 *         including what happens when the secondary cannot be read — is
 *         written once:
 *
 *         - `SanctionsList`, the mainnet-capable list: Vaipakam's own record
 *           of OFAC SDN digital-currency addresses, kept by an updater role,
 *           optionally over RedStone's Sanctions Oracle where it is deployed.
 *         - `TestnetSanctionsOverlay` (#2439), the testnet-only list: the
 *           network admin's test flags, optionally over another list.
 *
 *         What differs between them — who may write the own record, what an
 *         update records, where the contract may be deployed, and what each
 *         names its getters — stays in the concrete contracts. In particular
 *         each keeps its own public getter names, so an off-chain reader can
 *         tell a test list (`upstream()`) from the production list
 *         (`secondary()`) without trusting anything but the ABI.
 *
 *         **Secondary failure propagates; it is never swallowed here.** For an
 *         address the own record does NOT flag, `isSanctioned` returns the
 *         secondary's answer and lets a secondary revert propagate unchanged.
 *         The Diamond wraps every oracle read in `try`, and it — not the list
 *         — decides what an unreadable answer means: its fail-open screens
 *         treat it as clean, its fail-closed screens (frozen-proceeds release,
 *         confirmed-flag position moves, recovery) refuse to proceed. Catching
 *         the revert here and answering from the own record alone would turn
 *         every fail-closed screen fail-open during a secondary outage,
 *         silently, which is exactly the kind of unstated posture change the
 *         platform's compliance rules forbid. An address the own record DOES
 *         flag answers `true` without reading the secondary: that flag is a
 *         fact this contract holds, and no outage elsewhere can make it less
 *         true.
 *
 *         The secondary is immutable. A different secondary — or dropping one
 *         that misbehaves — is a different list, deployed and configured on
 *         the Diamond in the open (`setSanctionsOracle` emits), never a silent
 *         change under an address the Diamond already trusts.
 */
abstract contract ComposedSanctionsList is ISanctionsList {
    /// @dev The secondary oracle, or `address(0)` when there is none.
    ISanctionsList internal immutable _secondary;

    /// @param secondary_  The oracle to OR with the own record, or
    ///                    `address(0)` for none. A non-zero address must have
    ///                    code; the concrete list chooses the revert.
    constructor(address secondary_) {
        if (secondary_ != address(0) && secondary_.code.length == 0) {
            _revertSecondaryHasNoCode(secondary_);
        }
        _secondary = ISanctionsList(secondary_);
    }

    /// @dev Reverts with the concrete list's own error for a code-less
    ///      secondary, so each list keeps its existing error surface.
    function _revertSecondaryHasNoCode(address secondary_) internal pure virtual;

    /// @dev True iff the list's OWN record flags `addr`. Never reads the
    ///      secondary.
    function _flaggedByOwnRecord(address addr) internal view virtual returns (bool);

    /// @inheritdoc ISanctionsList
    /// @dev Own record first; for an address it does not flag, the
    ///      secondary's answer, with a secondary revert propagating — see the
    ///      contract notes for why.
    function isSanctioned(address addr) external view returns (bool) {
        if (_flaggedByOwnRecord(addr)) return true;
        if (address(_secondary) == address(0)) return false;
        return _secondary.isSanctioned(addr);
    }

    /// @dev Which source flags `addr`. Reads the secondary unconditionally,
    ///      so a secondary outage reverts here even for an own-record flag:
    ///      an attribution that could not ask one of its two sources is not
    ///      an attribution. A reader that needs the own record alone reads
    ///      the concrete list's own-record getter, which never touches the
    ///      secondary.
    /// @return byOwnRecord  The own record flags it.
    /// @return bySecondary  The secondary reports it; always false when there
    ///                      is no secondary.
    function _sanctionSource(address addr) internal view returns (bool byOwnRecord, bool bySecondary) {
        byOwnRecord = _flaggedByOwnRecord(addr);
        bySecondary = address(_secondary) != address(0) && _secondary.isSanctioned(addr);
    }
}
