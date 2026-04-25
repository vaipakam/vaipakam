// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {LZGuardianPausable} from "../src/token/LZGuardianPausable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title MigrateOAppGovernance
 * @notice Phase-1 hardening companion to {TransferAdminToTimelock}. Migrates
 *         the non-Diamond contracts — the VPFIToken and every LayerZero
 *         OApp / OFT deployed on the current chain — to the Safe + Timelock
 *         + Guardian model:
 *
 *           1. For each OApp, install the Guardian incident-response
 *              address via `setGuardian(guardian)`. Must run while the
 *              deployer still owns the contract.
 *           2. For each OApp and VPFIToken, propose the Timelock as the
 *              new Ownable2Step owner via `transferOwnership(timelock)`.
 *              The Timelock becomes effective owner only after a Safe-
 *              proposed `acceptOwnership()` call clears the 48h delay
 *              and executes — see {GovernanceRunbook.md}.
 *
 *         Address discovery: every address is pulled from a per-chain env
 *         var, mirroring the `Deploy*` scripts. Setting the env var to
 *         `0x0000...0000` (or leaving it unset and relying on `envOr`)
 *         skips that contract — lets the same script run on canonical
 *         and mirror chains despite their non-overlapping OApp sets.
 *
 *         Why `setGuardian` before `transferOwnership`:
 *           `setGuardian` is `onlyOwner`. After ownership moves to the
 *           Timelock, installing the guardian would itself require a
 *           48h-delayed proposal — pointless given the guardian's whole
 *           purpose is to avoid that delay during an incident. Doing it
 *           beforehand keeps the handover atomic in effect.
 *
 *         Required env vars:
 *           - PRIVATE_KEY                            : current deployer (still the Ownable2Step owner)
 *           - <CHAIN>_TIMELOCK_ADDRESS               : Timelock from {DeployTimelock}
 *           - GOVERNANCE_GUARDIAN                    : Guardian Safe address
 *           - CONFIRM_HANDOVER                       : must equal "YES"
 *         Per-contract env vars (any of which may be absent / zero on a
 *         chain where that contract is not deployed):
 *           - <CHAIN>_VPFI_TOKEN_ADDRESS
 *           - <CHAIN>_VPFI_OFT_ADAPTER_ADDRESS
 *           - <CHAIN>_VPFI_MIRROR_ADDRESS
 *           - <CHAIN>_VPFI_BUY_ADAPTER_ADDRESS
 *           - <CHAIN>_VPFI_BUY_RECEIVER_ADDRESS
 *           - <CHAIN>_REWARD_OAPP_ADDRESS
 */
