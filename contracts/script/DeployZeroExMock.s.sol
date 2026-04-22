// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ZeroExProxyMock} from "../test/mocks/ZeroExProxyMock.sol";

/**
 * @title DeployZeroExMock
 * @notice Testnet-only helper: deploys the `ZeroExProxyMock` and prints its
 *         address so the operator can record it as both `<CHAIN>_ZEROX_PROXY`
 *         and `<CHAIN>_ZEROX_ALLOWANCE_TARGET` before running
 *         `ConfigureOracle.s.sol`. 0x Protocol has no canonical testnet
 *         deployment, so the HF-based liquidation path relies on this mock
 *         for end-to-end testnet runs.
 *
 * @dev DO NOT run on mainnet. The mock trusts `msg.sender` for the swap and
 *      has no authorization — it's explicitly a test double. A guard on
 *      `block.chainid` enforces this: mainnets (1, 8453, 137, 10, 42161)
 *      are refused.
 *
 *      For liquidation tests to actually execute a swap against this mock,
 *      the mock must hold the output token balance ahead of time
 *      (pre-mint / transfer). The Configure step only wires the address;
 *      funding is an operational step per liquidation scenario.
 *
 *      Required env vars:
 *        - PRIVATE_KEY : deployer key
 */
contract DeployZeroExMock is Script {
    function run() external returns (address mock) {
        uint256 chainId = block.chainid;
        require(
            chainId != 1 &&
                chainId != 8453 &&
                chainId != 137 &&
                chainId != 10 &&
                chainId != 42161,
            "DeployZeroExMock: refusing to deploy mock on a production chain"
        );

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        console.log("=== Deploy ZeroExProxyMock (testnet only) ===");
        console.log("Chain id:   ", chainId);

        vm.startBroadcast(deployerKey);
        ZeroExProxyMock proxy = new ZeroExProxyMock();
        vm.stopBroadcast();

        mock = address(proxy);
        console.log("Mock proxy: ", mock);
        console.log(
            "Record as BOTH <CHAIN>_ZEROX_PROXY and <CHAIN>_ZEROX_ALLOWANCE_TARGET before running ConfigureOracle."
        );
    }
}
