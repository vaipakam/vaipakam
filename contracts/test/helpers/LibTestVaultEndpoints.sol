// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {VaultOutflowTypes} from "../../src/vault/VaultOutflowTypes.sol";

/// @title  LibTestVaultEndpoints
/// @notice #3431 — endpoint records for a test-built vault implementation.
library LibTestVaultEndpoints {
    /// @notice No endpoint set: every endpoint class of that vault code is
    ///         closed (a suite that never pays the treasury, a backstop, or a
    ///         marketplace).
    function none() internal pure returns (VaultOutflowTypes.VaultEndpoints memory e) {}
}
