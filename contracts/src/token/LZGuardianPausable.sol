// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title LZGuardianPausable
 * @author Vaipakam Developer Team
 * @notice Two-role emergency-pause pattern for LayerZero OApp contracts.
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
 *      inheritance-order shifts if the containing OApp's base contracts
 *      ever grow new state across an upgrade.
 */
abstract contract LZGuardianPausable is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable
{
    /// @custom:storage-location erc7201:vaipakam.lz.guardian
    struct GuardianStorage {
        address guardian;
    }

    // keccak256(abi.encode(uint256(keccak256("vaipakam.lz.guardian")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant GUARDIAN_STORAGE_LOCATION =
        0x46c6f95bc7d869e6724c9ffae64aa41d1cc2d352f1599912948531e07bce3700;

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
    event GuardianUpdated(
        address indexed previousGuardian,
        address indexed newGuardian
    );

    /// @notice Reverts when a guardian-gated entry point is called by an
    ///         address that holds neither role.
    error NotGuardianOrOwner(address caller);

    /// @dev Initializer for subclasses. Forwards to `__Pausable_init`; the
    ///      guardian slot stays zero until `setGuardian` is called post-
    ///      deploy (deliberately — a protocol deploying to a new chain
    ///      should explicitly designate its guardian rather than inherit
    ///      the deployer EOA by accident).
    function __LZGuardianPausable_init() internal onlyInitializing {
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
    ///      `pause()` in the concrete OApps; intentionally NOT applied to
    ///      `unpause()` — see contract-level docstring for the rationale.
    modifier onlyGuardianOrOwner() {
        address g = _getGuardianStorage().guardian;
        if (msg.sender != g && msg.sender != owner()) {
            revert NotGuardianOrOwner(msg.sender);
        }
        _;
    }
}
