// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Router} from "@chainlink/contracts-ccip/contracts/Router.sol";
import {RMNRemote} from "@chainlink/contracts-ccip/contracts/rmn/RMNRemote.sol";
import {RMNProxy} from "@chainlink/contracts-ccip/contracts/rmn/RMNProxy.sol";
import {IRMN} from "@chainlink/contracts-ccip/contracts/interfaces/IRMN.sol";
import {TokenAdminRegistry} from "@chainlink/contracts-ccip/contracts/tokenAdminRegistry/TokenAdminRegistry.sol";
import {RegistryModuleOwnerCustom} from
    "@chainlink/contracts-ccip/contracts/tokenAdminRegistry/RegistryModuleOwnerCustom.sol";
import {Deployments} from "../lib/Deployments.sol";
import {ARTIFACT_SCRATCH_PREFIX, hasParentSegment} from "../lib/ArtifactRoot.sol";
import {E2ELocalOffRamp, E2ELocalOnRamp} from "./E2ELocalCcip.sol";

/**
 * @title  DeployE2ELocalCcip
 * @notice The keeper's two-chain Anvil scenarios (`apps/keeper/e2e/mesh`,
 *         #2516): one node's half of a local CCIP lane — the infrastructure a
 *         live chain already has before `DeployCrosschain` runs, so that
 *         script and `ConfigureCcip` can run on the node unchanged.
 *
 * @dev    Deploys, on the node this runs against (which presents the chain id
 *         its lane is keyed on):
 *           - the REAL `RMNRemote` for this chain's CCIP selector, behind the
 *             REAL `RMNProxy` (no curses: a fresh RMN curses nothing);
 *           - the REAL `Router`, wrapping native fees into the canonical WETH9
 *             the harness installs at Base's predeploy address;
 *           - the REAL `TokenAdminRegistry` with the REAL
 *             `RegistryModuleOwnerCustom` added as a registry module, which is
 *             what `ConfigureCcip`'s CCT step calls;
 *           - the lane's two ramps (`E2ELocalCcip.sol`), registered on the
 *             router for the ONE remote chain: the on-ramp toward it and the
 *             off-ramp from it, the latter executable only by the harness
 *             relay's key.
 *
 *         Env: `DEPLOYER_PRIVATE_KEY` (owns the router and the registry, as
 *         Chainlink owns them on a live chain), `E2E_REMOTE_CHAIN_ID`,
 *         `E2E_RELAYER_ADDRESS`, `E2E_LANE_NATIVE_FEE_WEI`, `E2E_CCIP_OUT`
 *         (where the addresses go: a file under the gitignored
 *         `deployments/.forge-test/`, in a directory the harness has
 *         already created).
 */
contract DeployE2ELocalCcip is Script {
    /// Base's WETH predeploy, where the harness installs the canonical WETH9.
    address internal constant WRAPPED_NATIVE = 0x4200000000000000000000000000000000000006;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 remoteChainId = vm.envUint("E2E_REMOTE_CHAIN_ID");
        address relayer = vm.envAddress("E2E_RELAYER_ADDRESS");
        uint256 fee = vm.envUint("E2E_LANE_NATIVE_FEE_WEI");
        string memory out = vm.envString("E2E_CCIP_OUT");
        require(
            _startsWith(out, ARTIFACT_SCRATCH_PREFIX) && !hasParentSegment(out),
            "DeployE2ELocalCcip: E2E_CCIP_OUT must be a file under deployments/.forge-test/ with no `..` segment"
        );
        require(WRAPPED_NATIVE.code.length != 0, "DeployE2ELocalCcip: no WETH9 at the predeploy address - run the harness's canonical installs first");
        require(remoteChainId != block.chainid, "DeployE2ELocalCcip: the remote chain is this chain");

        uint64 localSel = Deployments.ccipSelectorForChainId(block.chainid);
        uint64 remoteSel = Deployments.ccipSelectorForChainId(remoteChainId);

        vm.startBroadcast(deployerKey);
        RMNRemote rmnRemote = new RMNRemote(localSel, IRMN(address(0)));
        RMNProxy rmnProxy = new RMNProxy(address(rmnRemote));
        Router router = new Router(WRAPPED_NATIVE, address(rmnProxy));
        TokenAdminRegistry registry = new TokenAdminRegistry();
        RegistryModuleOwnerCustom module = new RegistryModuleOwnerCustom(address(registry));
        registry.addRegistryModule(address(module));
        E2ELocalOnRamp onRamp = new E2ELocalOnRamp(address(router), address(registry), localSel, remoteSel, fee);
        E2ELocalOffRamp offRamp =
            new E2ELocalOffRamp(address(router), address(registry), localSel, remoteSel, relayer);

        Router.OnRamp[] memory onRamps = new Router.OnRamp[](1);
        onRamps[0] = Router.OnRamp({destChainSelector: remoteSel, onRamp: address(onRamp)});
        Router.OffRamp[] memory offRamps = new Router.OffRamp[](1);
        offRamps[0] = Router.OffRamp({sourceChainSelector: remoteSel, offRamp: address(offRamp)});
        router.applyRampUpdates(onRamps, new Router.OffRamp[](0), offRamps);
        vm.stopBroadcast();

        string memory k = "e2eCcip";
        vm.serializeAddress(k, "router", address(router));
        vm.serializeAddress(k, "rmnProxy", address(rmnProxy));
        vm.serializeAddress(k, "rmnRemote", address(rmnRemote));
        vm.serializeAddress(k, "tokenAdminRegistry", address(registry));
        vm.serializeAddress(k, "registryModuleOwnerCustom", address(module));
        vm.serializeAddress(k, "onRamp", address(onRamp));
        vm.serializeAddress(k, "offRamp", address(offRamp));
        vm.serializeAddress(k, "relayer", relayer);
        // The selectors and the fee as decimal STRINGS: a CCIP selector is a
        // uint64 past 2^53, and a JSON number that size loses its low digits
        // in any reader that parses numbers as doubles (the harness's does).
        vm.serializeString(k, "localChainSelector", vm.toString(uint256(localSel)));
        vm.serializeString(k, "remoteChainSelector", vm.toString(uint256(remoteSel)));
        vm.serializeUint(k, "remoteChainId", remoteChainId);
        string memory json = vm.serializeString(k, "laneNativeFeeWei", vm.toString(fee));
        vm.writeJson(json, out);
        console.log("Local CCIP lane: router", address(router));
        console.log("  on-ramp ", address(onRamp));
        console.log("  off-ramp", address(offRamp));
    }

    function _startsWith(string memory s, string memory prefix) private pure returns (bool) {
        bytes memory b = bytes(s);
        bytes memory p = bytes(prefix);
        if (b.length < p.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (b[i] != p[i]) return false;
        }
        return true;
    }
}
