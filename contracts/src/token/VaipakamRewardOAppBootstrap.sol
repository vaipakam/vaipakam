// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title VaipakamRewardOAppBootstrap
/// @notice Chain-agnostic UUPS implementation used only as the initial
///         impl for the deterministic `VaipakamRewardOApp` proxy.
/// @dev Deployment shape across chains:
///
///        1. Deploy this bootstrap via the Singleton CREATE2 factory with a
///           shared salt → same bootstrap address on every chain (since it
///           has no constructor args, its init code is byte-identical).
///        2. Deploy `ERC1967Proxy(bootstrap, bytes(""))` via the Singleton
///           CREATE2 factory with a shared salt → same proxy address on
///           every chain (the proxy's init code embeds the bootstrap
///           address, which is identical by step 1).
///        3. Deploy the REAL `VaipakamRewardOApp` impl with the chain's
///           LZ endpoint constructor arg. This IS chain-specific.
///        4. Atomically call `upgradeToAndCall(realImpl, initCalldata)` on
///           the proxy in the SAME script run, installing the real impl
///           and running its `initialize` in one tx.
///
///      The `_authorizeUpgrade` override below is permissionless. This is
///      safe only because steps 1–4 happen atomically in one script run,
///      so the proxy is never exposed to a public chain in its
///      pre-upgrade state. If you deploy this proxy and DO NOT upgrade
///      it in the same script run, a front-running attacker could
///      upgrade it to their own impl before you get a chance — so
///      **always** pair the bootstrap deploy with the upgrade-and-init
///      call inside a single script transaction (or a single multisig
///      batch if deployed via governance).
///
///      This contract intentionally has zero state and zero
///      initialization — all state lives in the real
///      `VaipakamRewardOApp` impl installed in step 4.
contract VaipakamRewardOAppBootstrap is UUPSUpgradeable {
    /// @dev Permissionless upgrade authority. Acceptable only because
    ///      the bootstrap proxy must be upgraded inside the same
    ///      atomic deployment batch as its creation. See contract-level
    ///      NatSpec above.
    function _authorizeUpgrade(address) internal override {}
}
