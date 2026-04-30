// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {VPFIBuyAdapter} from "../src/token/VPFIBuyAdapter.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployVPFIBuyAdapter
 * @notice Deploys the non-Base {VPFIBuyAdapter} OApp (UUPS proxy) on a
 *         mirror chain (Sepolia, Arb Sepolia, OP Sepolia, Polygon Amoy).
 * @dev Runs ONCE per mirror chain. Must be followed by
 *      {WireVPFIBuyPeers.s.sol} to pair the adapter with the Base
 *      receiver, and typically an owner-only `setBuyOptions` call if
 *      the encoded options couldn't be supplied via env at deploy time.
 *
 *      Required env vars:
 *        - PRIVATE_KEY             : deployer
 *        - VPFI_OWNER              : OApp owner / LZ delegate
 *        - VPFI_BUY_RECEIVER_EID   : LayerZero eid of the Base receiver (40245 for Base Sepolia)
 *        - <CHAIN>_TREASURY_ADDRESS: local treasury that receives released amountIn
 *                                    (falls back to TREASURY_ADDRESS)
 *        - <CHAIN>_VPFI_BUY_PAYMENT_TOKEN : 0x0 for native-ETH chains, WETH for Polygon Amoy
 *                                    (falls back to VPFI_BUY_PAYMENT_TOKEN)
 *        - VPFI_BUY_REFUND_TIMEOUT_SECONDS : seconds before PENDING buy becomes reclaimable
 *                                    (default 900 = 15 min)
 *        - VPFI_BUY_OPTIONS        : hex-encoded LZ options for BUY_REQUEST
 *                                    (optional — when omitted, the script
 *                                    encodes a default Type-3 payload via
 *                                    `OptionsBuilder.addExecutorLzReceive`
 *                                    using LZ_RECEIVE_GAS / LZ_RECEIVE_VALUE
 *                                    so the adapter is buyable end-to-end
 *                                    out of the deploy)
 *        - LZ_RECEIVE_GAS          : default 200_000 — used only when
 *                                    VPFI_BUY_OPTIONS is unset
 *        - LZ_RECEIVE_VALUE        : default 0 — used only when
 *                                    VPFI_BUY_OPTIONS is unset
 *        - LZ_ENDPOINT_<CHAIN>     : LayerZero EndpointV2 on this chain
 *
 *      No follow-up broadcast is needed for buyOptions — the encoded
 *      payload is supplied directly to `initialize(...)`, so the OApp
 *      owner key is only required later if the gas budget needs to
 *      change (then run `SetBuyOptions.s.sol`).
 */
