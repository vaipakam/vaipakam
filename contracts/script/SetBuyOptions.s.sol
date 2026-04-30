// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {VPFIBuyAdapter} from "../src/token/VPFIBuyAdapter.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title SetBuyOptions
 * @notice One-shot owner-only script that writes a valid LayerZero V2
 *         Type-3 options payload onto the deployed `VPFIBuyAdapter`.
 *
 *         The adapter ships with `buyOptions = bytes("")` from
 *         `DeployVPFIBuyAdapter` (the deploy script defaults the env
 *         var to empty bytes and explicitly notes the operator must
 *         call `setBuyOptions(...)` afterwards). Until that's done,
 *         every `quoteBuy` reverts with `LZ_ULN_InvalidWorkerOptions`
 *         (selector `0x6592671c`) because LayerZero's SendUln302
 *         can't parse the empty payload — and downstream every `buy`
 *         is unreachable. This script is the post-deploy step that
 *         clears that revert.
 *
 * @dev Owner-only on the adapter (`Ownable2StepUpgradeable`). Must
 *      be broadcast by the address recorded as `VPFI_OWNER` at deploy
 *      time. The script pre-flight-checks `adapter.owner()` so a
 *      mis-keyed run fails locally with an explicit message rather
 *      than reverting on-chain with an opaque revert.
 *
 *      Required env vars:
 *        - PRIVATE_KEY         : OApp owner key for this chain.
 *
 *      Optional env vars (with sensible defaults):
 *        - LZ_RECEIVE_GAS      : gas allotted to the destination
 *                                executor for `_lzReceive`. Default
 *                                200_000 (matches `BridgeVPFI.s.sol`).
 *        - LZ_RECEIVE_VALUE    : native-drop msg.value forwarded with
 *                                the lzReceive call. Default 0 — the
 *                                BUY_REQUEST → BUY_RESPONSE round-trip
 *                                doesn't need a native drop.
 *
 *      Reads `Deployments.readVPFIBuyAdapter()` so it picks up the
 *      adapter address from `deployments/<chain>/addresses.json`
 *      automatically (with `<CHAIN>_VPFI_BUY_ADAPTER_ADDRESS` env
 *      fallback per the standard `Deployments` convention).
 *
 *      Idempotent — safe to re-run with a different gas budget if
 *      the destination's `_lzReceive` cost changes. Emits
 *      `BuyOptionsSet(newOptions)` on every call.
 */
contract SetBuyOptions is Script {
    using OptionsBuilder for bytes;

    function run() external {
        uint256 ownerKey = vm.envUint("PRIVATE_KEY");
        address broadcaster = vm.addr(ownerKey);

        address adapterAddr = Deployments.readVPFIBuyAdapter();
        require(
            adapterAddr != address(0),
            "SetBuyOptions: adapter address not found in deployments artifact"
        );
        VPFIBuyAdapter adapter = VPFIBuyAdapter(payable(adapterAddr));

        // Pre-flight: confirm broadcaster matches `adapter.owner()`.
        // The setter is `onlyOwner` so a mismatch reverts on-chain
        // with an `OwnableUnauthorizedAccount` selector — fail loud
        // here instead.
        address currentOwner = adapter.owner();
        require(
            broadcaster == currentOwner,
            string.concat(
                "SetBuyOptions: broadcaster ",
                vm.toString(broadcaster),
                " is not adapter owner ",
                vm.toString(currentOwner)
            )
        );

        uint128 lzReceiveGas =
            uint128(vm.envOr("LZ_RECEIVE_GAS", uint256(200_000)));
        uint128 lzReceiveValue =
            uint128(vm.envOr("LZ_RECEIVE_VALUE", uint256(0)));

        // Type-3 options with a single executor `lzReceive` entry.
        // Same shape `BridgeVPFI.s.sol` uses for the OFT `extraOptions`
        // field. SendUln302 parses this on the next `quoteBuy` /
        // `buy` call.
        bytes memory newOptions = OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(lzReceiveGas, lzReceiveValue);

        console.log("=== Set VPFIBuyAdapter buyOptions ===");
        console.log("Chain id:        ", block.chainid);
        console.log("Adapter:         ", adapterAddr);
        console.log("Broadcaster:     ", broadcaster);
        console.log("LZ receive gas:  ", uint256(lzReceiveGas));
        console.log("LZ receive value:", uint256(lzReceiveValue));
        console.log("Encoded length:  ", newOptions.length);

        vm.startBroadcast(ownerKey);
        adapter.setBuyOptions(newOptions);
        vm.stopBroadcast();

        bytes memory readback = adapter.buyOptions();
        require(
            keccak256(readback) == keccak256(newOptions),
            "SetBuyOptions: readback mismatch - tx failed silently?"
        );

        console.log("buyOptions written and readback matches.");
        console.log("Next quoteBuy / buy on this adapter should succeed.");
    }
}
