// src/libraries/LibAccessControl.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title LibAccessControl
 * @notice Diamond-safe role-based access control using ERC-7201 namespaced storage.
 * @dev Replaces OpenZeppelin's AccessControl inheritance which uses regular storage
 *      slots that collide across facets in a diamond proxy.
 *      Follows the OpenZeppelin AccessControl pattern: roles, admin roles, grant/revoke.
 *      Storage position is derived from keccak256("vaipakam.storage.AccessControl").
 */
library LibAccessControl {
    /// @dev ERC-7201 namespaced storage slot.
    ///      keccak256(abi.encode(uint256(keccak256("vaipakam.storage.AccessControl")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ACCESS_CONTROL_STORAGE_POSITION =
        0xc48a173852129618ce28c4cefb1235c11826e47de4a4b918e1a2ff7ad659ae00;

    // ─── Role Constants ──────────────────────────────────────────────────
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 internal constant KYC_ADMIN_ROLE = keccak256("KYC_ADMIN_ROLE");
    bytes32 internal constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");
    bytes32 internal constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    bytes32 internal constant ESCROW_ADMIN_ROLE = keccak256("ESCROW_ADMIN_ROLE");
    /// @dev Off-chain anomaly-watcher role (Phase 1 follow-up). Granted
    ///      to the Cloudflare Worker / cron EOA that monitors the
    ///      protocol for incident-class anomaly signals (treasury
    ///      drain rate, liquidation spike, etc.) and fires
    ///      `AdminFacet.autoPause(...)` to freeze the protocol for
    ///      `cfgAutoPauseDurationSeconds()` while humans investigate.
    ///      Strictly write-only-pause: the role can call autoPause
    ///      but NOT unpause — admin (PAUSER_ROLE) retains the
    ///      unpause lever, so a compromised watcher's worst case is
    ///      a max-window freeze (capped at 2h via the duration
    ///      ceiling), not indefinite lockup.
    bytes32 internal constant WATCHER_ROLE = keccak256("WATCHER_ROLE");

    struct RoleData {
        mapping(address => bool) hasRole;
        bytes32 adminRole;
    }

    /// @dev APPEND-ONLY POST-LAUNCH. New fields go at the end; never reorder,
    ///      rename, or change types of existing fields on live diamonds.
    struct AccessControlStorage {
        mapping(bytes32 => RoleData) roles;
    }

    // ─── Events ──────────────────────────────────────────────────────────
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole);

    // ─── Errors ──────────────────────────────────────────────────────────
    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);
    error AccessControlBadConfirmation();

    // ─── Storage Access ──────────────────────────────────────────────────

    function _storage() private pure returns (AccessControlStorage storage acs) {
        bytes32 position = ACCESS_CONTROL_STORAGE_POSITION;
        assembly {
            acs.slot := position
        }
    }

    // ─── Core Functions ──────────────────────────────────────────────────

    function hasRole(bytes32 role, address account) internal view returns (bool) {
        return _storage().roles[role].hasRole[account];
    }

    function checkRole(bytes32 role, address account) internal view {
        if (!hasRole(role, account)) {
            revert AccessControlUnauthorizedAccount(account, role);
        }
    }

    function getRoleAdmin(bytes32 role) internal view returns (bytes32) {
        return _storage().roles[role].adminRole;
    }

    function grantRole(bytes32 role, address account) internal {
        if (!hasRole(role, account)) {
            _storage().roles[role].hasRole[account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function revokeRole(bytes32 role, address account) internal {
        if (hasRole(role, account)) {
            _storage().roles[role].hasRole[account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function renounceRole(bytes32 role, address callerConfirmation) internal {
        if (callerConfirmation != msg.sender) {
            revert AccessControlBadConfirmation();
        }
        if (hasRole(role, msg.sender)) {
            _storage().roles[role].hasRole[msg.sender] = false;
            emit RoleRevoked(role, msg.sender, msg.sender);
        }
    }

    function setRoleAdmin(bytes32 role, bytes32 adminRole) internal {
        bytes32 previousAdminRole = getRoleAdmin(role);
        _storage().roles[role].adminRole = adminRole;
        emit RoleAdminChanged(role, previousAdminRole, adminRole);
    }

    /**
     * @notice Initializes access control with the owner as DEFAULT_ADMIN and all sub-roles.
     * @dev Should be called once during diamond initialization (e.g., in DiamondInit).
     *      Grants the owner all administrative roles.
     * @param owner The initial admin/owner address.
     */
    function initializeAccessControl(address owner) internal {
        grantRole(DEFAULT_ADMIN_ROLE, owner);
        grantRole(ADMIN_ROLE, owner);
        grantRole(PAUSER_ROLE, owner);
        grantRole(KYC_ADMIN_ROLE, owner);
        grantRole(ORACLE_ADMIN_ROLE, owner);
        grantRole(RISK_ADMIN_ROLE, owner);
        grantRole(ESCROW_ADMIN_ROLE, owner);
        // WATCHER_ROLE was previously declared but never granted at init —
        // see Findings 00010. Without this grant `AdminFacet.autoPause`
        // (the always-armed safety net documented in CLAUDE.md) is
        // unreachable on a fresh deploy until governance grants the role
        // explicitly. Granting at init mirrors the rest of the role list
        // and lets `DeployDiamond`'s post-init handover loop transfer it
        // to the operator's admin EOA the same way every other role gets
        // transferred. If a deploy doesn't want WATCHER on the deployer
        // EOA, the handover loop renounces it from the deployer at the
        // end of step 6 just like every other role.
        grantRole(WATCHER_ROLE, owner);

        // Set DEFAULT_ADMIN_ROLE as admin for all roles
        setRoleAdmin(ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(PAUSER_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(KYC_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(ORACLE_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(RISK_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(ESCROW_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(WATCHER_ROLE, DEFAULT_ADMIN_ROLE);
    }

    /**
     * @notice Canonical list of every role this library defines that
     *         should be granted to the initial owner at init time AND
     *         transferred to the operator-admin during deploy handover.
     * @dev Single source of truth that closes the drift hazard called
     *      out in Findings 00010 — when a new role is added to the
     *      library and to `initializeAccessControl` but missed in
     *      `DeployDiamond`'s handover array (or vice-versa), the deploy
     *      ships a Diamond where the role is unowned (or stays on the
     *      deployer post-handover). Both sites should now consume this
     *      list. Tests assert the library's grants match this list.
     *      `DEFAULT_ADMIN_ROLE` is the first entry — handover code that
     *      renounces in reverse keeps DEFAULT_ADMIN until last so an
     *      earlier-step revert leaves the deployer recoverable.
     */
    function grantableRoles() internal pure returns (bytes32[] memory) {
        bytes32[] memory roles = new bytes32[](8);
        roles[0] = DEFAULT_ADMIN_ROLE;
        roles[1] = ADMIN_ROLE;
        roles[2] = PAUSER_ROLE;
        roles[3] = KYC_ADMIN_ROLE;
        roles[4] = ORACLE_ADMIN_ROLE;
        roles[5] = RISK_ADMIN_ROLE;
        roles[6] = ESCROW_ADMIN_ROLE;
        roles[7] = WATCHER_ROLE;
        return roles;
    }
}

/**
 * @dev Thin abstract contract providing the onlyRole modifier
 *      backed by LibAccessControl's namespaced storage. Has zero state
 *      variables, so it's safe to inherit in diamond facets without
 *      storage collisions.
 */
abstract contract DiamondAccessControl {
    modifier onlyRole(bytes32 role) {
        LibAccessControl.checkRole(role, msg.sender);
        _;
    }
}