contract DeployVPFIBuyAdapter is Script {
    using OptionsBuilder for bytes;
    function _lzEndpoint() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 11155111) return vm.envAddress("LZ_ENDPOINT_SEPOLIA");
        if (chainId == 421614) return vm.envAddress("LZ_ENDPOINT_ARB_SEPOLIA");
        if (chainId == 11155420) return vm.envAddress("LZ_ENDPOINT_OP_SEPOLIA");
        if (chainId == 80002) return vm.envAddress("LZ_ENDPOINT_POLYGON_AMOY");
        if (chainId == 97) return vm.envAddress("LZ_ENDPOINT_BNB_TESTNET");
        revert(string.concat("DeployVPFIBuyAdapter: unsupported chainId ", vm.toString(chainId)));
    }

    /// @dev Resolves treasury for this chain. Prefers a per-chain override
    ///      (e.g. SEPOLIA_TREASURY_ADDRESS), falls back to TREASURY_ADDRESS.
    function _treasury() internal view returns (address) {
        uint256 chainId = block.chainid;
        string memory key =
            chainId == 11155111 ? "SEPOLIA_TREASURY_ADDRESS"
            : chainId == 421614 ? "ARB_SEPOLIA_TREASURY_ADDRESS"
            : chainId == 11155420 ? "OP_SEPOLIA_TREASURY_ADDRESS"
            : chainId == 80002 ? "POLYGON_AMOY_TREASURY_ADDRESS"
            : chainId == 97 ? "BNB_TESTNET_TREASURY_ADDRESS"
            : "TREASURY_ADDRESS";
        return vm.envOr(key, vm.envAddress("TREASURY_ADDRESS"));
    }

    /// @dev Payment token resolves to address(0) on native-gas chains
    ///      (ETH on Sepolia/OP/Arb, BNB on BNB Testnet) and to the
    ///      canonical wrapped-native on Polygon Amoy where MATIC is
    ///      not the buy-currency surface.
    function _paymentToken() internal view returns (address) {
        uint256 chainId = block.chainid;
        string memory key =
            chainId == 11155111 ? "SEPOLIA_VPFI_BUY_PAYMENT_TOKEN"
            : chainId == 421614 ? "ARB_SEPOLIA_VPFI_BUY_PAYMENT_TOKEN"
            : chainId == 11155420 ? "OP_SEPOLIA_VPFI_BUY_PAYMENT_TOKEN"
            : chainId == 80002 ? "POLYGON_AMOY_VPFI_BUY_PAYMENT_TOKEN"
            : chainId == 97 ? "BNB_TESTNET_VPFI_BUY_PAYMENT_TOKEN"
            : "VPFI_BUY_PAYMENT_TOKEN";
        return vm.envOr(key, address(0));
    }

    /// @dev Build a default Type-3 options payload from LZ_RECEIVE_GAS /
    ///      LZ_RECEIVE_VALUE env (with sane defaults). Same encoding the
    ///      `BridgeVPFI.s.sol` and `SetBuyOptions.s.sol` scripts produce —
    ///      one source of truth for the executor `lzReceive` shape.
    function _defaultBuyOptions() internal view returns (bytes memory) {
        uint128 lzReceiveGas =
            uint128(vm.envOr("LZ_RECEIVE_GAS", uint256(200_000)));
        uint128 lzReceiveValue =
            uint128(vm.envOr("LZ_RECEIVE_VALUE", uint256(0)));
        return OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(lzReceiveGas, lzReceiveValue);
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address lzEndpoint = _lzEndpoint();
        address owner = vm.envAddress("VPFI_OWNER");
        uint32 receiverEid = uint32(vm.envUint("VPFI_BUY_RECEIVER_EID"));
        address treasury = _treasury();
        address paymentToken = _paymentToken();
        uint64 refundTimeoutSeconds = uint64(vm.envOr("VPFI_BUY_REFUND_TIMEOUT_SECONDS", uint256(900)));

        // VPFI_BUY_OPTIONS env wins when explicitly provided. Otherwise
        // encode a sensible default so the deployed adapter is buyable
        // end-to-end without a follow-up `setBuyOptions` call. A previous
        // deploy convention let this default to `bytes("")` and required
        // operators to remember the post-deploy step — which they didn't,
        // and live `quoteBuy` calls reverted with
        // `LZ_ULN_InvalidWorkerOptions` (selector 0x6592671c). The
        // inline default eliminates that footgun.
        bytes memory buyOptions = vm.envOr("VPFI_BUY_OPTIONS", bytes(""));
        bool buyOptionsFromEnv = buyOptions.length > 0;
        if (!buyOptionsFromEnv) {
            buyOptions = _defaultBuyOptions();
        }

        console.log("=== Deploy VPFIBuyAdapter ===");
        console.log("Chain id:        ", block.chainid);
        console.log("LZ endpoint:     ", lzEndpoint);
        console.log("Owner:           ", owner);
        console.log("Receiver eid:    ", uint256(receiverEid));
        console.log("Treasury:        ", treasury);
        console.log("Payment token:   ", paymentToken == address(0) ? "native ETH" : "ERC20 (see above)");
        console.log("Payment token @: ", paymentToken);
        console.log("Refund timeout:  ", uint256(refundTimeoutSeconds));
        console.log(
            buyOptionsFromEnv
                ? "buyOptions:       (from VPFI_BUY_OPTIONS env)"
                : "buyOptions:       (default Type-3 lzReceive payload encoded inline)"
        );
        console.log("buyOptions len:  ", buyOptions.length);

        vm.startBroadcast(deployerKey);

        VPFIBuyAdapter impl = new VPFIBuyAdapter(lzEndpoint);
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIBuyAdapter.initialize,
                (
                    owner,
                    receiverEid,
                    treasury,
                    paymentToken,
                    buyOptions,
                    refundTimeoutSeconds
                )
            )
        );

        vm.stopBroadcast();

        // Defensive readback: if we passed non-empty buyOptions to
        // `initialize` they MUST be on-chain by now — the only way the
        // readback would mismatch is a code bug or a malicious impl, so
        // catching it here is a free invariant check rather than
        // shipping a silently-broken adapter.
        VPFIBuyAdapter adapter = VPFIBuyAdapter(payable(address(proxy)));
        bytes memory storedOptions = adapter.buyOptions();
        require(
            keccak256(storedOptions) == keccak256(buyOptions),
            "DeployVPFIBuyAdapter: buyOptions readback mismatch after init"
        );

        Deployments.writeVPFIBuyAdapter(address(proxy));
        Deployments.writeVPFIBuyAdapterImpl(address(impl));
        Deployments.writeLzEndpoint(lzEndpoint);
        Deployments.writeVpfiBuyReceiverEid(receiverEid);
        Deployments.writeVPFIBuyPaymentToken(paymentToken);

        console.log("VPFIBuyAdapter impl:  ", address(impl));
        console.log("VPFIBuyAdapter proxy: ", address(proxy));
        console.log("");
        console.log("NEXT STEPS:");
        console.log(" - Run WireVPFIBuyPeers.s.sol with LOCAL=adapter, REMOTE=base-receiver");
        console.log(" - Mirror the wiring on Base with LOCAL=base-receiver, REMOTE=this-adapter");
        console.log(" - buyOptions are already populated; SetBuyOptions.s.sol only needed if the gas budget changes later");
    }
}
