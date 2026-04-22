// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import {SetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";

/// @dev Minimal surface of the LayerZero V2 endpoint used by this script.
///      The endpoint exposes these via {IMessageLibManager} (inherited by
///      {EndpointV2}). Full interface lives under the LZ protocol package
///      at lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2;
///      we re-declare just the methods we need so the script stays readable.
interface ILZEndpoint {
    function setSendLibrary(address _oapp, uint32 _eid, address _newLib) external;

    function setReceiveLibrary(
        address _oapp,
        uint32 _eid,
        address _newLib,
        uint256 _gracePeriod
    ) external;

    function setConfig(
        address _oapp,
        address _lib,
        SetConfigParam[] calldata _params
    ) external;

    function getConfig(
        address _oapp,
        address _lib,
        uint32 _eid,
        uint32 _configType
    ) external view returns (bytes memory config);
}

/// @dev Thin view over an OApp — only the `endpoint()` getter is needed.
///      All Vaipakam OApps (`VPFIOFTAdapter`, `VPFIMirror`, `VPFIBuyAdapter`,
///      `VPFIBuyReceiver`, `VaipakamRewardOApp`) inherit this through the
///      LZ upgradeable base.
interface IOAppEndpoint {
    function endpoint() external view returns (address);
}

/**
 * @title ConfigureLZConfig
 * @notice Multi-sig / timelock script that hardens the LayerZero
 *         configuration of one Vaipakam OApp on the chain being executed
 *         against. Run once per (OApp, chain) pair during Phase 1 rollout,
 *         and re-run whenever the DVN set or confirmation policy evolves.
 *
 * @dev Applies the post-Kelp-incident hardening policy pinned in
 *      `contracts/README.md` / `CLAUDE.md`:
 *        - ULN config: 3 required DVNs + 2 optional (threshold 1-of-2).
 *        - Per-chain confirmations per the Cross-Chain Security table.
 *        - Explicit send + receive libraries (uln302), not the endpoint
 *          defaults.
 *
 *      **IMPORTANT — operational gates before running on mainnet**:
 *        1. Populate the DVN address placeholders (search for
 *           `_DVN_TODO_MAINNET` below) with the final operator addresses
 *           pinned by the security team.
 *        2. Populate the `SEND_LIB` / `RECV_LIB` env vars with the
 *           LayerZero V2 send/receive library addresses for this chain
 *           (from https://docs.layerzero.network/v2/deployments/deployed-contracts).
 *        3. Verify the `CHAIN_CONFIRMATIONS` table lines up with your
 *           target network's finality budget.
 *        4. Execute with `PRIVATE_KEY` held by the OApp's owner/delegate
 *           (the timelock/multisig wired at deploy time).
 *        5. After the run, `LZConfig.t.sol` (Foundry test) must pass
 *           against a fork of the post-config state — enforces the policy
 *           readback.
 *
 *      Enforced-options (`setEnforcedOptions`) are intentionally NOT set
 *      here: the Vaipakam OApps use per-msgType option setters on the
 *      OApp itself (`setBuyOptions` on `VPFIBuyAdapter`, `setResponseOptions`
 *      on `VPFIBuyReceiver`, etc.) rather than the LZ
 *      `OAppOptionsType3Upgradeable` mixin. Keep the per-OApp setters as
 *      the single source of truth for gas/msg.value options; revisit in
 *      Phase 2 if we ever inherit `OAppOptionsType3Upgradeable`.
 *
 * @dev Env vars (per run):
 *        - PRIVATE_KEY : owner / delegate key for the OApp on this chain.
 *        - OAPP        : OApp proxy address (adapter / mirror / buy /
 *                        receiver / reward OApp).
 *        - SEND_LIB    : SendUln302 address on this chain.
 *        - RECV_LIB    : ReceiveUln302 address on this chain.
 *        - REMOTE_EIDS : comma-separated list of peer eids to configure
 *                        (e.g. "30110,30111,30184" for Arb+OP+Base).
 *        - CHAIN_ID    : current chain id — used to look up the
 *                        confirmation count from the table below.
 */
