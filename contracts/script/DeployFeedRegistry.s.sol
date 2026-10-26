// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {FeedRegistryDeployment} from "./lib/FeedRegistryDeployment.sol";

/**
 * @title  DeployFeedRegistry
 * @notice Deploys (or reuses) the chain's `VaipakamFeedRegistry` and records
 *         it as `.feedRegistry` (#2880). The rules are in
 *         {FeedRegistryDeployment}; this is its entry point for the
 *         contracts phase of `deploy-{chain,testnet,mainnet}.sh` and the
 *         Anvil bootstrap, which run it right after the Diamond.
 *
 * @dev    Env: `DEPLOYER_PRIVATE_KEY`, `ADMIN_PRIVATE_KEY`, `PAUSER_ADDRESS`
 *         (required on a production chain), `FEED_REGISTRY_DELAY_SECONDS`
 *         (testnets only, 0 when unset).
 *
 *         Run (dry, then with `--broadcast`):
 *           forge script script/DeployFeedRegistry.s.sol --rpc-url "$RPC" [--broadcast --slow]
 */
contract DeployFeedRegistry is Script {
    function run() external returns (address) {
        return address(FeedRegistryDeployment.deploy(vm.envUint("DEPLOYER_PRIVATE_KEY"), vm.envUint("ADMIN_PRIVATE_KEY")));
    }
}
