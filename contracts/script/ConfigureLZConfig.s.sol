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
 *        - PRIVATE_KEY     : owner / delegate key for the OApp on this
 *                            chain.
 *        - OAPP            : OApp proxy address (adapter / mirror / buy /
 *                            receiver / reward OApp).
 *        - SEND_LIB        : SendUln302 address on this chain.
 *        - RECV_LIB        : ReceiveUln302 address on this chain.
 *        - REMOTE_EIDS     : comma-separated list of peer eids to configure
 *                            (e.g. "30110,30111,30184" for Arb+OP+Base).
 *        - DVN_REQUIRED_1  : first required DVN address (LZ Labs).
 *        - DVN_REQUIRED_2  : second required DVN address (Google Cloud).
 *        - DVN_REQUIRED_3  : third required DVN address (Polyhedra or
 *                            Nethermind).
 *        - DVN_OPTIONAL_1  : first optional DVN address (BWare Labs).
 *        - DVN_OPTIONAL_2  : second optional DVN address (Stargate / Horizen).
 *        - CONFIRMATIONS   : (optional) override block-confirmation count
 *                            for this chain. Falls back to the built-in
 *                            default table documented in
 *                            contracts/README.md's Cross-Chain Security
 *                            section. Useful for one-off hardening under
 *                            incident conditions.
 *        - CHAIN_ID        : (optional) override current chain id for the
 *                            confirmation lookup; defaults to
 *                            `block.chainid`.
 */
contract ConfigureLZConfig is Script {
    // ─── ULN config type constants ──────────────────────────────────────────
    // Mirror of `SendUln302.CONFIG_TYPE_ULN` / `CONFIG_TYPE_EXECUTOR`.
    uint32 internal constant CONFIG_TYPE_ULN = 2;

    // ─── Per-chain default confirmation policy ──────────────────────────────
    // Default values track the Cross-Chain Security table in
    // contracts/README.md. Governance / the security team can override on a
    // per-run basis via the `CONFIRMATIONS` env var — useful during
    // incidents or when LayerZero publishes updated defaults.
    //
    // Note: values map chain -> confirmations to wait on the SOURCE side
    // before signing a packet originating on that chain. Applied to both
    // send (from this chain) and receive (from that peer) configs.
    function _defaultConfirmations(uint256 chainId_) internal pure returns (uint64) {
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
        return 0; // sentinel: caller must supply CONFIRMATIONS env override
    }

    /// @dev Resolve the confirmations to apply for this run — env override
    ///      takes precedence, else the default table. Reverts when neither
    ///      is available (unknown chain + no explicit value) so the script
    ///      never broadcasts a `confirmations: 0` config.
    function _confirmationsFor(uint256 chainId_) internal view returns (uint64) {
        uint256 override_ = vm.envOr("CONFIRMATIONS", uint256(0));
        if (override_ != 0) {
            require(override_ <= type(uint64).max, "CONFIRMATIONS > uint64 max");
            return uint64(override_);
        }
        uint64 def = _defaultConfirmations(chainId_);
        require(
            def != 0,
            "ConfigureLZConfig: unknown chain; set CONFIRMATIONS env"
        );
        return def;
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

    /// @dev Build the UlnConfig for this chain using DVN operator addresses
    ///      pulled from env. DVN arrays must be sorted ascending by address
    ///      (LZ's UlnBase enforces that at `setConfig` time); we sort at
    ///      runtime since the env-supplied operator ordering isn't
    ///      guaranteed.
    function _policyForChain(uint256 chainId_) internal view returns (UlnConfig memory cfg) {
        (address[] memory req, address[] memory opt) = _loadDvnSet();
        cfg = UlnConfig({
            confirmations: _confirmationsFor(chainId_),
            requiredDVNCount: 3,
            optionalDVNCount: 2,
            optionalDVNThreshold: 1,
            requiredDVNs: req,
            optionalDVNs: opt
        });
    }

    /// @dev Read the 3-required / 2-optional DVN operator set from env,
    ///      sort ascending, and return. Reverts if any entry is zero or if
    ///      any two addresses collide — diversification of operators is
    ///      the whole point of the 3R+2O shape, so duplicates defeat the
    ///      security goal and must never reach broadcast.
    function _loadDvnSet() internal view returns (address[] memory req, address[] memory opt) {
        req = new address[](3);
        req[0] = vm.envAddress("DVN_REQUIRED_1");
        req[1] = vm.envAddress("DVN_REQUIRED_2");
        req[2] = vm.envAddress("DVN_REQUIRED_3");

        opt = new address[](2);
        opt[0] = vm.envAddress("DVN_OPTIONAL_1");
        opt[1] = vm.envAddress("DVN_OPTIONAL_2");

        _sortAscending(req);
        _sortAscending(opt);
    }

    /// @dev Refuse to broadcast unless every DVN slot is populated with a
    ///      unique non-zero address. Cheap pre-flight check that saves a
    ///      failed on-chain tx (and the associated alarm) when an env var
    ///      is missing.
    function _assertDvnsConfigured() internal view {
        (address[] memory req, address[] memory opt) = _loadDvnSet();

        require(req[0] != address(0), "DVN_REQUIRED_1 not set");
        require(req[1] != address(0), "DVN_REQUIRED_2 not set");
        require(req[2] != address(0), "DVN_REQUIRED_3 not set");
        require(opt[0] != address(0), "DVN_OPTIONAL_1 not set");
        require(opt[1] != address(0), "DVN_OPTIONAL_2 not set");

        // Sorted, so duplicates become adjacent.
        require(req[0] != req[1] && req[1] != req[2], "duplicate required DVN");
        require(opt[0] != opt[1], "duplicate optional DVN");
        // Cross-group dupes are also a diversification failure.
        for (uint256 i; i < req.length; ++i) {
            for (uint256 j; j < opt.length; ++j) {
                require(req[i] != opt[j], "required/optional DVN overlap");
            }
        }
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