contract ConfigureLZConfig is Script {
    // ─── DVN set (3R + 2O, threshold 1) ─────────────────────────────────────
    //
    // TODO: replace each `_DVN_TODO_*` placeholder with the final operator
    // address pinned by the security team. Keep the list SORTED ASCENDING
    // by address in both required and optional groups — LZ's UlnBase
    // enforces this at `setConfig` time.
    //
    // Required (all 3 must sign):
    //   1. LayerZero Labs DVN
    //   2. Google Cloud DVN
    //   3. Polyhedra OR Nethermind DVN
    // Optional (threshold 1-of-2):
    //   1. BWare Labs DVN
    //   2. Stargate Labs OR Horizen Labs DVN

    address internal constant DVN_LAYERZERO_LABS = address(0x0000000000000000000000000000000000000000); // _DVN_TODO_MAINNET
    address internal constant DVN_GOOGLE_CLOUD   = address(0x0000000000000000000000000000000000000000); // _DVN_TODO_MAINNET
    address internal constant DVN_POLYHEDRA      = address(0x0000000000000000000000000000000000000000); // _DVN_TODO_MAINNET
    address internal constant DVN_BWARE_LABS     = address(0x0000000000000000000000000000000000000000); // _DVN_TODO_MAINNET
    address internal constant DVN_STARGATE_LABS  = address(0x0000000000000000000000000000000000000000); // _DVN_TODO_MAINNET

    // ─── ULN config type constants ──────────────────────────────────────────
    // Mirror of `SendUln302.CONFIG_TYPE_ULN` / `CONFIG_TYPE_EXECUTOR`.
    uint32 internal constant CONFIG_TYPE_ULN = 2;

    // ─── Per-chain confirmation policy ──────────────────────────────────────
    // Values track the Cross-Chain Security table in contracts/README.md.
    // Update in lockstep with that doc when policy changes.
    //
    // Note: values map chain -> confirmations to wait on the SOURCE side
    // before signing a packet originating on that chain. Applied to both
    // send (from this chain) and receive (from that peer) configs.
    function _confirmationsFor(uint256 chainId_) internal pure returns (uint64) {
        if (chainId_ == 1) return 15;         // Ethereum Mainnet
        if (chainId_ == 11155111) return 15;  // Sepolia
        if (chainId_ == 8453) return 10;      // Base
        if (chainId_ == 84532) return 10;     // Base Sepolia
        if (chainId_ == 10) return 10;        // Optimism
        if (chainId_ == 11155420) return 10;  // Optimism Sepolia
        if (chainId_ == 42161) return 10;     // Arbitrum One
        if (chainId_ == 421614) return 10;    // Arbitrum Sepolia
        if (chainId_ == 1101) return 20;      // Polygon zkEVM
        if (chainId_ == 2442) return 20;      // Polygon zkEVM Cardona
        if (chainId_ == 56) return 15;        // BNB Chain
        if (chainId_ == 97) return 15;        // BNB Testnet
        revert("ConfigureLZConfig: unknown chainId");
    }

    // ─── Entry point ────────────────────────────────────────────────────────

    function run() external {
        uint256 ownerKey = vm.envUint("PRIVATE_KEY");
        address oapp = vm.envAddress("OAPP");
        address sendLib = vm.envAddress("SEND_LIB");
        address recvLib = vm.envAddress("RECV_LIB");
        uint256 chainId_ = vm.envOr("CHAIN_ID", block.chainid);
        uint32[] memory remoteEids = _parseEids(vm.envString("REMOTE_EIDS"));

        require(
            remoteEids.length > 0,
            "ConfigureLZConfig: REMOTE_EIDS must list at least one eid"
        );
        _assertDvnsConfigured();

        address endpoint = IOAppEndpoint(oapp).endpoint();
        ILZEndpoint lz = ILZEndpoint(endpoint);

        console.log("=== Configure LZ DVN / libraries ===");
        console.log("OApp:       ", oapp);
        console.log("Endpoint:   ", endpoint);
        console.log("Send lib:   ", sendLib);
        console.log("Receive lib:", recvLib);
        console.log("Chain id:   ", chainId_);

        UlnConfig memory policy = _policyForChain(chainId_);

        vm.startBroadcast(ownerKey);
        for (uint256 i = 0; i < remoteEids.length; ++i) {
            uint32 remoteEid = remoteEids[i];

            // Point the OApp at the hardened ULN libraries for this eid.
            lz.setSendLibrary(oapp, remoteEid, sendLib);
            lz.setReceiveLibrary(oapp, remoteEid, recvLib, 0 /* gracePeriod */);

            // Send-side ULN config: how packets we emit TO `remoteEid`
            // are verified. Confirmations anchor to this chain's finality.
            SetConfigParam[] memory sendParams = new SetConfigParam[](1);
            sendParams[0] = SetConfigParam({
                eid: remoteEid,
                configType: CONFIG_TYPE_ULN,
                config: abi.encode(policy)
            });
            lz.setConfig(oapp, sendLib, sendParams);

            // Receive-side ULN config: how packets arriving FROM `remoteEid`
            // are verified. Confirmations anchor to the peer's finality —
            // policy picks them up from `chainId_` of the source eid, but
            // we apply the same `policy` here (which reflects THIS chain's
            // expected inbound verification) for symmetry. Adjust if a
            // per-peer inbound confirmation matrix is ever needed.
            SetConfigParam[] memory recvParams = new SetConfigParam[](1);
            recvParams[0] = SetConfigParam({
                eid: remoteEid,
                configType: CONFIG_TYPE_ULN,
                config: abi.encode(policy)
            });
            lz.setConfig(oapp, recvLib, recvParams);

            console.log("Configured eid:", remoteEid);
        }
        vm.stopBroadcast();

        console.log("Done. Run LZConfig.t.sol against a fork to verify.");
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /// @dev Build the UlnConfig for this chain. DVN arrays must be sorted
    ///      ascending by address; we sort at runtime since the placeholder
    ///      addresses are not yet known and the security team may pin any
    ///      operators. Confirmations come from the per-chain table.
    function _policyForChain(uint256 chainId_) internal pure returns (UlnConfig memory cfg) {
        address[] memory req = new address[](3);
        req[0] = DVN_LAYERZERO_LABS;
        req[1] = DVN_GOOGLE_CLOUD;
        req[2] = DVN_POLYHEDRA;
        _sortAscending(req);

        address[] memory opt = new address[](2);
        opt[0] = DVN_BWARE_LABS;
        opt[1] = DVN_STARGATE_LABS;
        _sortAscending(opt);

        cfg = UlnConfig({
            confirmations: _confirmationsFor(chainId_),
            requiredDVNCount: 3,
            optionalDVNCount: 2,
            optionalDVNThreshold: 1,
            requiredDVNs: req,
            optionalDVNs: opt
        });
    }

    /// @dev Abort the run if any DVN placeholder is still zero — a
    ///      defensive gate preventing a "blank DVN" config from ever
    ///      reaching broadcast. Remove once the operator addresses are
    ///      pinned or replace with the production values.
    function _assertDvnsConfigured() internal pure {
        require(DVN_LAYERZERO_LABS != address(0), "DVN_LAYERZERO_LABS not set");
        require(DVN_GOOGLE_CLOUD != address(0), "DVN_GOOGLE_CLOUD not set");
        require(DVN_POLYHEDRA != address(0), "DVN_POLYHEDRA not set");
        require(DVN_BWARE_LABS != address(0), "DVN_BWARE_LABS not set");
        require(DVN_STARGATE_LABS != address(0), "DVN_STARGATE_LABS not set");
    }

    /// @dev In-place insertion sort. N=2 or 3 in this script — avoids
    ///      pulling in a Solidity sort library for tiny arrays.
    function _sortAscending(address[] memory arr) internal pure {
        for (uint256 i = 1; i < arr.length; ++i) {
            address cur = arr[i];
            uint256 j = i;
            while (j > 0 && uint160(arr[j - 1]) > uint160(cur)) {
                arr[j] = arr[j - 1];
                unchecked {
                    --j;
                }
            }
            arr[j] = cur;
        }
    }

    /// @dev Parse a CSV of uint eids: "30110,30111,30184" → [30110,30111,30184].
    ///      Whitespace-tolerant; rejects empty tokens.
    function _parseEids(string memory csv) internal pure returns (uint32[] memory out) {
        bytes memory b = bytes(csv);
        // First pass: count tokens.
        uint256 count = 1;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] == ",") ++count;
        }
        out = new uint32[](count);

        uint256 idx = 0;
        uint256 acc = 0;
        bool inToken = false;
        for (uint256 i = 0; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c == " " || c == "\t") continue;
            if (c == ",") {
                require(inToken, "ConfigureLZConfig: empty eid");
                out[idx++] = uint32(acc);
                acc = 0;
                inToken = false;
                continue;
            }
            require(c >= 0x30 && c <= 0x39, "ConfigureLZConfig: non-digit in REMOTE_EIDS");
            acc = acc * 10 + uint256(uint8(c) - 0x30);
            inToken = true;
        }
        require(inToken, "ConfigureLZConfig: trailing separator");
        out[idx] = uint32(acc);
    }
}
