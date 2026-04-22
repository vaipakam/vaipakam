// src/facets/AccessControlFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";

/**
 * @title AccessControlFacet
 * @author Vaipakam Developer Team
 * @notice Manages role-based access control for the Vaipakam Diamond.
 * @dev Part of Diamond Standard (EIP-2535). Uses LibAccessControl namespaced storage.
 *      The Diamond owner initializes roles during deployment. DEFAULT_ADMIN_ROLE holders
 *      can grant and revoke all other roles. Individual roles can be renounced by holders.
 */
contract AccessControlFacet is DiamondAccessControl {
    /**
     * @notice Initializes all access control roles for the Diamond owner.
     * @dev Must be called once during diamond deployment (e.g., in DiamondInit).
     *      Guarded by `LibDiamond.enforceIsContractOwner`, so only the Diamond
     *      owner can invoke it. Grants the caller DEFAULT_ADMIN, ADMIN, PAUSER,
     *      KYC_ADMIN, ORACLE_ADMIN, RISK_ADMIN, and ESCROW_ADMIN, and wires
     *      DEFAULT_ADMIN_ROLE as the admin for every other role.
     *
     *      NOTE: not idempotent — re-calling after ownership has transferred
     *      would hand the caller a fresh superset of roles. Keep invocation
     *      strictly at deploy time.
     */
    function initializeAccessControl() external {
        LibDiamond.enforceIsContractOwner();
        LibAccessControl.initializeAccessControl(msg.sender);
    }

    /**
     * @notice Grants a role to an account.
     * @dev Caller must have the admin role for the role being granted.
     * @param role The role to grant.
     * @param account The account to grant the role to.
     */
    function grantRole(
        bytes32 role,
        address account
    ) external onlyRole(LibAccessControl.getRoleAdmin(role)) {
        LibAccessControl.grantRole(role, account);
    }

    /**
     * @notice Revokes a role from an account.
     * @dev Caller must have the admin role for the role being revoked.
     * @param role The role to revoke.
     * @param account The account to revoke the role from.
     */
    function revokeRole(
        bytes32 role,
        address account
    ) external onlyRole(LibAccessControl.getRoleAdmin(role)) {
        LibAccessControl.revokeRole(role, account);
    }

    /**
     * @notice Allows a role holder to renounce their own role.
     * @dev Caller must pass their own address as confirmation.
     * @param role The role to renounce.
     * @param callerConfirmation Must be msg.sender to confirm.
     */
    function renounceRole(bytes32 role, address callerConfirmation) external {
        LibAccessControl.renounceRole(role, callerConfirmation);
    }

    /**
     * @notice Checks if an account has a specific role.
     * @param role The role to check.
     * @param account The account to check.
     * @return True if the account has the role.
     */
    function hasRole(
        bytes32 role,
        address account
    ) external view returns (bool) {
        return LibAccessControl.hasRole(role, account);
    }

    /**
     * @notice Returns the admin role for a given role.
     * @param role The role to query.
     * @return The admin role bytes32.
     */
    function getRoleAdmin(bytes32 role) external view returns (bytes32) {
        return LibAccessControl.getRoleAdmin(role);
    }

    // ─── Emergency Revocation ───────────────────────────────────────────

    /// @notice Emitted by {emergencyRevokeRole} to make incident-response
    ///         actions visible in standard event streams separately from
    ///         routine {revokeRole} traffic.
    /// @param role     The role identifier that was revoked.
    /// @param account  The account that lost the role.
    /// @param revoker  `msg.sender` at the time of the call (the
    ///                 DEFAULT_ADMIN_ROLE holder driving the response).
    /// @param reason   Caller-supplied free-form reason (e.g. "key compromised 2025-03-01").
    event EmergencyRoleRevoked(
        bytes32 indexed role,
        address indexed account,
        address indexed revoker,
        string reason
    );

    /// @dev Caller attempted to revoke DEFAULT_ADMIN_ROLE itself via the
    ///      emergency path; forbidden so a compromised op can't lock
    ///      everyone out of governance. Use the standard ADMIN_ROLE
    ///      setters (Timelock-gated) to rotate DEFAULT_ADMIN deliberately.
    error CannotEmergencyRevokeRootAdmin();

    /**
     * @notice Emergency escape hatch for revoking a role WITHOUT routing
     *         the call through the 48h Timelock that usually gates ADMIN_ROLE.
     * @dev DEFAULT_ADMIN_ROLE-only (by design, DEFAULT_ADMIN is expected to be
     *      held by an ops-multisig that signs incident-response txs directly,
     *      not the Timelock). Emits {EmergencyRoleRevoked} with the caller's
     *      reason string so downstream indexers and audit tooling can
     *      distinguish an urgent revocation from routine role churn.
     *      DEFAULT_ADMIN_ROLE itself cannot be revoked through this path —
     *      rotating the root admin is a governance action that MUST go
     *      through the Timelock-gated grant/revoke on the deployer-handover
     *      script — otherwise a compromised signer could lock the protocol
     *      out of governance.
     * @param role     The role to revoke.
     * @param account  The account to strip `role` from.
     * @param reason   Free-form human-readable reason (surfaces in the
     *                 event + any monitoring pipelines). Keep short; no
     *                 secrets — it's plaintext on-chain.
     */
    function emergencyRevokeRole(
        bytes32 role,
        address account,
        string calldata reason
    ) external onlyRole(LibAccessControl.DEFAULT_ADMIN_ROLE) {
        if (role == LibAccessControl.DEFAULT_ADMIN_ROLE) {
            revert CannotEmergencyRevokeRootAdmin();
        }
        LibAccessControl.revokeRole(role, account);
        emit EmergencyRoleRevoked(role, account, msg.sender, reason);
    }

    // ─── Role Constants (view helpers for off-chain/UI) ──────────────────
    // Mirror the bytes32 role identifiers from LibAccessControl so the
    // frontend / indexers can query them via a stable diamond selector
    // instead of hardcoding hashes.

    /// @notice Root admin role; can grant/revoke every other role.
    /// @return The DEFAULT_ADMIN_ROLE identifier.
    function DEFAULT_ADMIN_ROLE() external pure returns (bytes32) {
        return LibAccessControl.DEFAULT_ADMIN_ROLE;
    }

    /// @notice Holds AdminFacet / ProfileFacet admin privileges
    ///         (treasury, 0x proxy, trade allowances, KYC thresholds).
    /// @return The ADMIN_ROLE identifier.
    function ADMIN_ROLE() external pure returns (bytes32) {
        return LibAccessControl.ADMIN_ROLE;
    }

    /// @notice Authorised to pause/unpause the diamond via AdminFacet.
    /// @return The PAUSER_ROLE identifier.
    function PAUSER_ROLE() external pure returns (bytes32) {
        return LibAccessControl.PAUSER_ROLE;
    }

    /// @notice Authorised to set per-user KYC tier via ProfileFacet.
    /// @return The KYC_ADMIN_ROLE identifier.
    function KYC_ADMIN_ROLE() external pure returns (bytes32) {
        return LibAccessControl.KYC_ADMIN_ROLE;
    }

    /// @notice Reserved for oracle-config management (currently OracleAdminFacet
    ///         setters use LibDiamond owner, but the role is reserved for
    ///         future role-gated oracle admin surfaces).
    /// @return The ORACLE_ADMIN_ROLE identifier.
    function ORACLE_ADMIN_ROLE() external pure returns (bytes32) {
        return LibAccessControl.ORACLE_ADMIN_ROLE;
    }

    /// @notice Authorised to update per-asset risk params via RiskFacet.
    /// @return The RISK_ADMIN_ROLE identifier.
    function RISK_ADMIN_ROLE() external pure returns (bytes32) {
        return LibAccessControl.RISK_ADMIN_ROLE;
    }

    /// @notice Authorised to manage the escrow implementation template and
    ///         mandatory upgrade version via EscrowFactoryFacet.
    /// @return The ESCROW_ADMIN_ROLE identifier.
    function ESCROW_ADMIN_ROLE() external pure returns (bytes32) {
        return LibAccessControl.ESCROW_ADMIN_ROLE;
    }
}
