// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IOFT,
    SendParam,
    MessagingFee,
    MessagingReceipt,
    OFTReceipt
} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/**
 * @title BridgeVPFI
 * @notice End-to-end VPFI bridge helper for the Phase 1 OFT V2 testnet rollout.
 *         Executes a single LayerZero `send` from whichever testnet the script
 *         is broadcast on to a destination testnet, auto-resolving the local
 *         OApp (adapter on Base Sepolia / mirror elsewhere), the destination
 *         EID, and the native fee.
 *
 * @dev Flow:
 *        1. Resolve local OApp (adapter on canonical / mirror on each mirror
 *           chain) via `<CHAIN>_VPFI_OFT` env var keyed on `block.chainid`.
 *        2. Resolve destination EID via `DEST_CHAIN_ID` env var and an
 *           internal chainId → EID table (LayerZero V2 testnet EIDs).
 *        3. Build {SendParam}:
 *              - amountLD      = `AMOUNT`       (wei, 18 decimals)
 *              - minAmountLD   = `MIN_AMOUNT`   (optional, defaults to AMOUNT)
 *              - to            = `RECIPIENT`    (defaults to sender)
 *              - extraOptions  = {OptionsBuilder.addExecutorLzReceiveOption}
 *                                using `LZ_RECEIVE_GAS` (default 200_000) and
 *                                `LZ_RECEIVE_VALUE` (default 0).
 *        4. Quote native fee via {IOFT.quoteSend}.
 *        5. On the canonical chain only, approve the adapter to pull
 *           `amountLD` VPFI from the sender (mirrors burn on send, no
 *           approval needed). Reads the underlying VPFI token via
 *           `BASE_SEPOLIA_VPFI` / `BASE_VPFI` env var.
 *        6. Broadcast `send{value: nativeFee}(...)` and print the GUID.
 *
 *      Off-chain: track delivery on https://testnet.layerzeroscan.com using
 *      the printed GUID (or source-tx hash). Peers must already be wired in
 *      both directions via {WireVPFIPeers}.
 *
 *      Required env vars:
 *        - PRIVATE_KEY               : sender key (broadcaster + token owner)
 *        - <CHAIN>_VPFI_OFT          : local OApp (adapter on Base Sepolia,
 *                                      mirror otherwise). One var per chain.
 *        - BASE_SEPOLIA_VPFI / BASE_VPFI : underlying VPFI ERC20 — required
 *                                          only when broadcasting on the
 *                                          canonical chain (adapter pulls via
 *                                          safeTransferFrom).
 *        - DEST_CHAIN_ID             : destination chain id (e.g. 11155111)
 *        - AMOUNT                    : amount to bridge, local decimals (18)
 *
 *      Optional env vars:
 *        - MIN_AMOUNT                : slippage floor; default = AMOUNT
 *        - RECIPIENT                 : destination-chain recipient; default =
 *                                      msg.sender (sender's EOA on the dest)
 *        - LZ_RECEIVE_GAS            : executor gas on dest; default 200_000
 *        - LZ_RECEIVE_VALUE          : msg.value forwarded to lzReceive;
 *                                      default 0
 *
 *      Example (Base Sepolia → Sepolia, 10 VPFI to self):
 *        BASE_SEPOLIA_VPFI=0xToken \
 *        BASE_SEPOLIA_VPFI_OFT=0xAdapter \
 *        DEST_CHAIN_ID=11155111 \
 *        AMOUNT=10000000000000000000 \
 *          forge script script/BridgeVPFI.s.sol \
 *            --rpc-url base_sepolia --broadcast
 */
