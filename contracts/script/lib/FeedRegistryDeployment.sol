// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {VaipakamFeedRegistry} from "../../src/oracle/VaipakamFeedRegistry.sol";
import {TestnetChains} from "../../src/compliance/TestnetChains.sol";
import {Deployments} from "./Deployments.sol";
import {AdminControl} from "./AdminControl.sol";
import {ArtifactDeploy} from "./ArtifactDeploy.sol";

/**
 * @title  FeedRegistryDeployment
 * @notice The one deploy of the chain's {VaipakamFeedRegistry}, recorded in
 *         the artifact as `.feedRegistry` (#2880). `ConfigureOracle` then points
 *         the Diamond's oracle at it and reads its denominators from it, on
 *         every chain.
 *
 * @dev    The contracts phase of `deploy-{chain,testnet,mainnet}.sh` and the
 *         Anvil bootstrap run this right after the Diamond, before any mock
 *         rig registers feeds into it and before `configure`.
 *
 *         What it sets, and what it leaves:
 *         - owner: the admin (`ADMIN_PRIVATE_KEY`); the handover moves it to
 *           the Timelock with every other admin-owned contract.
 *         - guardian (veto): `PAUSER_ADDRESS`, the Pauser Safe. Required on a
 *           production chain, and it must not be the admin. A testnet without
 *           one gets the admin, said so in the log; the handover rotates it to
 *           the Pauser Safe and the handover gate refuses anything else.
 *         - delay: the contract's default (3 days) on a production chain. A
 *           testnet gets `FEED_REGISTRY_DELAY_SECONDS`, 0 when unset, so its
 *           mock rig can register in the same run.
 *         - proposer: none. The feed service (#2880 step 3) is appointed when
 *           it exists; until then only the owner proposes.
 *         - entries: none. Feeds reach it only by proposal: the mock rig's on
 *           a testnet, the reviewed bindings file's on a production chain.
 *
 *         A registry already recorded for the chain is reused while the admin
 *         alone controls it; any other recorded registry is refused, never
 *         replaced, since its entries are what the Diamond prices from.
 *
 *         Keys: `DEPLOYER_PRIVATE_KEY` deploys; `ADMIN_PRIVATE_KEY` owns and
 *         sets the delay. Artifact writes follow
 *         `Deployments.artifactWritesEnabled()`.
 *
 *         `DeployFeedRegistry.s.sol` runs it for the deploy scripts; the e2e
 *         fixture calls it directly, so both take the same path.
 *
 *         #3272: `DeployDiamond` creates the registry first, through
 *         {createOrReuse}, because the chain's PriceGuard is built inside the
 *         Diamond deploy with the registry as its feed source. The same
 *         guardian and reuse rules apply; the later `deploy` call then reuses
 *         it and sets a testnet's delay, which needs the admin's key.
 */
library FeedRegistryDeployment {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice The registry's guardian (its veto): `PAUSER_ADDRESS`, required
    ///         and distinct from the admin on a production chain; the admin on
    ///         a testnet without one.
    function guardianFor(address admin) internal view returns (address guardian) {
        return guardianFor(admin, VM.envOr("PAUSER_ADDRESS", address(0)));
    }

    /// @notice The same rule for a named candidate (zero = none named).
    function guardianFor(address admin, address candidate) internal view returns (address guardian) {
        guardian = candidate;
        if (!TestnetChains.isTestnet(block.chainid)) {
            require(
                guardian != address(0) && guardian != admin,
                "FeedRegistryDeployment: set PAUSER_ADDRESS to the Pauser Safe (not the admin) - it holds the registry's veto on a production chain"
            );
        } else if (guardian == address(0)) {
            guardian = admin;
            console.log("PAUSER_ADDRESS unset on a testnet: the admin holds the feed registry's veto until the handover rotates it.");
        }
    }

    /// @notice The registry recorded for this chain, when it has code and the
    ///         admin alone controls it; zero when none is recorded. Any other
    ///         recorded registry is refused, never replaced.
    function recordedFor(address admin) internal view returns (address recorded) {
        recorded = Deployments.readFeedRegistryOptional();
        if (recorded.code.length == 0) return address(0);
        require(
            AdminControl.aloneControls(recorded, admin),
            "FeedRegistryDeployment: the recorded feedRegistry is not one the admin alone controls (another owner, or an ownership transfer pending). Its entries are what the Diamond prices from, so it is never replaced: resolve the transfer, or remove .feedRegistry from the artifact to start a new one deliberately. Nothing was sent or recorded"
        );
    }

    /// @notice #3272 — the registry for a caller that already holds the
    ///         broadcast (`DeployDiamond`): the recorded one, or a new one
    ///         created from its artifact. `created` says which; the caller
    ///         records a new one. It leaves the delay at the contract default:
    ///         {deploy} sets a testnet's, with the admin's key. `guardian` is
    ///         the Pauser Safe the caller read from its config (zero = none),
    ///         under the rule of {guardianFor}.
    function createOrReuse(address admin, address guardian) internal returns (address reg, bool created) {
        reg = recordedFor(admin);
        if (reg != address(0)) {
            console.log("Reusing the recorded VaipakamFeedRegistry");
            return (reg, false);
        }
        reg = ArtifactDeploy.deploy(type(VaipakamFeedRegistry).name, abi.encode(admin, guardianFor(admin, guardian)));
        created = true;
    }

    /// @notice Deploy (or reuse) the chain's registry; see the library notes.
    function deploy(uint256 deployerKey, uint256 adminKey) internal returns (VaipakamFeedRegistry reg) {
        bool testnet = TestnetChains.isTestnet(block.chainid);
        address admin = VM.addr(adminKey);
        address guardian = guardianFor(admin);

        address recorded = recordedFor(admin);
        bool deployed;
        if (recorded != address(0)) {
            reg = VaipakamFeedRegistry(recorded);
            console.log("Reusing the recorded VaipakamFeedRegistry");
        } else {
            VM.broadcast(deployerKey);
            reg = new VaipakamFeedRegistry(admin, guardian);
            deployed = true;
        }

        if (testnet) {
            uint64 want = uint64(VM.envOr("FEED_REGISTRY_DELAY_SECONDS", uint256(0)));
            if (reg.delay() != want) {
                VM.broadcast(adminKey);
                reg.setDelay(want);
            }
        }

        // Recorded last, once every step has succeeded: an artifact write
        // survives a later revert in a `--broadcast` run's simulation.
        if (deployed && Deployments.artifactWritesEnabled()) Deployments.writeFeedRegistry(address(reg));

        console.log("VaipakamFeedRegistry:", address(reg));
        console.log("  owner   :", reg.owner());
        console.log("  guardian:", reg.guardian());
        console.log("  delay s :", uint256(reg.delay()));
        console.log("  entries :", reg.entryCount());
    }
}
