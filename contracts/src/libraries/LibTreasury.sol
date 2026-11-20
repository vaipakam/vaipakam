// src/libraries/LibTreasury.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IBeacon} from "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import {LibVaipakam} from "./LibVaipakam.sol";

/// @notice The one read the treasury needs from the vault code: the
///         immutable `TREASURY` endpoint every vault implementation fixes
///         at construction (#3431).
interface IVaultTreasuryEndpoint {
    function TREASURY() external view returns (address);
}

/// @title LibTreasury
/// @notice Where the protocol treasury is, read from the ONE place it is
///         written (#3569, owner decision 2026-11-12, "Vault code only").
/// @dev The treasury is not a Diamond setting. It is the immutable
///      `TREASURY` of the vault implementation, so a vault can only ever
///      pay fees to the address its own code names, and moving the
///      treasury is new vault code registered on the vault beacon, which
///      waits the beacon's code delay like any other code change. There is
///      no setter to call, and no second copy that could disagree.
///
///      Two reads, for two kinds of fee:
///      - {current} is the treasury of the CURRENT beacon implementation.
///        A fee the Diamond moves itself (a payer's wallet pull, or a
///        share the Diamond already holds) goes there.
///      - {ofVault} / {ofUserVault} is the treasury of that vault's OWN
///        code. A fee drawn from a vault goes where that vault's code
///        sends it: a vault pinned to an older version pays that
///        version's treasury until its owner moves it, or until that
///        version is revoked, which moves its pinned vaults onto the
///        current code.
///
///      The accrual is recorded against the address the fee actually went
///      to (`LibFacet.recordTreasuryAccrual`), so the Diamond's
///      `treasuryBalances` count only what reached the Diamond.
library LibTreasury {
    /// @notice No vault code names a treasury yet (no vault beacon, or a
    ///         vault code whose `TREASURY` is zero). A fee is refused
    ///         rather than sent to the zero address.
    error TreasuryUnset();

    /// @dev The treasury of the current vault code; reverts {TreasuryUnset}
    ///      when there is none.
    function current() internal view returns (address t) {
        t = currentOrZero();
        if (t == address(0)) revert TreasuryUnset();
    }

    /// @dev The treasury of the current vault code, or zero when no vault
    ///      beacon is set. For views and for checks that treat "unset" as
    ///      "not the Diamond".
    function currentOrZero() internal view returns (address) {
        address beacon = LibVaipakam.storageSlot().vaultBeacon;
        if (beacon == address(0)) return address(0);
        return IVaultTreasuryEndpoint(IBeacon(beacon).implementation()).TREASURY();
    }

    /// @dev True when the current vault code names the Diamond as the
    ///      treasury (the Diamond-as-treasury deployment mode).
    function isDiamond() internal view returns (bool) {
        return currentOrZero() == address(this);
    }

    /// @notice A Diamond-as-treasury operation was called while the current
    ///         vault code names some other address as the treasury.
    /// @dev Same signature, and so the same selector, as the
    ///      `TreasuryNotDiamond()` the backstop facets declared before #3843.
    error TreasuryNotDiamond();

    /// @dev Reverts {TreasuryNotDiamond} unless the current vault code names
    ///      the Diamond as the treasury. The Diamond-as-treasury operations
    ///      act on treasury funds the Diamond holds, so they need it (#3569).
    ///      Shared by `BackstopFacet` and `BackstopAbsorbFacet` (#3843).
    function requireDiamond() internal view {
        if (!isDiamond()) revert TreasuryNotDiamond();
    }

    /// @dev The treasury `vault`'s own code pays fees to. Reverts
    ///      {TreasuryUnset} for a missing vault or a zero endpoint.
    function ofVault(address vault) internal view returns (address t) {
        if (vault == address(0)) revert TreasuryUnset();
        t = IVaultTreasuryEndpoint(vault).TREASURY();
        if (t == address(0)) revert TreasuryUnset();
    }

    /// @dev {ofVault} for `user`'s vault.
    function ofUserVault(address user) internal view returns (address) {
        return ofVault(LibVaipakam.storageSlot().userVaipakamVaults[user]);
    }
}
