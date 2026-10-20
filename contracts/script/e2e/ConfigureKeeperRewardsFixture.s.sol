// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {TestnetSanctionsOverlay} from "../../src/compliance/TestnetSanctionsOverlay.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../../src/facets/RewardAggregatorFacet.sol";
import {RewardCustodyFacet} from "../../src/facets/RewardCustodyFacet.sol";
import {InteractionRewardsFacet} from "../../src/facets/InteractionRewardsFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {LibPausable} from "../../src/libraries/LibPausable.sol";

/**
 * @title  ConfigureKeeperRewardsFixture
 * @notice The keeper's Anvil scenarios (`apps/keeper/e2e`): turns the bare
 *         e2e fixture Diamond (`DeployE2EFixture.s.sol`) into a single-chain
 *         CANONICAL reward deployment, the way an operator turns a fresh Base
 *         Diamond into one — so the keeper's reward passes run against the
 *         reward state they were written for, built by the protocol's own
 *         entry points rather than by test mutators.
 *
 * @dev    WHAT IT DOES, IN THE OPERATOR SCRIPTS' ORDER (each step names the
 *         script it reproduces; none of them can run here as-is, because each
 *         reads and writes the committed per-chain artifact for the chain id
 *         it runs on, which is 84532 by now):
 *           1. `DeployVPFIToken`: the canonical VPFI token behind its
 *              ERC-1967 proxy, owner = admin, minter = the Diamond, the
 *              initial mint to the admin (it funds step 6);
 *           2. `ConfigureVPFIToken`: register it, canonical flag on;
 *           3. `ConfigureRewardReporter`: canonical reward role, this chain
 *              as the ONLY expected reporter, a one-hour grace;
 *           4. `SetInteractionLaunch`: the interaction-reward clock starts
 *              now (day 0 is the current day);
 *           5. `ActivateRewardCustody` (direct path): pause, activate custody
 *              at the epoch the pause produced, unpause. The fresh deploy has
 *              already bound the holder, stamped the cutover and consumed the
 *              rebase, exactly as `DeployDiamond` does on every chain;
 *           6. `fundRewardPool`: forward funding of the live fresh row, so a
 *              claim (and therefore the horizon clock and the sanctions
 *              settlement) has delivered VPFI behind it;
 *           7. `ConfigureSanctionsOracle` (testnet shape): the admin's
 *              `TestnetSanctionsOverlay`, with no upstream, as the Diamond's
 *              sanctions oracle — so a scenario can flag a reward owner the
 *              way a testnet operator does.
 *
 *         Runs on the fixture chain AFTER the harness switched it to 84532:
 *         the reward reporter keys its own report on `block.chainid`, and
 *         the overlay refuses any chain outside the testnet allowlist.
 *
 *         Writes the addresses it created to
 *         `deployments/.forge-test/e2e/keeper/rewards.json` — the gitignored
 *         scratch root, never a committed artifact.
 *
 *         Env: `ADMIN_PRIVATE_KEY` (the fixture's ephemeral admin),
 *         `DIAMOND_ADDRESS`, `REWARD_POOL_FUND_WEI`.
 */
contract ConfigureKeeperRewardsFixture is Script {
    /// @notice Where the created addresses go (see the header).
    string internal constant OUT_DIR = "deployments/.forge-test/e2e/keeper";
    string internal constant OUT_FILE = "deployments/.forge-test/e2e/keeper/rewards.json";
    /// @notice The grace the reward reporter waits for missing reports. With
    ///         this chain as the only expected reporter a day finalizes on
    ///         full coverage, so the grace is never what releases it.
    uint64 internal constant GRACE_SECONDS = 3600;

    function run() external {
        require(block.chainid == 84532, "ConfigureKeeperRewardsFixture: run after the harness presents the chain as 84532");
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        uint256 fund = vm.envUint("REWARD_POOL_FUND_WEI");
        require(diamond.code.length != 0, "ConfigureKeeperRewardsFixture: no Diamond at DIAMOND_ADDRESS");

        vm.startBroadcast(adminKey);

        // 1. DeployVPFIToken.
        VPFIToken impl = new VPFIToken();
        address vpfi = address(
            new ERC1967Proxy(address(impl), abi.encodeCall(VPFIToken.initialize, (admin, admin, diamond)))
        );

        // 2. ConfigureVPFIToken.
        VPFITokenFacet(diamond).setVPFIToken(vpfi);
        VPFITokenFacet(diamond).setCanonicalVPFIChain(true);

        // 3. ConfigureRewardReporter (canonical, one expected reporter).
        RewardReporterFacet(diamond).setRewardGraceSeconds(GRACE_SECONDS);
        RewardReporterFacet(diamond).setIsCanonicalRewardChain(true);
        uint32[] memory sources = new uint32[](1);
        sources[0] = uint32(block.chainid);
        RewardAggregatorFacet(diamond).setExpectedSourceChainIds(sources);

        // 4. SetInteractionLaunch.
        InteractionRewardsFacet(diamond).setInteractionLaunchTimestamp(block.timestamp);

        // 5. ActivateRewardCustody — the pause is counted, so the activation
        //    states the epoch read before it plus one.
        (,,, uint64 epoch) = LibPausable.decodePausableSlot(vm.load(diamond, LibPausable.PAUSABLE_STORAGE_POSITION));
        AdminFacet(diamond).pause();
        RewardCustodyFacet(diamond).activateRewardCustody(epoch + 1, false);
        AdminFacet(diamond).unpause();

        // 6. Forward funding.
        IERC20(vpfi).approve(diamond, fund);
        RewardCustodyFacet(diamond).fundRewardPool(fund);

        // 7. The testnet sanctions oracle.
        TestnetSanctionsOverlay overlay = new TestnetSanctionsOverlay(admin, address(0));
        ProfileFacet(diamond).setSanctionsOracle(address(overlay));

        vm.stopBroadcast();

        require(RewardCustodyFacet(diamond).rewardCustodyActivated(), "ConfigureKeeperRewardsFixture: custody did not activate");

        string memory k = "keeperRewards";
        vm.serializeAddress(k, "vpfiToken", vpfi);
        vm.serializeAddress(k, "sanctionsOverlay", address(overlay));
        vm.serializeUint(k, "interactionLaunchTimestamp", block.timestamp);
        string memory json = vm.serializeUint(k, "rewardPoolFunded", fund);
        vm.createDir(OUT_DIR, true);
        vm.writeJson(json, OUT_FILE);
        console.log("Keeper reward fixture configured: VPFI", vpfi);
        console.log("Sanctions overlay:", address(overlay));
    }
}
