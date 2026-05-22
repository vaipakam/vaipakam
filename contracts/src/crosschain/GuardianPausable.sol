// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title GuardianPausable
 * @author Vaipakam Developer Team
 * @notice Two-role emergency-pause pattern for Vaipakam's cross-chain
 *         contracts.
 *
 *         This is the provider-neutral pause base for every cross-chain
 *         contract in `contracts/src/crosschain/` (the CCIP messenger,
 *         the VPFI mirror token, the pool rate governor, the buy
 *         adapter/receiver, the reward messenger). Pause semantics are a
 *         cross-chain concern, not a transport-layer one — naming the base
 *         after the transport (as the deleted pre-T-068 `LZGuardianPausable`
 *         did) tied an emergency lever to a vendor that the protocol no
 *         longer uses. The neutral base survives transport swaps unchanged.
 *
 *         Owner (timelock-gated multi-sig) can:
 *           - rotate the guardian,
 *           - pause,
 *           - unpause.
 *         All of these travel the full 48h governance path.
 *
 *         Guardian (a smaller incident-response multi-sig with no timelock)
 *         can only pause. It exists to close the detect-to-freeze gap that
 *         a 48h timelock would otherwise introduce — the April 2026
 *         cross-chain bridge exploit showed that a 46-minute pause blocked
 *         ~$200M of follow-up drain, which would have been impossible
 *         under a timelock-only model.
 *
 *         Unpause is deliberately kept owner-only. A compromised or
 *         impatient guardian must not be able to race the incident team
 *         to re-enable a live contract; recovery goes through governance.
 *
 * @dev Uses ERC-7201 namespaced storage so the guardian slot is immune to
 *      inheritance-order shifts if the containing contract's base
 *      contracts ever grow new state across an upgrade.
 */
abstract contract GuardianPausable is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable
{
    /// @custom:storage-location erc7201:vaipakam.crosschain.guardian
    struct GuardianStorage {
        address guardian;
    }

    // keccak256(abi.encode(uint256(keccak256("vaipakam.crosschain.guardian")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant GUARDIAN_STORAGE_LOCATION =
        0x2fcadf9fe92d2705f396d20ca865111ef4d0ad16b69441736aae3865fde40e00;

    function _getGuardianStorage()
        private
        pure
        returns (GuardianStorage storage $)
    {
        assembly {
            $.slot := GUARDIAN_STORAGE_LOCATION
        }
    }

    /// @notice Emitted whenever the guardian address rotates. Indexed so
    ///         off-chain monitoring can alert on any transition (a silent
    ///         guardian swap during a live incident is itself a red flag).
    /// @custom:event-category informational/admin
    event GuardianUpdated(
        address indexed previousGuardian,
        address indexed newGuardian
    );

    /// @notice Reverts when a guardian-gated entry point is called by an
    ///         address that holds neither role.
    error NotGuardianOrOwner(address caller);

    /// @dev Initializer for subclasses. Forwards to `__Pausable_init`; the
    ///      guardian slot stays zero until `setGuardian` is called post-
    ///      deploy (deliberately — a contract deploying to a new chain
    ///      should explicitly designate its guardian rather than inherit
    ///      the deployer EOA by accident).
    function __GuardianPausable_init() internal onlyInitializing {
        __Pausable_init();
    }

    /// @notice Current guardian address. Zero means "no guardian", in which
    ///         case only the owner (timelock) can pause.
    function guardian() public view returns (address) {
        return _getGuardianStorage().guardian;
    }

    /// @notice Install a new guardian. Owner-only, so this travels the
    ///         timelock. Setting to the zero address disables the
    ///         emergency-pause surface entirely, leaving only owner-side
    ///         pauses — intended for the eventuality of governance
    ///         graduating from Safe+timelock to a fuller DAO where the
    ///         guardian role has been replaced by something else.
    /// @param newGuardian Address to install. Zero is permitted.
    function setGuardian(address newGuardian) external onlyOwner {
        GuardianStorage storage $ = _getGuardianStorage();
        address previous = $.guardian;
        $.guardian = newGuardian;
        emit GuardianUpdated(previous, newGuardian);
    }

    /// @dev Authorizes either the guardian or the owner. Applied to
    ///      `pause()` in the concrete contracts; intentionally NOT applied
    ///      to `unpause()` — see contract-level docstring for the rationale.
    modifier onlyGuardianOrOwner() {
        address g = _getGuardianStorage().guardian;
        if (msg.sender != g && msg.sender != owner()) {
            revert NotGuardianOrOwner(msg.sender);
        }
        _;
    }
}