contract MigrateOAppGovernance is Script {
    // Contracts to process on the current chain. Zero entries are skipped.
    struct Targets {
        address vpfiToken;
        address vpfiOftAdapter;
        address vpfiMirror;
        address vpfiBuyAdapter;
        address vpfiBuyReceiver;
        address rewardOApp;
    }

    function _prefix() internal view returns (string memory) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return "BASE_SEPOLIA";
        if (chainId == 8453) return "BASE";
        if (chainId == 11155111) return "SEPOLIA";
        if (chainId == 421614) return "ARB_SEPOLIA";
        if (chainId == 11155420) return "OP_SEPOLIA";
        if (chainId == 1) return "ETHEREUM";
        if (chainId == 42161) return "ARBITRUM";
        if (chainId == 10) return "OPTIMISM";
        if (chainId == 56) return "BNB";
        if (chainId == 97) return "BNB_TESTNET";
        if (chainId == 1101) return "POLYGON_ZKEVM";
        if (chainId == 2442) return "POLYGON_ZKEVM_CARDONA";
        revert(
            string.concat(
                "MigrateOAppGovernance: unsupported chainId ",
                vm.toString(chainId)
            )
        );
    }

    /// Reads each contract from deployments/<chain>/addresses.json,
    /// falling back through the chain-prefixed env-var path that
    /// `Deployments` exposes. The legacy per-chain env scan is kept
    /// as the second-tier fallback for chains that haven't yet been
    /// migrated onto the addresses.json convention. Zero entries are
    /// skipped by `_run` — same behaviour as before, different source.
    function _targets() internal view returns (Targets memory t) {
        t.vpfiToken = Deployments.readVPFIToken();
        t.vpfiOftAdapter = Deployments.readVPFIOFTAdapter();
        // VPFIMirror is the same on-chain contract as the OFT adapter
        // on a mirror chain; read the same key. On canonical chains
        // there's no separate `vpfiMirror` entry (the adapter slot
        // doubles as the local OFT). Operators who wired both
        // separately can still use the `<CHAIN>_VPFI_MIRROR_ADDRESS`
        // env override path.
        t.vpfiMirror = vm.envOr(
            string.concat(_chainEnvPrefix(), "_VPFI_MIRROR_ADDRESS"),
            address(0)
        );
        t.vpfiBuyAdapter = Deployments.readVPFIBuyAdapter();
        t.vpfiBuyReceiver = Deployments.readVPFIBuyReceiver();
        t.rewardOApp = Deployments.readRewardOApp();
    }

    /// Mirror of the legacy `_prefix()` helper (returned strings without
    /// the trailing underscore) — the addresses.json migration didn't
    /// touch this; it's the per-chain prefix used for VPFIMirror env
    /// fallback above.
    function _chainEnvPrefix() internal view returns (string memory) {
        return _prefix();
    }

    function run() external {
        string memory confirm = vm.envOr("CONFIRM_HANDOVER", string(""));
        require(
            keccak256(bytes(confirm)) == keccak256(bytes("YES")),
            "MigrateOAppGovernance: set CONFIRM_HANDOVER=YES to proceed"
        );

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address guardian = vm.envAddress("GOVERNANCE_GUARDIAN");
        // Timelock + per-OApp target addresses both come from
        // deployments/<chain>/addresses.json (Deployments.readTimelock,
        // Deployments.read* per OApp) with chain-prefixed env fallback.
        address timelock = Deployments.readTimelock();
        Targets memory t = _targets();

        require(guardian != address(0), "MigrateOAppGovernance: guardian is zero");
        require(timelock != address(0), "MigrateOAppGovernance: timelock is zero");
        require(timelock != deployer, "MigrateOAppGovernance: timelock == deployer");

        console.log("=== Migrate OApp governance ===");
        console.log("Chain id:       ", block.chainid);
        console.log("Deployer (EOA): ", deployer);
        console.log("Timelock:       ", timelock);
        console.log("Guardian:       ", guardian);
        console.log("--- targets -------------------------");
        console.log("VPFIToken:       ", t.vpfiToken);
        console.log("VPFIOFTAdapter:  ", t.vpfiOftAdapter);
        console.log("VPFIMirror:      ", t.vpfiMirror);
        console.log("VPFIBuyAdapter:  ", t.vpfiBuyAdapter);
        console.log("VPFIBuyReceiver: ", t.vpfiBuyReceiver);
        console.log("RewardOApp:      ", t.rewardOApp);

        vm.startBroadcast(deployerKey);

        // Step 1: setGuardian on every OApp that is deployed on this chain.
        // VPFIToken is excluded — it's a pure ERC20, no LayerZero surface,
        // so the LZGuardianPausable abstract isn't mixed into it.
        _setGuardianIfPresent(t.vpfiOftAdapter, guardian, "VPFIOFTAdapter");
        _setGuardianIfPresent(t.vpfiMirror, guardian, "VPFIMirror");
        _setGuardianIfPresent(t.vpfiBuyAdapter, guardian, "VPFIBuyAdapter");
        _setGuardianIfPresent(t.vpfiBuyReceiver, guardian, "VPFIBuyReceiver");
        _setGuardianIfPresent(t.rewardOApp, guardian, "RewardOApp");

        // Step 2: Ownable2Step transferOwnership propose, for every target
        // including VPFIToken. The Timelock becomes effective owner only
        // after a Safe-scheduled `acceptOwnership()` clears the 48h delay.
        _proposeTransferIfPresent(t.vpfiToken, timelock, "VPFIToken");
        _proposeTransferIfPresent(t.vpfiOftAdapter, timelock, "VPFIOFTAdapter");
        _proposeTransferIfPresent(t.vpfiMirror, timelock, "VPFIMirror");
        _proposeTransferIfPresent(t.vpfiBuyAdapter, timelock, "VPFIBuyAdapter");
        _proposeTransferIfPresent(t.vpfiBuyReceiver, timelock, "VPFIBuyReceiver");
        _proposeTransferIfPresent(t.rewardOApp, timelock, "RewardOApp");

        vm.stopBroadcast();

        console.log("Ownership proposed. Safe must now schedule+execute");
        console.log("`acceptOwnership()` through the Timelock on each target.");
        console.log("See docs/GovernanceRunbook.md for the full sequence.");
    }

    function _setGuardianIfPresent(
        address target,
        address guardian,
        string memory name
    ) internal {
        if (target == address(0)) {
            console.log(string.concat("skip setGuardian:  ", name, " (not deployed)"));
            return;
        }
        address current = LZGuardianPausable(target).guardian();
        if (current == guardian) {
            console.log(string.concat("skip setGuardian:  ", name, " (already set)"));
            return;
        }
        LZGuardianPausable(target).setGuardian(guardian);
        console.log(string.concat("setGuardian:       ", name));
    }

    function _proposeTransferIfPresent(
        address target,
        address timelock,
        string memory name
    ) internal {
        if (target == address(0)) {
            console.log(string.concat("skip transfer:     ", name, " (not deployed)"));
            return;
        }
        Ownable2StepUpgradeable ownable = Ownable2StepUpgradeable(target);
        if (ownable.pendingOwner() == timelock) {
            console.log(string.concat("skip transfer:     ", name, " (already pending)"));
            return;
        }
        ownable.transferOwnership(timelock);
        console.log(string.concat("transferOwnership: ", name));
    }
}
