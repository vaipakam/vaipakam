// script/utils/DeployGnosisSafe.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";

/**
 * @title DeployGnosisSafe
 * @author Vaipakam Developer Team
 * @notice T-086 Round-5 Block A (#313) — testnet / Anvil rehearsal
 *         helper that deploys a 1-of-1 Gnosis Safe with the dev
 *         EOA as the single signer. Used by
 *         `script/multicallDeploy.s.sol` per the Round-5.1 errata
 *         §16 A.10.
 *
 *         The script expects three pre-deployed Safe addresses
 *         (recorded in `contracts/deployments/<chain>/external.json`):
 *           - `safeProxyFactory` — `SafeProxyFactory` per chain
 *           - `safeSingleton`    — `Safe` (a.k.a. GnosisSafe) singleton / MasterCopy
 *           - `safeFallbackHandler` — `CompatibilityFallbackHandler`
 *
 *         For Anvil rehearsals (where there is no canonical Safe
 *         deployment yet), the operator MUST first deploy the
 *         Safe kit locally and record the addresses in the local
 *         `external.json`. The canonical kit-deployment script
 *         lives at `safe-global/safe-deployments` (off-repo);
 *         we don't reproduce it here — it's the same set of
 *         deterministic bytecodes the chain canonical addresses
 *         resolve to.
 *
 *         Mainnet + supported testnet operators just record the
 *         canonical addresses (see https://github.com/safe-global/
 *         safe-deployments/blob/main/src/assets/v1.4.1/).
 */
interface ISafeProxyFactory {
    function createProxyWithNonce(
        address singleton,
        bytes calldata initializer,
        uint256 saltNonce
    ) external returns (address proxy);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

contract DeployGnosisSafe is Script {
    /// @notice Deploy a 1-of-1 Safe with `singleSigner` as the
    ///         single owner. Returns the deployed proxy address.
    ///
    ///         Use the result as the Diamond owner +
    ///         executor owner before submitting the atomic
    ///         diamondCut + UUPS upgrade payload via
    ///         `Safe.execTransaction` with
    ///         `Operation.DelegateCall` → MultiSend.
    ///
    /// @param  safeProxyFactory The canonical `SafeProxyFactory`
    ///                          address for the chain (from
    ///                          `external.json`).
    /// @param  safeSingleton    The canonical `Safe` singleton (a.k.a.
    ///                          GnosisSafe MasterCopy) address. Without
    ///                          this, `createProxyWithNonce` would point
    ///                          the proxy at `address(0)` or a wrong
    ///                          implementation → broken Safe.
    /// @param  fallbackHandler  The canonical
    ///                          `CompatibilityFallbackHandler` address —
    ///                          optional for the multicall flow but
    ///                          commonly needed for any downstream
    ///                          EIP-1271 / EIP-712 surface on the Safe.
    /// @param  singleSigner     The dev EOA that will sign the Safe's
    ///                          `execTransaction`. For mainnet, the
    ///                          full multisig signer set goes here
    ///                          (1-of-1 is the rehearsal shape).
    /// @param  saltNonce        Salt for deterministic deployment.
    function run(
        address safeProxyFactory,
        address safeSingleton,
        address fallbackHandler,
        address singleSigner,
        uint256 saltNonce
    ) external returns (address safeProxy) {
        address[] memory owners = new address[](1);
        owners[0] = singleSigner;

        // Safe setup payload: 1-of-1 with the dev EOA, no
        // delegated init call (`to`/`data`/`paymentToken`/...
        // all zero), the canonical fallback handler.
        bytes memory initializer = abi.encodeCall(
            ISafe.setup,
            (
                owners,
                1,                              // threshold = 1-of-1
                address(0),                     // to (no delegated init)
                hex"",                           // data
                fallbackHandler,                // fallbackHandler
                address(0),                     // paymentToken
                0,                              // payment
                payable(address(0))             // paymentReceiver
            )
        );

        vm.startBroadcast();
        safeProxy = ISafeProxyFactory(safeProxyFactory).createProxyWithNonce(
            safeSingleton,
            initializer,
            saltNonce
        );
        vm.stopBroadcast();
    }
}
