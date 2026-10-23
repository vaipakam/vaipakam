// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {Launch} from "../../script/Launch.s.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
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

/// @dev A price feed stand-in: answers `latestRoundData()` with a price.
contract LaunchFeedStub {
    int256 internal price = 2000e8;

    function setPrice(int256 p) external {
        price = p;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, price, 1, 1, 1);
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

    /// @dev Configure the four Diamond-side requirements.
    function _configure() internal {
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
    }

    function _poolWithLane() internal returns (address) {
        LaunchMockPool pool = new LaunchMockPool();
        uint64[] memory l = new uint64[](1);
        l[0] = 1;
        pool.setLanes(l);
        return address(pool);
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

    /// @dev A pool the artifact does not record is NOT CHECKED, which a
    ///      testnet reports and a production chain refuses.
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
        address pool = address(new LaunchMockPool());
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, pool, address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_AfterHandover_PrintsTimelockProposal() public {
        vm.chainId(84532);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        Launch.Outcome o = launcher.launch(diamond, _poolWithLane(), timelock, admin, ADMIN_KEY);
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
        address pool = _poolWithLane();
        vm.expectRevert(bytes("Launch: the Timelock does not hold UNPAUSER_ROLE - run the handover and its gate first"));
        launcher.launch(diamond, pool, timelock, admin, ADMIN_KEY);
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
        address pool = _poolWithLane();
        vm.expectRevert(
            bytes("Launch: the admin key still holds a Diamond role - the handover is not complete")
        );
        launcher.launch(diamond, pool, timelock, admin, ADMIN_KEY);
    }

    /// @dev Fully ready and handed over: the proposal is printed, nothing is
    ///      broadcast, and the Diamond stays paused even with a key supplied.
    function test_Production_PrintsProposalAndNeverUnpauses() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        Launch.Outcome o = launcher.launch(diamond, _poolWithLane(), timelock, admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.TimelockProposalPrinted));
        assertTrue(AdminFacet(diamond).paused());
    }

    function test_Production_RefusesWithoutAdminAddress() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        address pool = _poolWithLane();
        vm.expectRevert(bytes("Launch: set ADMIN_ADDRESS so the run can prove the admin key holds no role"));
        launcher.launch(diamond, pool, timelock, address(0), 0);
    }

    // ─── The swap route is a real adapter (Codex #2686 r1) ───────────

    function _configureWithAdapter(address adapter) internal {
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
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
        address pool = _poolWithLane();
        vm.expectRevert(
            bytes(
                "Launch: the Diamond is unpaused but the Timelock has not executed this checkout's launch operation - it went live outside the launch step, or the launch used a different LaunchGate build; investigate before anything records a launch"
            )
        );
        launcher.launch(diamond, pool, timelock, admin, 0);
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
        address pool = _poolWithLane();
        vm.etch(LaunchGateDeployment.predicted(), "");
        vm.expectRevert(
            bytes(
                "Launch: the LaunchGate is not deployed at its address - run script/DeployLaunchGate.s.sol (the contracts phase does)"
            )
        );
        launcher.launch(diamond, pool, timelock, admin, 0);
    }

    // ─── The Timelock re-checks readiness when it executes (Codex #2686 r1)

    function _realTimelock() internal returns (VaipakamTimelock tl) {
        address[] memory proposers = new address[](1);
        proposers[0] = PROPOSER;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        tl = new VaipakamTimelock(2 days, proposers, executors, new address[](0));
    }

    function _schedule(VaipakamTimelock tl, address pool) internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = launcher.launchBatch(diamond, pool);
        bytes32 salt = launcher.launchSalt(diamond);
        vm.prank(PROPOSER);
        tl.scheduleBatch(targets, values, payloads, bytes32(0), salt, 2 days);
    }

    function _execute(VaipakamTimelock tl, address pool) internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = launcher.launchBatch(diamond, pool);
        tl.executeBatch(targets, values, payloads, bytes32(0), launcher.launchSalt(diamond));
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
        vm.stopPrank();
        address pool = _poolWithLane();
        VaipakamTimelock tl = _realTimelock();
        _handOverUnpause(address(tl));

        Launch.Outcome printed = launcher.launch(diamond, pool, address(tl), admin, 0);
        assertEq(uint8(printed), uint8(Launch.Outcome.TimelockProposalPrinted));
        _schedule(tl, pool);
        vm.warp(block.timestamp + 2 days);

        // A governance action during the delay (the Timelock holds
        // ADMIN_ROLE after the handover) removes the only swap route.

        vm.prank(address(tl));
        AdminFacet(diamond).setSwapAdapterDisabled(adapter, true);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = launcher.launchBatch(diamond, pool);
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
        _execute(tl, pool);
        assertFalse(AdminFacet(diamond).paused());

        Launch.Outcome o = launcher.launch(diamond, pool, address(tl), admin, 0);
        assertEq(uint8(o), uint8(Launch.Outcome.AlreadyLive));
    }

    function test_Gate_ReportsTheSameChecksAsTheScript() public {
        _configure();
        LaunchGate gate = LaunchGate(LaunchGateDeployment.predicted());
        gate.assertReady(diamond, _poolWithLane());
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "CCIP lanes wired",
                "NOT CHECKED",
                "no vpfiTokenPool recorded"
            )
        );
        gate.assertReady(diamond, address(0));
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
        address pool = _poolWithLane();
        vm.expectRevert(bytes("Launch: the admin key still holds a Diamond role - the handover is not complete"));
        launcher.launch(diamond, pool, timelock, admin, 0);
    }

    // ─── Contracts are probed, not just found (Codex #2686 r2) ───────

    function test_Testnet_RefusesAnOracleThatIsNoSanctionsList() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new LaunchCodeStub()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
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
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
    }
}
