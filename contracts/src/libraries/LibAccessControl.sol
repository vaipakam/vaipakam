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

        // Set DEFAULT_ADMIN_ROLE as admin for all roles
        setRoleAdmin(ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(PAUSER_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(KYC_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(ORACLE_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(RISK_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        setRoleAdmin(ESCROW_ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
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
