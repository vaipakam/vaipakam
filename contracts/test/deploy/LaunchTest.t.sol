// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {Launch} from "../../script/Launch.s.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {OwnershipFacet} from "../../src/facets/OwnershipFacet.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";
import {MockSanctionsList} from "../mocks/MockSanctionsList.sol";
import {HandoverPlan} from "../../script/lib/HandoverPlan.sol";
import {DeployLaunchGate} from "../../script/DeployLaunchGate.s.sol";
import {LaunchGateDeployment} from "../../script/lib/LaunchGateDeployment.sol";
import {LaunchGate} from "../../src/governance/LaunchGate.sol";
import {VaipakamTimelock} from "../../src/governance/VaipakamTimelock.sol";

/// @dev A CCIP pool stand-in: only `getSupportedChains()` is read.
contract LaunchMockPool {
    uint64[] internal lanes;

    function setLanes(uint64[] memory l) external {
        lanes = l;
    }

    function getSupportedChains() external view returns (uint64[] memory) {
        return lanes;
    }
}

/// @dev A CCIP TokenAdminRegistry stand-in: only `getPool(token)` is read.
contract LaunchMockRegistry {
    mapping(address => address) internal pools;

    function setPool(address token, address pool) external {
        pools[token] = pool;
    }

    function getPool(address token) external view returns (address) {
        return pools[token];
    }
}

/// @dev A Timelock stand-in: the reads `Launch` makes, nothing scheduled.
contract LaunchMockTimelock {
    function getMinDelay() external pure returns (uint256) {
        return 2 days;
    }

    function hashOperationBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(targets, values, payloads, predecessor, salt));
    }

    function isOperationPending(bytes32) external pure returns (bool) {
        return false;
    }

    function isOperationReady(bytes32) external pure returns (bool) {
        return false;
    }

    function isOperationDone(bytes32) external pure returns (bool) {
        return false;
    }
}

/// @dev Has code and implements nothing: registered as a feed, an oracle or
///      a swap adapter, it must NOT count.
contract LaunchCodeStub {}

/// @dev A price feed stand-in: answers `decimals()` and `latestRoundData()`
///      with a price.
contract LaunchFeedStub {
    int256 internal price = 2000e8;

    function setPrice(int256 p) external {
        price = p;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    /// @dev Updated "now", so the oracle's staleness rule passes at any
    ///      warp.
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, price, block.timestamp, block.timestamp, 1);
    }
}

/// @dev A complete aggregator whose round is not well formed: the answer was
///      carried from an earlier round (`answeredInRound != roundId`), which
///      the oracle reads as stale.
contract LaunchCarriedRoundFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (2, 2000e8, block.timestamp, block.timestamp, 1);
    }
}

/// @dev Answers `latestRoundData()` with a price but has no `decimals()`:
///      the oracle layer reads both, so it is no aggregator.
contract LaunchDecimalLessFeed {
    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 2000e8, 1, 1, 1);
    }
}

/// @dev Answers `latestRoundData()` with a round id wider than a `uint80`.
contract LaunchWideRoundFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external pure returns (uint256, int256, uint256, uint256, uint256) {
        return (uint256(type(uint80).max) + 1, 2000e8, 1, 1, 1);
    }
}

/// @dev A swap adapter stand-in: answers `adapterName()` as a real one does.
contract LaunchAdapterStub {
    function adapterName() external pure returns (string memory) {
        return "stub";
    }
}

/// @dev Answers `adapterName()` with an empty string.
contract LaunchNamelessAdapter {
    function adapterName() external pure returns (string memory) {
        return "";
    }
}

/**
 * @title LaunchTest
 * @notice #945 / #946: the deploy leaves the Diamond paused, and the first
 *         unpause goes through `Launch.s.sol`, which reads every
 *         `LibLaunchReadiness` requirement off the chain and follows the
 *         chain's rule — local warns and unpauses, a testnet refuses a NOT
 *         MET check, a production chain refuses anything short of fully
 *         met and never broadcasts (the Timelock unpauses). The Timelock's
 *         launch batch re-checks every requirement through `LaunchGate`
 *         when it executes, and an unpause that did not come through that
 *         operation is never recorded as a launch.
 */