contract BridgeVPFI is Script {
    using SafeERC20 for IERC20;
    using OptionsBuilder for bytes;

    /// @dev LayerZero V2 testnet endpoint IDs (source of truth:
    ///      https://docs.layerzero.network/v2/deployments/deployed-contracts).
    ///      Mainnet EIDs are included to keep the script usable for a
    ///      post-testnet promotion without a second file.
    function _eidFor(uint256 chainId) internal pure returns (uint32) {
        // ── Testnets ─────────────────────────────────────────────────────
        if (chainId == 84532)    return 40245; // Base Sepolia
        if (chainId == 11155111) return 40161; // Sepolia
        if (chainId == 80002)    return 40267; // Polygon Amoy
        if (chainId == 421614)   return 40231; // Arbitrum Sepolia
        if (chainId == 11155420) return 40232; // Optimism Sepolia
        // ── Mainnets ─────────────────────────────────────────────────────
        if (chainId == 8453)     return 30184; // Base
        if (chainId == 1)        return 30101; // Ethereum
        if (chainId == 137)      return 30109; // Polygon
        if (chainId == 42161)    return 30110; // Arbitrum One
        if (chainId == 10)       return 30111; // Optimism
        revert(string.concat("BridgeVPFI: unmapped chainId ", vm.toString(chainId)));
    }

    /// @dev Resolves the local OApp (adapter on canonical, mirror elsewhere).
    ///      Reads a per-chain env var so deploy artifacts from
    ///      {DeployVPFICanonical} / {DeployVPFIMirror} can be reused as-is.
    function _localOApp() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532)    return vm.envAddress("BASE_SEPOLIA_VPFI_OFT");
        if (chainId == 11155111) return vm.envAddress("SEPOLIA_VPFI_OFT");
        if (chainId == 80002)    return vm.envAddress("POLYGON_AMOY_VPFI_OFT");
        if (chainId == 421614)   return vm.envAddress("ARB_SEPOLIA_VPFI_OFT");
        if (chainId == 11155420) return vm.envAddress("OP_SEPOLIA_VPFI_OFT");
        if (chainId == 8453)     return vm.envAddress("BASE_VPFI_OFT");
        if (chainId == 1)        return vm.envAddress("ETHEREUM_VPFI_OFT");
        if (chainId == 137)      return vm.envAddress("POLYGON_VPFI_OFT");
        if (chainId == 42161)    return vm.envAddress("ARBITRUM_VPFI_OFT");
        if (chainId == 10)       return vm.envAddress("OPTIMISM_VPFI_OFT");
        revert(string.concat("BridgeVPFI: no VPFI_OFT env for chainId ", vm.toString(chainId)));
    }

    /// @dev Only the canonical chain uses the adapter (lock-on-send model),
    ///      which requires an ERC20 approval. Mirrors burn on send and skip
    ///      this step. Canonical chains: Base (8453) and Base Sepolia (84532).
    function _isCanonical(uint256 chainId) internal pure returns (bool) {
        return chainId == 8453 || chainId == 84532;
    }

    /// @dev Canonical-chain underlying VPFI token address for adapter
    ///      approval. Only read when broadcasting on a canonical chain.
    function _canonicalVPFIToken() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("BASE_SEPOLIA_VPFI");
        if (chainId == 8453)  return vm.envAddress("BASE_VPFI");
        revert("BridgeVPFI: _canonicalVPFIToken called off canonical chain");
    }

    function run() external {
        uint256 senderKey = vm.envUint("PRIVATE_KEY");
        address sender = vm.addr(senderKey);

        address localOApp = _localOApp();
        uint256 destChainId = vm.envUint("DEST_CHAIN_ID");
        uint32 dstEid = _eidFor(destChainId);
        if (dstEid == _eidFor(block.chainid)) {
            revert("BridgeVPFI: DEST_CHAIN_ID equals local chain");
        }

        uint256 amount = vm.envUint("AMOUNT");
        if (amount == 0) revert("BridgeVPFI: AMOUNT must be > 0");

        uint256 minAmount = vm.envOr("MIN_AMOUNT", amount);
        address recipient = vm.envOr("RECIPIENT", sender);

        uint128 lzReceiveGas = uint128(vm.envOr("LZ_RECEIVE_GAS", uint256(200_000)));
        uint128 lzReceiveValue = uint128(vm.envOr("LZ_RECEIVE_VALUE", uint256(0)));

        bytes memory extraOptions = OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(lzReceiveGas, lzReceiveValue);

        SendParam memory sendParam = SendParam({
            dstEid: dstEid,
            to: bytes32(uint256(uint160(recipient))),
            amountLD: amount,
            minAmountLD: minAmount,
            extraOptions: extraOptions,
            composeMsg: "",
            oftCmd: ""
        });

        MessagingFee memory fee = IOFT(localOApp).quoteSend(sendParam, false);

        console.log("=== Bridge VPFI (LayerZero OFT V2) ===");
        console.log("Source chainId:  ", block.chainid);
        console.log("Local OApp:      ", localOApp);
        console.log("Dest chainId:    ", destChainId);
        console.log("Dest EID:        ", uint256(dstEid));
        console.log("Sender:          ", sender);
        console.log("Recipient:       ", recipient);
        console.log("Amount (wei):    ", amount);
        console.log("Min amount (wei):", minAmount);
        console.log("lzReceive gas:   ", uint256(lzReceiveGas));
        console.log("Native fee (wei):", fee.nativeFee);

        vm.startBroadcast(senderKey);

        if (_isCanonical(block.chainid)) {
            address vpfi = _canonicalVPFIToken();
            console.log("VPFI token:      ", vpfi);
            IERC20(vpfi).forceApprove(localOApp, amount);
        }

        (MessagingReceipt memory msgReceipt, OFTReceipt memory oftReceipt) =
            IOFT(localOApp).send{value: fee.nativeFee}(sendParam, fee, sender);

        vm.stopBroadcast();

        console.log("Sent. GUID (hex):");
        console.logBytes32(msgReceipt.guid);
        console.log("Nonce:                ", uint256(msgReceipt.nonce));
        console.log("amountSentLD:         ", oftReceipt.amountSentLD);
        console.log("amountReceivedLD:     ", oftReceipt.amountReceivedLD);
        console.log("Track: https://testnet.layerzeroscan.com");
    }
}