contract LaunchTest is Test {
    uint256 internal constant DEPLOYER_KEY = 1;
    uint256 internal constant ADMIN_KEY = 2;
    address internal constant PROPOSER = address(0x5AFE);
    address internal constant TREASURY = address(0xBEEF);
    address internal constant VPFI = address(0xF1F1);
    address internal constant WETH = address(0xE7E7);

    address internal diamond;
    address internal admin;
    Launch internal launcher;

    function setUp() public {
        admin = vm.addr(ADMIN_KEY);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");
        DeployDiamond script = new DeployDiamond();
        script.runWith(admin, TREASURY, DEPLOYER_KEY);
        diamond = script.diamond();
        launcher = new Launch();
        new DeployLaunchGate().deploy(DEPLOYER_KEY);
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    /// @dev Configure the four Diamond-side requirements, and the VPFI token
    ///      the lane check reads the pool for.
    function _configure() internal {
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        VPFITokenFacet(diamond).setVPFIToken(VPFI);
        OracleAdminFacet(diamond).setWethContract(WETH);
        vm.stopPrank();
    }

    /// @dev A TokenAdminRegistry mapping the Diamond's VPFI token to a pool
    ///      with one lane.
    function _registryWithLane() internal returns (address) {
        LaunchMockPool pool = new LaunchMockPool();
        uint64[] memory l = new uint64[](1);
        l[0] = 1;
        pool.setLanes(l);
        LaunchMockRegistry registry = new LaunchMockRegistry();
        registry.setPool(VPFI, address(pool));
        return address(registry);
    }

    function _epoch() internal view returns (uint64) {
        return launcher.pauseEpoch(diamond);
    }

    /// @dev The handover's end state: the Timelock holds the role root, every
    ///      Timelock role and the ownership; the admin key holds no role at
    ///      all. Ownership moves before the root is renounced, as the Diamond
    ///      requires.
    function _handOverUnpause(address timelock) internal {
        bytes32[] memory tl = HandoverPlan.timelockRoles();
        bytes32[] memory all = HandoverPlan.diamondRoles();
        vm.startPrank(admin);
        AccessControlFacet(diamond).grantRole(bytes32(0), timelock);
        for (uint256 i; i < tl.length; ++i) {
            AccessControlFacet(diamond).grantRole(tl[i], timelock);
        }
        OwnershipFacet(diamond).transferOwnership(timelock);
        for (uint256 i = all.length; i > 0; --i) {
            if (AccessControlFacet(diamond).hasRole(all[i - 1], admin)) {
                AccessControlFacet(diamond).renounceRole(all[i - 1], admin);
            }
        }
        vm.stopPrank();
        for (uint256 i; i < all.length; ++i) {
            assertFalse(AccessControlFacet(diamond).hasRole(all[i], admin), "admin keeps no role");
        }
    }

    // ─── The deploy leaves it paused ─────────────────────────────────

    function test_DeployLeavesDiamondPaused() public view {
        assertTrue(AdminFacet(diamond).paused());
    }

    // ─── Local anvil ─────────────────────────────────────────────────

    /// @dev Unconfigured, as a mock rig is: warned about, then unpaused.
    function test_Local_UnpausesDespiteUnmetChecks() public {
        Launch.Outcome o = launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.Unpaused));
        assertFalse(AdminFacet(diamond).paused());
    }

    function test_AlreadyLive_IsLeftAlone() public {
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        Launch.Outcome o = launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.AlreadyLive));
    }

    // ─── Testnet ─────────────────────────────────────────────────────

    function test_Testnet_RefusesWithoutSanctionsOracle() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        assertTrue(AdminFacet(diamond).paused());
    }

    function test_Testnet_RefusesWithADisabledOnlySwapRoute() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        address adapter = address(new LaunchAdapterStub());
        AdminFacet(diamond).addSwapAdapter(adapter);
        AdminFacet(diamond).setSwapAdapterDisabled(adapter, true);
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    /// @dev No CCIP registry given leaves the lane check NOT CHECKED, which
    ///      a testnet reports and a production chain refuses.
    function test_Testnet_ConfiguredUnpausesByAdmin() public {
        vm.chainId(84532);
        _configure();
        Launch.Outcome o = launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.Unpaused));
        assertFalse(AdminFacet(diamond).paused());
    }

    function test_Testnet_RefusesALaneLessPool() public {
        vm.chainId(84532);
        _configure();
        LaunchMockRegistry registry = new LaunchMockRegistry();
        registry.setPool(VPFI, address(new LaunchMockPool()));
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(registry), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_AfterHandover_PrintsTimelockProposal() public {
        vm.chainId(84532);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        Launch.Outcome o = launcher.launch(diamond, _registryWithLane(), timelock, admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.TimelockProposalPrinted));
        assertTrue(AdminFacet(diamond).paused(), "printing a proposal unpauses nothing");
    }

    // ─── Production ──────────────────────────────────────────────────

    function test_Production_RefusesANotCheckedPool() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        vm.expectRevert(
            bytes(
                "Launch: a production Diamond is unpaused only when every readiness check is met (NOT MET and NOT CHECKED both refuse)"
            )
        );
        launcher.launch(diamond, address(0), timelock, admin, 0);
    }

    function test_Production_RefusesBeforeHandover() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        address registry = _registryWithLane();
        vm.expectRevert(bytes("Launch: the Timelock does not hold UNPAUSER_ROLE - run the handover and its gate first"));
        launcher.launch(diamond, registry, timelock, admin, ADMIN_KEY);
        assertTrue(AdminFacet(diamond).paused());
    }

    /// @dev The Timelock holds the role but the admin key kept it too: the
    ///      handover is not complete, so the hot key could still unpause.
    function test_Production_RefusesWhileAdminStillHoldsUnpauser() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        vm.startPrank(admin);
        AccessControlFacet(diamond).grantRole(LibAccessControl.UNPAUSER_ROLE, timelock);
        vm.stopPrank();
        address registry = _registryWithLane();
        vm.expectRevert(
            bytes("Launch: the admin key still holds a Diamond role - the handover is not complete")
        );
        launcher.launch(diamond, registry, timelock, admin, ADMIN_KEY);
    }

    /// @dev Fully ready and handed over: the proposal is printed, nothing is
    ///      broadcast, and the Diamond stays paused even with a key supplied.
    function test_Production_PrintsProposalAndNeverUnpauses() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        Launch.Outcome o = launcher.launch(diamond, _registryWithLane(), timelock, admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.TimelockProposalPrinted));
        assertTrue(AdminFacet(diamond).paused());
    }

    function test_Production_RefusesWithoutAdminAddress() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        address registry = _registryWithLane();
        vm.expectRevert(bytes("Launch: set ADMIN_ADDRESS so the run can prove the admin key holds no role"));
        launcher.launch(diamond, registry, timelock, address(0), 0);
    }

    // ─── The swap route is a real adapter (Codex #2686 r1) ───────────

    function _configureWithAdapter(address adapter) internal {
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        OracleAdminFacet(diamond).setWethContract(WETH);
        AdminFacet(diamond).addSwapAdapter(adapter);
        vm.stopPrank();
    }

    function test_Testnet_RefusesAnEoaSwapAdapter() public {
        vm.chainId(84532);
        _configureWithAdapter(address(0xEEEE));
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAContractThatIsNoAdapter() public {
        vm.chainId(84532);
        _configureWithAdapter(address(new LaunchCodeStub()));
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesANamelessAdapter() public {
        vm.chainId(84532);
        _configureWithAdapter(address(new LaunchNamelessAdapter()));
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    // ─── An unpause is recorded only on evidence (Codex #2686 r1) ────

    /// @dev Unpaused straight from the admin key on a production chain: the
    ///      Timelock never ran the launch operation, so the run refuses
    ///      rather than letting the wrapper record a launch.
    function test_Production_RefusesAnUnpauseOutsideTheLaunchStep() public {
        vm.chainId(8453);
        _configure();
        vm.prank(admin);
        AdminFacet(diamond).unpause();
        address timelock = address(new LaunchMockTimelock());
        address registry = _registryWithLane();
        vm.expectRevert(
            bytes(
                "Launch: the Timelock has not executed this checkout's launch operation - the Diamond went live outside the launch step, the launch used a different LaunchGate build, registry or admin address, or it has not launched; investigate before anything records a launch"
            )
        );
        launcher.launch(diamond, registry, timelock, admin, 0);
    }

    function test_Testnet_RefusesAnUnreadyDiamondAlreadyUnpaused() public {
        vm.chainId(84532);
        vm.prank(admin);
        AdminFacet(diamond).unpause();
        vm.expectRevert(
            bytes(
                "Launch: the Diamond is unpaused but a readiness check is NOT MET - it went live before it was ready; complete the phase named above, then re-run"
            )
        );
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_TimelockPathRefusesANotCheckedPool() public {
        vm.chainId(84532);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        vm.expectRevert(
            bytes(
                "Launch: a Timelock launch needs every readiness check met - the LaunchGate inside the batch refuses NOT CHECKED too"
            )
        );
        launcher.launch(diamond, address(0), timelock, admin, ADMIN_KEY);
    }

    function test_Production_RefusesWithoutTheGate() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        address registry = _registryWithLane();
        vm.etch(LaunchGateDeployment.predicted(), "");
        vm.expectRevert(
            bytes(
                "Launch: the LaunchGate is not deployed at its address - run script/DeployLaunchGate.s.sol (the contracts phase does)"
            )
        );
        launcher.launch(diamond, registry, timelock, admin, 0);
    }

    // ─── The Timelock re-checks readiness when it executes (Codex #2686 r1)

    function _realTimelock() internal returns (VaipakamTimelock tl) {
        address[] memory proposers = new address[](1);
        proposers[0] = PROPOSER;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        tl = new VaipakamTimelock(2 days, proposers, executors, new address[](0));
    }

    function _schedule(VaipakamTimelock tl, address registry, uint64 epoch) internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, registry, admin, epoch);
        bytes32 salt = launcher.launchSalt(diamond);
        vm.prank(PROPOSER);
        tl.scheduleBatch(targets, values, payloads, bytes32(0), salt, 2 days);
    }

    function _execute(VaipakamTimelock tl, address registry, uint64 epoch) internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, registry, admin, epoch);
        tl.executeBatch(targets, values, payloads, bytes32(0), launcher.launchSalt(diamond));
    }

    /// @dev A production Diamond, configured and handed over to a real
    ///      Timelock, with the launch batch scheduled at the current epoch
    ///      and its delay elapsed.
    function _scheduledLaunch() internal returns (VaipakamTimelock tl, address registry, uint64 epoch) {
        vm.chainId(8453);
        _configure();
        registry = _registryWithLane();
        tl = _realTimelock();
        _handOverUnpause(address(tl));
        Launch.Outcome printed = launcher.launch(diamond, registry, address(tl), admin, 0);
        assertEq(uint8(printed), uint8(Launch.Outcome.TimelockProposalPrinted));
        epoch = _epoch();
        _schedule(tl, registry, epoch);
        vm.warp(block.timestamp + 2 days);
    }

    /// @dev The last swap adapter is disabled during the delay: the batch
    ///      reverts inside the gate and the Diamond stays paused. Once the
    ///      route is restored the same operation executes, and a re-run of
    ///      the launch step then records the launch from the Timelock's own
    ///      DONE state.
    function test_Production_TimelockExecutionRechecksReadiness() public {
        vm.chainId(8453);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        address adapter = address(new LaunchAdapterStub());
        AdminFacet(diamond).addSwapAdapter(adapter);
        VPFITokenFacet(diamond).setVPFIToken(VPFI);
        OracleAdminFacet(diamond).setWethContract(WETH);
        vm.stopPrank();
        address registry = _registryWithLane();
        VaipakamTimelock tl = _realTimelock();
        _handOverUnpause(address(tl));

        Launch.Outcome printed = launcher.launch(diamond, registry, address(tl), admin, 0);
        assertEq(uint8(printed), uint8(Launch.Outcome.TimelockProposalPrinted));
        uint64 epoch = _epoch();
        _schedule(tl, registry, epoch);
        vm.warp(block.timestamp + 2 days);

        // A governance action during the delay (the Timelock holds
        // ADMIN_ROLE after the handover) removes the only swap route.

        vm.prank(address(tl));
        AdminFacet(diamond).setSwapAdapterDisabled(adapter, true);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, registry, admin, epoch);
        bytes32 salt = launcher.launchSalt(diamond);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "swap route registered",
                "NOT MET",
                "no enabled swap adapter that is a contract answering adapterName(): run the swap-adapters phase"
            )
        );
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertTrue(AdminFacet(diamond).paused(), "a failed re-check leaves the Diamond paused");

        vm.prank(address(tl));
        AdminFacet(diamond).setSwapAdapterDisabled(adapter, false);
        _execute(tl, registry, epoch);
        assertFalse(AdminFacet(diamond).paused());

        Launch.Outcome o = launcher.launch(diamond, registry, address(tl), admin, 0);
        assertEq(uint8(o), uint8(Launch.Outcome.AlreadyLive));
        launcher.checkLaunched(diamond, registry, address(tl), admin);
    }

    /// @dev Configured, handed over to a mock Timelock, and the gate passes;
    ///      it refuses the same Diamond with the lane check left unanswered.
    function test_Gate_ReportsTheSameChecksAsTheScript() public {
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        LaunchGate gate = LaunchGate(LaunchGateDeployment.predicted());
        gate.assertReady(diamond, _registryWithLane(), admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "CCIP lanes wired",
                "NOT CHECKED",
                "no CCIP TokenAdminRegistry given (CCIP_TOKEN_ADMIN_REGISTRY), so the VPFI pool is unknown"
            )
        );
        gate.assertReady(diamond, address(0), admin);
    }

    // ─── Round 3 (Codex #2686 r3) ────────────────────────────────────

    /// @dev A guardian with PAUSER_ROLE, as the handover appoints one.
    function _guardian(VaipakamTimelock tl) internal returns (address guardian) {
        guardian = address(0x6A2D);
        vm.prank(address(tl));
        AccessControlFacet(diamond).grantRole(LibAccessControl.PAUSER_ROLE, guardian);
    }

    /// @dev An incident pause recorded during the delay (a guardian pauses
    ///      the already-paused Diamond) moves the pause epoch: the scheduled
    ///      launch then reverts instead of clearing a pause it never saw,
    ///      and the Diamond stays paused.
    function test_Production_IncidentPauseDuringDelayRevertsTheLaunch() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        vm.prank(_guardian(tl));
        AdminFacet(diamond).pause();
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, registry, admin, epoch);
        bytes32 salt = launcher.launchSalt(diamond);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.PauseEpochMoved.selector, epoch, epoch + 1));
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertTrue(AdminFacet(diamond).paused(), "the incident pause stands");
    }

    /// @dev The admin key gets a role back during the delay: the gate
    ///      refuses on execution, so the Diamond never goes live with a hot
    ///      key that can still act on it.
    function test_Production_AdminRegainingARoleDuringDelayRevertsTheLaunch() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        vm.prank(address(tl));
        AccessControlFacet(diamond).grantRole(LibAccessControl.PAUSER_ROLE, admin);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, registry, admin, epoch);
        bytes32 salt = launcher.launchSalt(diamond);
        vm.expectRevert(
            abi.encodeWithSelector(LaunchGate.DeployKeyHoldsRole.selector, admin, LibAccessControl.PAUSER_ROLE)
        );
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertTrue(AdminFacet(diamond).paused());
    }

    function test_Gate_RefusesAZeroDeployKey() public {
        _configure();
        LaunchGate gate = LaunchGate(LaunchGateDeployment.predicted());
        address registry = _registryWithLane();
        vm.expectRevert(LaunchGate.NoDeployKey.selector);
        gate.assertReady(diamond, registry, address(0));
    }

    /// @dev A launched production Diamond paused and unpaused again for an
    ///      incident still shows its launch: the evidence is the Timelock's
    ///      DONE operation at the epoch it was bound to, found by search.
    function test_Production_LaunchEvidenceSurvivesALaterIncident() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _execute(tl, registry, epoch);
        vm.prank(_guardian(tl));
        AdminFacet(diamond).pause();
        assertEq(
            launcher.checkLaunched(diamond, registry, address(tl), admin),
            "launched by the Timelock's launch operation, and PAUSED now: lifting that pause is incident response (GovernanceRunbook), not a launch",
            "an incident-paused Diamond is reported launched, never live"
        );
        vm.prank(address(tl));
        AdminFacet(diamond).unpause();
        assertEq(
            launcher.checkLaunched(diamond, registry, address(tl), admin),
            "launched by the Timelock's launch operation, and unpaused now"
        );
    }

    function test_Production_CheckLaunchedRefusesBeforeExecution() public {
        (VaipakamTimelock tl, address registry,) = _scheduledLaunch();
        vm.expectRevert(bytes("Launch: the Diamond has not launched"));
        launcher.checkLaunched(diamond, registry, address(tl), admin);
    }

    function test_Testnet_CheckLaunchedRefusesAPausedDiamond() public {
        vm.chainId(84532);
        _configure();
        vm.expectRevert(bytes("Launch: the Diamond has not launched"));
        launcher.checkLaunched(diamond, address(0), address(0), admin);
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        launcher.checkLaunched(diamond, address(0), address(0), admin);
    }

    function test_Testnet_RefusesARegistryWithNoPoolForVpfi() public {
        vm.chainId(84532);
        _configure();
        address registry = address(new LaunchMockRegistry());
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, registry, address(0), admin, ADMIN_KEY);
    }

    /// @dev A lane-wired pool registered for some OTHER token does not stand
    ///      in for the Diamond's VPFI pool.
    function test_Testnet_RefusesAPoolRegisteredForAnotherToken() public {
        vm.chainId(84532);
        _configure();
        LaunchMockPool pool = new LaunchMockPool();
        uint64[] memory l = new uint64[](1);
        l[0] = 1;
        pool.setLanes(l);
        LaunchMockRegistry registry = new LaunchMockRegistry();
        registry.setPool(address(0xD00D), address(pool));
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(registry), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesWithoutAVpfiToken() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        address registry = _registryWithLane();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, registry, address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAFeedWithoutDecimals() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchDecimalLessFeed()));
        OracleAdminFacet(diamond).setWethContract(WETH);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAFeedWithAnOutOfRangeRound() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchWideRoundFeed()));
        OracleAdminFacet(diamond).setWethContract(WETH);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    // ─── Every role leaves the admin key (Codex #2686 r2) ────────────

    /// @dev The handover completed, then the admin key got RISK_ADMIN back:
    ///      it could still retune the protocol, so the launch refuses.
    function test_Production_RefusesWhileAdminKeepsAnyRole() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        vm.prank(timelock);
        AccessControlFacet(diamond).grantRole(LibAccessControl.RISK_ADMIN_ROLE, admin);
        address registry = _registryWithLane();
        vm.expectRevert(bytes("Launch: the admin key still holds a Diamond role - the handover is not complete"));
        launcher.launch(diamond, registry, timelock, admin, 0);
    }

    // ─── Contracts are probed, not just found (Codex #2686 r2) ───────

    function test_Testnet_RefusesAnOracleThatIsNoSanctionsList() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new LaunchCodeStub()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        OracleAdminFacet(diamond).setWethContract(WETH);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAFeedThatIsNoFeed() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchCodeStub()));
        OracleAdminFacet(diamond).setWethContract(WETH);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAFeedWithNoPrice() public {
        vm.chainId(84532);
        LaunchFeedStub feed = new LaunchFeedStub();
        feed.setPrice(0);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(feed));
        OracleAdminFacet(diamond).setWethContract(WETH);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    // ─── Round 4 (Codex #2686 r4) ────────────────────────────────────

    function test_DeployLeavesTheBirthEpoch() public view {
        assertEq(launcher.pauseEpoch(diamond), launcher.BIRTH_EPOCH());
    }

    /// @dev Launched through the Timelock, then paused for an incident: a
    ///      re-run reports the launch and proposes NOTHING, so no fresh batch
    ///      bound to the incident's epoch is ever printed to lift it.
    function test_Production_RerunDuringAnIncidentProposesNothing() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _execute(tl, registry, epoch);
        vm.prank(_guardian(tl));
        AdminFacet(diamond).pause();
        Launch.Decision memory d = launcher.decide(diamond, registry, address(tl), admin, false);
        assertEq(uint8(d.path), uint8(Launch.Path.Launched));
        Launch.Outcome o = launcher.launch(diamond, registry, address(tl), admin, 0);
        assertEq(uint8(o), uint8(Launch.Outcome.AlreadyLive));
        assertTrue(AdminFacet(diamond).paused(), "the incident pause stands");
    }

    /// @dev A testnet Diamond the admin launched and a guardian then paused:
    ///      nothing on chain records the admin's launch, so the run cannot
    ///      tell this from a pause before launch and refuses to unpause.
    function test_Testnet_AdminWillNotLiftAPauseAfterBirth() public {
        vm.chainId(84532);
        _configure();
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        vm.prank(admin);
        AdminFacet(diamond).pause();
        vm.expectRevert(
            bytes(
                "Launch: the Diamond has been paused since its birth pause, so it may have launched and be paused for an incident - lifting that is incident response, not a launch. If it never went live, re-run with LAUNCH_ACK_PAUSE_EPOCH set to the epoch printed above"
            )
        );
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        assertTrue(AdminFacet(diamond).paused());
    }

    /// @dev Paused again before it ever launched: the operator states it
    ///      never went live by naming the epoch, and the admin unpauses.
    function test_Testnet_AckedEpochLetsTheAdminLaunch() public {
        vm.chainId(84532);
        _configure();
        vm.prank(admin);
        AdminFacet(diamond).pause();
        uint64 epoch = _epoch();
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("LAUNCH_ACK_PAUSE_EPOCH", vm.toString(uint256(epoch)));
        Launch.Outcome o = launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("LAUNCH_ACK_PAUSE_EPOCH", "0");
        assertEq(uint8(o), uint8(Launch.Outcome.Unpaused));
        assertFalse(AdminFacet(diamond).paused());
    }

    /// @dev The report is the launch's own decision: before the handover a
    ///      production deployment is not launchable, whatever the checks say.
    function test_Decide_ProductionBeforeHandoverIsNotLaunchable() public {
        vm.chainId(8453);
        _configure();
        Launch.Decision memory d =
            launcher.decide(diamond, _registryWithLane(), address(new LaunchMockTimelock()), admin, true);
        assertEq(uint8(d.path), uint8(Launch.Path.Refuse));
        assertEq(d.reason, "Launch: the Timelock does not hold UNPAUSER_ROLE - run the handover and its gate first");
    }

    function test_Testnet_RefusesWithoutWeth() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    /// @dev The Diamond's own oracle reads a carried-over round as stale, so
    ///      the launch does too.
    function test_Testnet_RefusesACarriedRound() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchCarriedRoundFeed()));
        OracleAdminFacet(diamond).setWethContract(WETH);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }

    // ─── Round 5 (Codex #2686 r5): a bounded launch-evidence search ─────

    string private constant LAUNCH_UNKNOWN =
        "Launch: the pause epoch is past the launch-evidence search window and no launch operation was found in it, so whether this Diamond launched is UNKNOWN. Set LAUNCH_OPERATION_EPOCH to the epoch an executed launch proposal names; if it never launched, set LAUNCH_ACK_PAUSE_EPOCH to the epoch printed above";

    /// @dev Every `pause()` is a transition, even on a paused Diamond, so a
    ///      Pauser can push the epoch past any search window.
    function _inflateEpoch(address pauser) internal {
        uint256 n = uint256(launcher.EVIDENCE_SCAN_EPOCHS()) + 8;
        vm.startPrank(pauser);
        for (uint256 i; i < n; ++i) {
            AdminFacet(diamond).pause();
        }
        vm.stopPrank();
    }

    /// @dev A launch older than the window, buried under an inflated epoch:
    ///      the run cannot read it, so it neither proposes a second unpause
    ///      nor calls the Diamond unlaunched. Naming the launch's epoch finds
    ///      it again.
    function test_Production_InflatedEpochDoesNotHideALaunch() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _execute(tl, registry, epoch);
        _inflateEpoch(_guardian(tl));

        Launch.Decision memory d = launcher.decide(diamond, registry, address(tl), admin, false);
        assertEq(uint8(d.path), uint8(Launch.Path.Refuse));
        assertTrue(d.launchUnknown);
        vm.expectRevert(bytes(LAUNCH_UNKNOWN));
        launcher.checkLaunched(diamond, registry, address(tl), admin);
        vm.expectRevert(bytes(LAUNCH_UNKNOWN));
        launcher.launch(diamond, registry, address(tl), admin, 0);

        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("LAUNCH_OPERATION_EPOCH", vm.toString(uint256(epoch)));
        string memory evidence = launcher.checkLaunched(diamond, registry, address(tl), admin);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("LAUNCH_OPERATION_EPOCH", vm.toString(type(uint256).max));
        assertEq(
            evidence,
            "launched by the Timelock's launch operation, and PAUSED now: lifting that pause is incident response (GovernanceRunbook), not a launch"
        );
        assertTrue(AdminFacet(diamond).paused(), "the incident pause stands");
    }

    /// @dev Inflated before it ever launched: the operator's statement that
    ///      it never went live (the epoch, acknowledged) lets the run print
    ///      the proposal; without it the run refuses.
    function test_Production_InflatedEpochBeforeLaunchNeedsTheAck() public {
        vm.chainId(8453);
        _configure();
        address registry = _registryWithLane();
        VaipakamTimelock tl = _realTimelock();
        _handOverUnpause(address(tl));
        _inflateEpoch(_guardian(tl));

        vm.expectRevert(bytes(LAUNCH_UNKNOWN));
        launcher.launch(diamond, registry, address(tl), admin, 0);

        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("LAUNCH_ACK_PAUSE_EPOCH", vm.toString(uint256(_epoch())));
        Launch.Outcome o = launcher.launch(diamond, registry, address(tl), admin, 0);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("LAUNCH_ACK_PAUSE_EPOCH", "0");
        assertEq(uint8(o), uint8(Launch.Outcome.TimelockProposalPrinted));
        assertTrue(AdminFacet(diamond).paused());
    }

    /// @dev Inside the window nothing changes: a launch a few epochs back is
    ///      found by the search alone.
    function test_Production_LaunchInsideTheWindowNeedsNoHint() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _execute(tl, registry, epoch);
        address guardian = _guardian(tl);
        vm.startPrank(guardian);
        for (uint256 i; i < 10; ++i) {
            AdminFacet(diamond).pause();
        }
        vm.stopPrank();
        Launch.Decision memory d = launcher.decide(diamond, registry, address(tl), admin, false);
        assertEq(uint8(d.path), uint8(Launch.Path.Launched));
    }
}
