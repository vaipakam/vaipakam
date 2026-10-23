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
import {ILaunchGate} from "../../src/interfaces/ILaunchGate.sol";
import {LibLaunchReadiness} from "../../src/governance/LibLaunchReadiness.sol";
import {VaipakamTimelock} from "../../src/governance/VaipakamTimelock.sol";

/// @dev Whoever owns the Diamond, read live: the route mocks below answer
///      their authority reads with it unless a test overrides one.
interface ILaunchOwnerView {
    function owner() external view returns (address);
}

/// @dev Authority reads that follow the Diamond's owner by default.
abstract contract LaunchFollowsOwner {
    address internal followed;
    address internal ownerOverride;

    function follow(address diamond) external {
        followed = diamond;
    }

    function setOwner(address o) external {
        ownerOverride = o;
    }

    function owner() public view returns (address) {
        if (ownerOverride != address(0) || followed == address(0)) return ownerOverride;
        return ILaunchOwnerView(followed).owner();
    }
}

/// @dev A `VpfiPoolRateGovernor` stand-in: its owner and the pool it
///      administers.
contract LaunchMockGovernor is LaunchFollowsOwner {
    address public pool;
    address public pendingOwner;

    constructor(address pool_) {
        pool = pool_;
    }

    function setPendingOwner(address p) external {
        pendingOwner = p;
    }
}

/// @dev A CCIP pool stand-in: its lanes, and each lane's rate-limiter
///      buckets (enabled at the starting values by default), its owner and
///      its rate-limit admin.
contract LaunchMockPool is LaunchFollowsOwner {
    address internal rateLimitAdmin;

    function setRateLimitAdmin(address a) external {
        rateLimitAdmin = a;
    }

    function getRateLimitAdmin() external view returns (address) {
        return rateLimitAdmin;
    }

    /// @dev CCIP's `RateLimiter.TokenBucket`, field for field.
    struct Bucket {
        uint128 tokens;
        uint32 lastUpdated;
        bool isEnabled;
        uint128 capacity;
        uint128 rate;
    }

    uint64[] internal lanes;
    mapping(uint64 => mapping(bool => Bucket)) internal buckets;

    function setLanes(uint64[] memory l) external {
        lanes = l;
        for (uint256 i; i < l.length; ++i) {
            buckets[l[i]][true] = Bucket(50_000 ether, 0, true, 50_000 ether, 6 ether);
            buckets[l[i]][false] = Bucket(50_000 ether, 0, true, 50_000 ether, 6 ether);
        }
    }

    function setLimit(uint64 lane, bool inbound, bool enabled, uint128 capacity, uint128 rate) external {
        buckets[lane][inbound] = Bucket(capacity, 0, enabled, capacity, rate);
    }

    function getSupportedChains() external view returns (uint64[] memory) {
        return lanes;
    }

    function getCurrentInboundRateLimiterState(uint64 lane) external view returns (Bucket memory) {
        return buckets[lane][true];
    }

    function getCurrentOutboundRateLimiterState(uint64 lane) external view returns (Bucket memory) {
        return buckets[lane][false];
    }
}

/// @dev A CCIP TokenAdminRegistry stand-in: `getPool(token)` and
///      `getTokenConfig(token)`, whose administrator follows the Diamond's
///      owner by default.
contract LaunchMockRegistry is LaunchFollowsOwner {
    struct TokenConfig {
        address administrator;
        address pendingAdministrator;
        address tokenPool;
    }

    mapping(address => address) internal pools;
    address internal pendingAdministrator;

    function setPendingAdministrator(address p) external {
        pendingAdministrator = p;
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory) {
        return TokenConfig(owner(), pendingAdministrator, pools[token]);
    }

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

/// @dev A WETH stand-in: a contract answering `decimals()` with 18, as every
///      chain's bridged WETH9 does.
contract LaunchWethStub {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

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
    /// @dev The Pauser Safe stand-in the handover appoints.
    address internal constant GUARDIAN = address(0x6A2D);

    address internal diamond;
    address internal admin;
    address internal weth;
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
        weth = address(new LaunchWethStub());
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
        OracleAdminFacet(diamond).setWethContract(weth);
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
        LaunchMockGovernor governor = new LaunchMockGovernor(address(pool));
        pool.setRateLimitAdmin(address(governor));
        pool.follow(diamond);
        registry.follow(diamond);
        governor.follow(diamond);
        wiredPool[address(registry)] = address(pool);
        wiredGovernor[address(registry)] = address(governor);
        return address(registry);
    }

    /// @dev What `_registryWithLane` wired, recorded test-side so `_d` makes
    ///      no external call (it is evaluated between `vm.expectRevert` and
    ///      the call under test).
    mapping(address => address) internal wiredPool;
    mapping(address => address) internal wiredGovernor;

    /// @dev What a launch declares for `registry`: the pool and lane
    ///      `_registryWithLane` wired for it (nothing for a registry built by
    ///      hand), and the fixture's WETH. The tests below that probe a
    ///      mismatch build their own.
    function _d(address registry) internal view returns (LibLaunchReadiness.Declared memory d) {
        d.tokenAdminRegistry = registry;
        d.weth = weth;
        d.vpfiPool = wiredPool[registry];
        d.rateGovernor = wiredGovernor[registry];
        if (d.vpfiPool != address(0)) {
            d.lanes = new uint64[](1);
            d.lanes[0] = 1;
        }
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
        AccessControlFacet(diamond).grantRole(LibAccessControl.PAUSER_ROLE, GUARDIAN);
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
        // What the handover gate would prove here, as the wrapper hands it on.
        handedTo = timelock;
        provenEpoch = AccessControlFacet(diamond).roleEpoch();
        launcher.setHandoverProof(provenEpoch);
    }

    /// @dev The last handover's end state, as a launch binds it. Call-free,
    ///      like `_d`.
    address internal handedTo;
    uint64 internal provenEpoch;

    function _h() internal view returns (ILaunchGate.Handover memory) {
        return ILaunchGate.Handover({deployKey: admin, owner: handedTo, roleEpoch: provenEpoch});
    }

    // ─── The deploy leaves it paused ─────────────────────────────────

    function test_DeployLeavesDiamondPaused() public view {
        assertTrue(AdminFacet(diamond).paused());
    }

    // ─── Local anvil ─────────────────────────────────────────────────

    /// @dev Unconfigured, as a mock rig is: warned about, then unpaused.
    function test_Local_UnpausesDespiteUnmetChecks() public {
        Launch.Outcome o = launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.Unpaused));
        assertFalse(AdminFacet(diamond).paused());
    }

    function test_AlreadyLive_IsLeftAlone() public {
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
        Launch.Outcome o = launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
    }

    /// @dev No CCIP registry given leaves the lane check NOT CHECKED, which
    ///      a testnet reports and a production chain refuses.
    function test_Testnet_ConfiguredUnpausesByAdmin() public {
        vm.chainId(84532);
        _configure();
        Launch.Outcome o = launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.Unpaused));
        assertFalse(AdminFacet(diamond).paused());
    }

    function test_Testnet_RefusesALaneLessPool() public {
        vm.chainId(84532);
        _configure();
        LaunchMockRegistry registry = new LaunchMockRegistry();
        registry.setPool(VPFI, address(new LaunchMockPool()));
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(registry)), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_AfterHandover_PrintsTimelockProposal() public {
        vm.chainId(84532);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        Launch.Outcome o = launcher.launch(diamond, _d(_registryWithLane()), timelock, admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(address(0)), timelock, admin, 0);
    }

    function test_Production_RefusesBeforeHandover() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        address registry = _registryWithLane();
        vm.expectRevert(bytes("Launch: the Timelock does not hold UNPAUSER_ROLE - run the handover and its gate first"));
        launcher.launch(diamond, _d(registry), timelock, admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(registry), timelock, admin, ADMIN_KEY);
    }

    /// @dev Fully ready and handed over: the proposal is printed, nothing is
    ///      broadcast, and the Diamond stays paused even with a key supplied.
    function test_Production_PrintsProposalAndNeverUnpauses() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        Launch.Outcome o = launcher.launch(diamond, _d(_registryWithLane()), timelock, admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(registry), timelock, address(0), 0);
    }

    // ─── The swap route is a real adapter (Codex #2686 r1) ───────────

    function _configureWithAdapter(address adapter) internal {
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        OracleAdminFacet(diamond).setWethContract(weth);
        AdminFacet(diamond).addSwapAdapter(adapter);
        vm.stopPrank();
    }

    function test_Testnet_RefusesAnEoaSwapAdapter() public {
        vm.chainId(84532);
        _configureWithAdapter(address(0xEEEE));
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAContractThatIsNoAdapter() public {
        vm.chainId(84532);
        _configureWithAdapter(address(new LaunchCodeStub()));
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesANamelessAdapter() public {
        vm.chainId(84532);
        _configureWithAdapter(address(new LaunchNamelessAdapter()));
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
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
                string.concat(
                    "Launch: the Diamond was first unpaused by ",
                    vm.toString(admin),
                    ", not the Timelock - it went live outside the launch step; investigate before anything records a launch"
                )
            )
        );
        launcher.launch(diamond, _d(registry), timelock, admin, 0);
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
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(address(0)), timelock, admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(registry), timelock, admin, 0);
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
            launcher.launchBatch(diamond, _d(registry), _h(), epoch);
        bytes32 salt = launcher.launchSalt(diamond);
        vm.prank(PROPOSER);
        tl.scheduleBatch(targets, values, payloads, bytes32(0), salt, 2 days);
    }

    function _execute(VaipakamTimelock tl, address registry, uint64 epoch) internal {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, _d(registry), _h(), epoch);
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
        Launch.Outcome printed = launcher.launch(diamond, _d(registry), address(tl), admin, 0);
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
        OracleAdminFacet(diamond).setWethContract(weth);
        vm.stopPrank();
        address registry = _registryWithLane();
        VaipakamTimelock tl = _realTimelock();
        _handOverUnpause(address(tl));

        Launch.Outcome printed = launcher.launch(diamond, _d(registry), address(tl), admin, 0);
        assertEq(uint8(printed), uint8(Launch.Outcome.TimelockProposalPrinted));
        uint64 epoch = _epoch();
        _schedule(tl, registry, epoch);
        vm.warp(block.timestamp + 2 days);

        // A governance action during the delay (the Timelock holds
        // ADMIN_ROLE after the handover) removes the only swap route.

        vm.prank(address(tl));
        AdminFacet(diamond).setSwapAdapterDisabled(adapter, true);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, _d(registry), _h(), epoch);
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

        Launch.Outcome o = launcher.launch(diamond, _d(registry), address(tl), admin, 0);
        assertEq(uint8(o), uint8(Launch.Outcome.AlreadyLive));
        launcher.checkLaunched(diamond, _d(registry), address(tl), admin);
    }

    /// @dev Configured, handed over to a mock Timelock, and the gate passes;
    ///      it refuses the same Diamond with the lane check left unanswered.
    function test_Gate_ReportsTheSameChecksAsTheScript() public {
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        LaunchGate gate = LaunchGate(LaunchGateDeployment.predicted());
        gate.assertReady(diamond, _d(_registryWithLane()), _h());
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "VPFI routes through the declared pool, governed by the Diamond's owner",
                "NOT CHECKED",
                "no CCIP TokenAdminRegistry given (CCIP_TOKEN_ADMIN_REGISTRY), so the VPFI pool is unknown"
            )
        );
        gate.assertReady(diamond, _d(address(0)), _h());
    }

    // ─── Round 3 (Codex #2686 r3) ────────────────────────────────────

    /// @dev A guardian with PAUSER_ROLE, as the handover appoints one.
    ///      The handover appoints it, so the launch's role epoch covers it.
    function _guardian(VaipakamTimelock) internal pure returns (address) {
        return GUARDIAN;
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
            launcher.launchBatch(diamond, _d(registry), _h(), epoch);
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
            launcher.launchBatch(diamond, _d(registry), _h(), epoch);
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
        gate.assertReady(diamond, _d(registry), ILaunchGate.Handover(address(0), address(0), 0));
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
            launcher.checkLaunched(diamond, _d(registry), address(tl), admin),
            string.concat(
                "first unpaused by ",
                vm.toString(address(tl)),
                _throughGate(),
                ", and PAUSED now: lifting that pause is incident response (GovernanceRunbook), not a launch"
            ),
            "an incident-paused Diamond is reported launched, never live"
        );
        vm.prank(address(tl));
        AdminFacet(diamond).unpause();
        assertEq(
            launcher.checkLaunched(diamond, _d(registry), address(tl), admin),
            string.concat("first unpaused by ", vm.toString(address(tl)), _throughGate(), ", and unpaused now")
        );
    }

    function test_Production_CheckLaunchedRefusesBeforeExecution() public {
        (VaipakamTimelock tl, address registry,) = _scheduledLaunch();
        vm.expectRevert(bytes("Launch: the Diamond has not launched"));
        launcher.checkLaunched(diamond, _d(registry), address(tl), admin);
    }

    function test_Testnet_CheckLaunchedRefusesAPausedDiamond() public {
        vm.chainId(84532);
        _configure();
        vm.expectRevert(bytes("Launch: the Diamond has not launched"));
        launcher.checkLaunched(diamond, _d(address(0)), address(0), admin);
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
        launcher.checkLaunched(diamond, _d(address(0)), address(0), admin);
    }

    function test_Testnet_RefusesARegistryWithNoPoolForVpfi() public {
        vm.chainId(84532);
        _configure();
        address registry = address(new LaunchMockRegistry());
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(registry), address(0), admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(address(registry)), address(0), admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(registry), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAFeedWithoutDecimals() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchDecimalLessFeed()));
        OracleAdminFacet(diamond).setWethContract(weth);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAFeedWithAnOutOfRangeRound() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchWideRoundFeed()));
        OracleAdminFacet(diamond).setWethContract(weth);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
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
        launcher.launch(diamond, _d(registry), timelock, admin, 0);
    }

    // ─── Contracts are probed, not just found (Codex #2686 r2) ───────

    function test_Testnet_RefusesAnOracleThatIsNoSanctionsList() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new LaunchCodeStub()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        OracleAdminFacet(diamond).setWethContract(weth);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAFeedThatIsNoFeed() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchCodeStub()));
        OracleAdminFacet(diamond).setWethContract(weth);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
    }

    function test_Testnet_RefusesAFeedWithNoPrice() public {
        vm.chainId(84532);
        LaunchFeedStub feed = new LaunchFeedStub();
        feed.setPrice(0);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(feed));
        OracleAdminFacet(diamond).setWethContract(weth);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
    }

    // ─── Round 4 (Codex #2686 r4) ────────────────────────────────────

    function test_DeployLeavesNoLaunchRecord() public view {
        (address by, uint64 at) = launcher.firstUnpause(diamond);
        assertEq(by, address(0));
        assertEq(at, 0);
    }

    /// @dev Launched through the Timelock, then paused for an incident: a
    ///      re-run reports the launch and proposes NOTHING, so no fresh batch
    ///      bound to the incident's epoch is ever printed to lift it.
    function test_Production_RerunDuringAnIncidentProposesNothing() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _execute(tl, registry, epoch);
        vm.prank(_guardian(tl));
        AdminFacet(diamond).pause();
        Launch.Decision memory d = launcher.decide(diamond, _d(registry), address(tl), admin, false);
        assertEq(uint8(d.path), uint8(Launch.Path.Launched));
        Launch.Outcome o = launcher.launch(diamond, _d(registry), address(tl), admin, 0);
        assertEq(uint8(o), uint8(Launch.Outcome.AlreadyLive));
        assertTrue(AdminFacet(diamond).paused(), "the incident pause stands");
    }

    /// @dev A testnet Diamond the admin launched and then paused: the
    ///      Diamond records the admin's launch, so a re-run reports it and
    ///      never lifts the pause.
    function test_Testnet_AdminWillNotLiftAPauseAfterLaunch() public {
        vm.chainId(84532);
        _configure();
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
        vm.prank(admin);
        AdminFacet(diamond).pause();
        Launch.Outcome o = launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.AlreadyLive));
        assertTrue(AdminFacet(diamond).paused());
        (address by,) = launcher.firstUnpause(diamond);
        assertEq(by, admin);
    }

    /// @dev Paused again before it ever went live: there is no record, so
    ///      the chain itself says it never launched and the admin unpauses
    ///      with no acknowledgement needed.
    function test_Testnet_PausedAgainBeforeLaunchStillLaunches() public {
        vm.chainId(84532);
        _configure();
        vm.prank(admin);
        AdminFacet(diamond).pause();
        Launch.Outcome o = launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.Unpaused));
        assertFalse(AdminFacet(diamond).paused());
    }

    /// @dev The report is the launch's own decision: before the handover a
    ///      production deployment is not launchable, whatever the checks say.
    function test_Decide_ProductionBeforeHandoverIsNotLaunchable() public {
        vm.chainId(8453);
        _configure();
        Launch.Decision memory d =
            launcher.decide(diamond, _d(_registryWithLane()), address(new LaunchMockTimelock()), admin, true);
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
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
    }

    /// @dev The Diamond's own oracle reads a carried-over round as stale, so
    ///      the launch does too.
    function test_Testnet_RefusesACarriedRound() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchCarriedRoundFeed()));
        OracleAdminFacet(diamond).setWethContract(weth);
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
    }

    // ─── Round 5/6 (Codex #2686): the launch is the Diamond's own record ──

    /// @dev Every `pause()` counts as a transition, even on a paused Diamond.
    function _inflateEpoch(address pauser, uint256 n) internal {
        vm.startPrank(pauser);
        for (uint256 i; i < n; ++i) {
            AdminFacet(diamond).pause();
        }
        vm.stopPrank();
    }

    /// @dev However far a Pauser pushes the epoch after the launch, the
    ///      record still says launched: nothing is searched.
    function test_Production_InflatedEpochDoesNotHideALaunch() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _execute(tl, registry, epoch);
        _inflateEpoch(_guardian(tl), 300);
        Launch.Decision memory d = launcher.decide(diamond, _d(registry), address(tl), admin, false);
        assertEq(uint8(d.path), uint8(Launch.Path.Launched));
        Launch.Outcome o = launcher.launch(diamond, _d(registry), address(tl), admin, 0);
        assertEq(uint8(o), uint8(Launch.Outcome.AlreadyLive));
        assertTrue(AdminFacet(diamond).paused(), "the incident pause stands");
    }

    /// @dev Inflated before it ever launched: still no record, so the run
    ///      proposes the launch at the epoch it reads, with no acknowledgement.
    function test_Production_InflatedEpochBeforeLaunchStillProposes() public {
        vm.chainId(8453);
        _configure();
        address registry = _registryWithLane();
        VaipakamTimelock tl = _realTimelock();
        _handOverUnpause(address(tl));
        _inflateEpoch(_guardian(tl), 300);
        Launch.Outcome o = launcher.launch(diamond, _d(registry), address(tl), admin, 0);
        assertEq(uint8(o), uint8(Launch.Outcome.TimelockProposalPrinted));
        assertTrue(AdminFacet(diamond).paused());
    }

    /// @dev A Timelock operation that only unpauses (Codex #2686 r9): the
    ///      Diamond's record names the Timelock but no launch gate, so no
    ///      readiness check vouched for it. Production refuses to call that a
    ///      launch, and the wrapper never records one.
    function test_Production_PlainTimelockUnpauseIsNotALaunch() public {
        (VaipakamTimelock tl, address registry,) = _scheduledLaunch();
        address[] memory targets = new address[](1);
        targets[0] = diamond;
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = abi.encodeCall(AdminFacet.unpause, ());
        vm.prank(PROPOSER);
        tl.scheduleBatch(targets, new uint256[](1), payloads, bytes32(0), bytes32("plain"), 2 days);
        vm.warp(block.timestamp + 2 days);
        tl.executeBatch(targets, new uint256[](1), payloads, bytes32(0), bytes32("plain"));
        (address by,) = launcher.firstUnpause(diamond);
        assertEq(by, address(tl));
        assertEq(launcher.firstUnpauseGate(diamond), address(0), "a plain unpause names no gate");
        string memory refusal = string.concat(
            "Launch: the Diamond was first unpaused by the Timelock, but not through a launch gate ",
            "(AdminFacet.launch) - no readiness check vouched for it in that call; investigate before ",
            "anything records a launch"
        );
        Launch.Decision memory d = launcher.decide(diamond, _d(registry), address(tl), admin, false);
        assertEq(uint8(d.path), uint8(Launch.Path.Refuse));
        assertEq(d.reason, refusal);
        vm.expectRevert(bytes(refusal));
        launcher.checkLaunched(diamond, _d(registry), address(tl), admin);
    }

    function _pool(address registry) internal view returns (LaunchMockPool) {
        return LaunchMockPool(LaunchMockRegistry(registry).getPool(VPFI));
    }

    /// @dev A lane landed with its limiter disabled (the state a wiring run
    ///      leaves when the limits transaction failed): the gate refuses.
    function test_Gate_RefusesALaneWithADisabledLimiter() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        address registry = _registryWithLane();
        _pool(registry).setLimit(1, false, false, 50_000 ether, 6 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "CCIP lanes are exactly the declared set, rate-limited",
                "NOT MET",
                "a lane's OUTBOUND rate limit is disabled or outside the governor's bounds: run the ccip-wire phase's rate limits"
            )
        );
        LaunchGate(LaunchGateDeployment.predicted()).assertReady(diamond, _d(registry), _h());
    }

    /// @dev Enabled but with a capacity past the governor's ceiling: as good
    ///      as no cap, and refused the same way.
    function test_Gate_RefusesALimiterOutsideTheBounds() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        address registry = _registryWithLane();
        _pool(registry).setLimit(1, true, true, type(uint128).max, 6 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "CCIP lanes are exactly the declared set, rate-limited",
                "NOT MET",
                "a lane's INBOUND rate limit is disabled or outside the governor's bounds: run the ccip-wire phase's rate limits"
            )
        );
        LaunchGate(LaunchGateDeployment.predicted()).assertReady(diamond, _d(registry), _h());
    }

    /// @dev A limiter disabled during the delay: the launch reverts on
    ///      execution and the Diamond stays paused.
    function test_Production_LimiterDisabledDuringDelayRevertsTheLaunch() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _pool(registry).setLimit(1, true, false, 0, 0);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, _d(registry), _h(), epoch);
        bytes32 salt = launcher.launchSalt(diamond);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "CCIP lanes are exactly the declared set, rate-limited",
                "NOT MET",
                "a lane's INBOUND rate limit is disabled or outside the governor's bounds: run the ccip-wire phase's rate limits"
            )
        );
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertTrue(AdminFacet(diamond).paused());
    }

    // ─── Round 7 (Codex #2686): checked against what the launch declares ──

    function _gate() internal view returns (LaunchGate) {
        return LaunchGate(LaunchGateDeployment.predicted());
    }

    function _throughGate() internal view returns (string memory) {
        return string.concat(" through launch gate ", vm.toString(LaunchGateDeployment.predicted()), " (this checkout's gate)");
    }

    function _lanes(uint64 a, uint64 b) internal pure returns (uint64[] memory l) {
        l = new uint64[](b == 0 ? 1 : 2);
        l[0] = a;
        if (b != 0) l[1] = b;
    }

    /// @dev A destination of the declared topology was never wired: the
    ///      pool's one in-bounds lane does not make the launch ready.
    function test_Gate_RefusesAMissingDeclaredLane() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        LibLaunchReadiness.Declared memory d = _d(_registryWithLane());
        d.lanes = _lanes(1, 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "CCIP lanes are exactly the declared set, rate-limited",
                "NOT MET",
                "declared lane 2 is not on the registry's VPFI pool: run the ccip-wire phase for every chain in CCIP_LANE_CHAIN_IDS"
            )
        );
        _gate().assertReady(diamond, d, _h());
    }

    /// @dev A lane nobody declared is an unreviewed route: refused too.
    function test_Gate_RefusesAnUndeclaredLane() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        address registry = _registryWithLane();
        LibLaunchReadiness.Declared memory d = _d(registry);
        _pool(registry).setLanes(_lanes(1, 2));
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "CCIP lanes are exactly the declared set, rate-limited",
                "NOT MET",
                "the registry's VPFI pool carries lane 2, which is not declared: an undeclared lane is an unreviewed route"
            )
        );
        _gate().assertReady(diamond, d, _h());
    }

    /// @dev Duplicates in the declaration do not stand in for a missing lane.
    function test_Gate_DuplicateDeclaredLanesDoNotHideAMissingOne() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        address registry = _registryWithLane();
        _pool(registry).setLanes(_lanes(1, 2));
        LibLaunchReadiness.Declared memory d = _d(registry);
        d.lanes = _lanes(1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "CCIP lanes are exactly the declared set, rate-limited",
                "NOT MET",
                "the registry's VPFI pool carries lane 2, which is not declared: an undeclared lane is an unreviewed route"
            )
        );
        _gate().assertReady(diamond, d, _h());
    }

    /// @dev The registry routes VPFI through a pool other than the declared
    ///      one (the pool the handover gate checked): refused.
    function test_Gate_RefusesARegistryPoolOtherThanTheDeclaredOne() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        LibLaunchReadiness.Declared memory d = _d(_registryWithLane());
        d.vpfiPool = address(0xA11CE);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "VPFI routes through the declared pool, governed by the Diamond's owner",
                "NOT MET",
                "the TokenAdminRegistry routes the Diamond's VPFI token through a pool other than the declared one (the pool the handover gate checked)"
            )
        );
        _gate().assertReady(diamond, d, _h());
    }

    /// @dev The oracle prices whatever is stored as WETH, so a price alone
    ///      proves nothing: a WETH other than the declared one is refused.
    function test_Gate_RefusesAWethOtherThanTheDeclaredOne() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        LibLaunchReadiness.Declared memory d = _d(_registryWithLane());
        d.weth = address(new LaunchWethStub());
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "WETH is the declared token and priced",
                "NOT MET",
                "the configured WETH is not the declared one"
            )
        );
        _gate().assertReady(diamond, d, _h());
    }

    /// @dev An EOA stored as WETH still "prices" through the ETH feed; it is
    ///      refused as no 18-decimal token.
    function test_Testnet_RefusesAnEoaWeth() public {
        vm.chainId(84532);
        _configure();
        vm.prank(admin);
        OracleAdminFacet(diamond).setWethContract(address(0xE7E7));
        LibLaunchReadiness.Declared memory d = _d(address(0));
        d.weth = address(0xE7E7);
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, d, address(0), admin, ADMIN_KEY);
    }

    /// @dev WETH re-pointed during the delay: the batch pins the reviewed
    ///      one, so the execution reverts and the Diamond stays paused.
    function test_Production_WethChangedDuringDelayRevertsTheLaunch() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        address other = address(new LaunchWethStub());
        vm.prank(OwnershipFacet(diamond).owner());
        OracleAdminFacet(diamond).setWethContract(other);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, _d(registry), _h(), epoch);
        bytes32 salt = launcher.launchSalt(diamond);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "WETH is the declared token and priced",
                "NOT MET",
                "the configured WETH is not the declared one"
            )
        );
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertTrue(AdminFacet(diamond).paused());
    }

    /// @dev `--skip-vpfi`: no VPFI token and none declared. Both CCIP checks
    ///      are met as not applicable, so the testnet launches.
    function test_Testnet_NoVpfiDeploymentLaunches() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchFeedStub()));
        AdminFacet(diamond).addSwapAdapter(address(new LaunchAdapterStub()));
        OracleAdminFacet(diamond).setWethContract(weth);
        vm.stopPrank();
        LibLaunchReadiness.Check[] memory c = _gate().checks(diamond, _d(address(0)));
        assertTrue(LibLaunchReadiness.allMet(c), "every check met, the CCIP two as not applicable");
        assertEq(
            c[5].detail,
            "not applicable: the Diamond records no VPFI token and the launch declares no VPFI pool or lane, so this deployment carries no cross-chain VPFI"
        );
        Launch.Outcome o = launcher.launch(diamond, _d(address(0)), address(0), admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.Unpaused));
    }

    /// @dev A Diamond with a VPFI token but no lane set declared: the lane
    ///      check cannot say whether every destination is wired. A testnet
    ///      reports it and launches; a production chain refuses.
    function test_UndeclaredLanes_NotCheckedOnTestnet_RefusedOnProduction() public {
        _configure();
        LibLaunchReadiness.Declared memory d = _d(_registryWithLane());
        d.lanes = new uint64[](0);
        LibLaunchReadiness.Check[] memory c = _gate().checks(diamond, d);
        assertFalse(c[5].checkable);
        assertEq(c[5].detail, "no lane set declared (CCIP_LANE_CHAIN_IDS), so whether every destination is wired is unknown");

        vm.chainId(8453);
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        vm.expectRevert(
            bytes(
                "Launch: a production Diamond is unpaused only when every readiness check is met (NOT MET and NOT CHECKED both refuse)"
            )
        );
        launcher.launch(diamond, d, timelock, admin, 0);
    }

    function test_Testnet_UndeclaredLanesStillLaunch() public {
        vm.chainId(84532);
        _configure();
        LibLaunchReadiness.Declared memory d = _d(_registryWithLane());
        d.lanes = new uint64[](0);
        Launch.Outcome o = launcher.launch(diamond, d, address(0), admin, ADMIN_KEY);
        assertEq(uint8(o), uint8(Launch.Outcome.Unpaused));
    }

    // ─── Round 8 (Codex #2686): the route's authorities at execution ────

    function _expectRouteRefused(string memory detail) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchGate.LaunchNotReady.selector,
                "VPFI routes through the declared pool, governed by the Diamond's owner",
                "NOT MET",
                detail
            )
        );
    }

    /// @dev The pool's rate-limit admin is re-pointed during the delay:
    ///      its in-bounds limits could then be lifted at once, so the launch
    ///      reverts and the Diamond stays paused.
    function test_Production_RateAdminRepointedDuringDelayRevertsTheLaunch() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _pool(registry).setRateLimitAdmin(address(0xBAD));
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, _d(registry), _h(), epoch);
        bytes32 salt = launcher.launchSalt(diamond);
        _expectRouteRefused(
            "the VPFI pool's rate-limit admin is not the declared rate governor, so its limits could be changed outside the governor's bounds"
        );
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertTrue(AdminFacet(diamond).paused());
    }

    function test_Gate_RefusesAPoolOwnedByAnotherAccount() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        address registry = _registryWithLane();
        _pool(registry).setOwner(address(0xBAD));
        _expectRouteRefused("the VPFI pool's owner is not the Diamond's owner");
        _gate().assertReady(diamond, _d(registry), _h());
    }

    function test_Gate_RefusesAPendingRegistryAdministratorTransfer() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        address registry = _registryWithLane();
        LaunchMockRegistry(registry).setPendingAdministrator(address(0xBAD));
        _expectRouteRefused("the registry's VPFI administrator is not the Diamond's owner, or a transfer of it is pending");
        _gate().assertReady(diamond, _d(registry), _h());
    }

    function test_Gate_RefusesAGovernorWithAPendingOwner() public {
        _configure();
        _handOverUnpause(address(new LaunchMockTimelock()));
        address registry = _registryWithLane();
        LaunchMockGovernor(wiredGovernor[registry]).setPendingOwner(address(0xBAD));
        _expectRouteRefused(
            "the rate governor is not owned by the Diamond's owner, has an ownership transfer pending, or administers another pool"
        );
        _gate().assertReady(diamond, _d(registry), _h());
    }

    // ─── Round 9 (Codex #2686): the gated launch and the role epoch ─────

    /// @dev A role granted to a fresh account during the delay (here by a
    ///      governance call the Timelock executes): the holders the handover
    ///      gate proved no longer hold, so the launch reverts.
    function test_Production_RoleGrantedDuringDelayRevertsTheLaunch() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        vm.prank(address(tl));
        AccessControlFacet(diamond).grantRole(LibAccessControl.ORACLE_ADMIN_ROLE, address(0xE0A));
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launcher.launchBatch(diamond, _d(registry), _h(), epoch);
        bytes32 salt = launcher.launchSalt(diamond);
        vm.expectRevert(abi.encodeWithSelector(LaunchGate.RoleEpochMoved.selector, provenEpoch, provenEpoch + 1));
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertTrue(AdminFacet(diamond).paused());
    }

    /// @dev Executed: the Diamond's record names the gate it went through,
    ///      and the evidence line says it is this checkout's.
    function test_Production_LaunchRecordsTheGate() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _execute(tl, registry, epoch);
        assertEq(launcher.firstUnpauseGate(diamond), LaunchGateDeployment.predicted());
        assertEq(
            launcher.checkLaunched(diamond, _d(registry), address(tl), admin),
            string.concat("first unpaused by ", vm.toString(address(tl)), _throughGate(), ", and unpaused now")
        );
    }

    function test_Production_RefusesWithoutAHandoverProof() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        Launch unproven = new Launch();
        address registry = _registryWithLane();
        vm.expectRevert(
            bytes(
                "Launch: no role epoch from the handover gate (HANDOVER_ROLE_EPOCH) - run the handover-gate phase first; the deploy wrapper passes the epoch it proved"
            )
        );
        unproven.launch(diamond, _d(registry), timelock, admin, 0);
    }

    function test_Production_RefusesRolesChangedSinceTheProof() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        address registry = _registryWithLane();
        vm.prank(timelock);
        AccessControlFacet(diamond).grantRole(LibAccessControl.KEEPER_ROLE, address(0xC0FFEE));
        vm.expectRevert(
            bytes(
                string.concat(
                    "Launch: the Diamond's roles changed after the handover gate proved them (role epoch ",
                    vm.toString(uint256(provenEpoch)),
                    " proven, ",
                    vm.toString(uint256(provenEpoch) + 1),
                    " now) - re-run the handover-gate phase, then launch"
                )
            )
        );
        launcher.launch(diamond, _d(registry), timelock, admin, 0);
    }

    function test_Production_RefusesWhileTheOwnerIsNotTheTimelock() public {
        vm.chainId(8453);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        address registry = _registryWithLane();
        address elsewhere = address(new LaunchMockTimelock());
        vm.prank(timelock);
        AccessControlFacet(diamond).grantRole(bytes32(0), elsewhere);
        vm.prank(timelock);
        OwnershipFacet(diamond).transferOwnership(elsewhere);
        vm.expectRevert(bytes("Launch: the Diamond's owner is not the Timelock - the handover is not complete"));
        launcher.launch(diamond, _d(registry), timelock, admin, 0);
    }

    /// @dev A testnet rehearsal without the handover gate's output: the
    ///      proposal binds the live epoch and says it was not proven.
    function test_Testnet_ProposalWithoutAProofBindsTheLiveEpoch() public {
        vm.chainId(84532);
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        Launch unproven = new Launch();
        Launch.Decision memory d = unproven.decide(diamond, _d(_registryWithLane()), timelock, admin, false);
        assertEq(uint8(d.path), uint8(Launch.Path.TimelockProposal));
        assertFalse(d.roleEpochProven);
        assertEq(d.handover.roleEpoch, AccessControlFacet(diamond).roleEpoch());
        assertEq(d.handover.owner, timelock);
        assertEq(d.handover.deployKey, admin);
    }

    function test_Gate_RefusesAMovedOwner() public {
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        address registry = _registryWithLane();
        ILaunchGate.Handover memory h = _h();
        h.owner = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(LaunchGate.OwnerMoved.selector, address(0xBEEF), timelock));
        _gate().assertReady(diamond, _d(registry), h);
    }

    /// @dev The Diamond accepts only `assertReady` for itself: a gate call
    ///      naming another Diamond, or another function, vouches for nothing.
    function test_DiamondLaunch_RefusesAGateCallNotForItself() public {
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        LibLaunchReadiness.Declared memory d = _d(_registryWithLane());
        address gate = LaunchGateDeployment.predicted();
        bytes memory forAnother = abi.encodeCall(ILaunchGate.assertReady, (address(0xD1A), d, _h()));
        bytes memory notAssert = abi.encodeCall(LaunchGate.checks, (diamond, d));
        uint64 epoch = _epoch();
        vm.startPrank(timelock);
        vm.expectRevert(IVaipakamErrors.LaunchGateCallInvalid.selector);
        AdminFacet(diamond).launch(epoch, gate, forAnother);
        vm.expectRevert(IVaipakamErrors.LaunchGateCallInvalid.selector);
        AdminFacet(diamond).launch(epoch, gate, notAssert);
        vm.expectRevert(IVaipakamErrors.LaunchGateCallInvalid.selector);
        AdminFacet(diamond).launch(epoch, gate, hex"1234");
        vm.stopPrank();
        assertTrue(AdminFacet(diamond).paused());
    }

    /// @dev A gate address with no code is refused, not read as "returned".
    function test_DiamondLaunch_RefusesAGateWithoutCode() public {
        _configure();
        address timelock = address(new LaunchMockTimelock());
        _handOverUnpause(timelock);
        bytes memory call_ = abi.encodeCall(ILaunchGate.assertReady, (diamond, _d(_registryWithLane()), _h()));
        uint64 epoch = _epoch();
        vm.prank(timelock);
        vm.expectRevert();
        AdminFacet(diamond).launch(epoch, address(0xC0DE), call_);
        assertTrue(AdminFacet(diamond).paused());
    }

    /// @dev A launch is the first unpause only: once live, lifting a pause
    ///      is incident response and `launch` refuses.
    function test_DiamondLaunch_RefusesOnceLive() public {
        (VaipakamTimelock tl, address registry, uint64 epoch) = _scheduledLaunch();
        _execute(tl, registry, epoch);
        vm.prank(GUARDIAN);
        AdminFacet(diamond).pause();
        bytes memory call_ = abi.encodeCall(ILaunchGate.assertReady, (diamond, _d(registry), _h()));
        uint64 now_ = _epoch();
        address gate = LaunchGateDeployment.predicted();
        vm.prank(address(tl));
        vm.expectRevert(IVaipakamErrors.AlreadyLaunched.selector);
        AdminFacet(diamond).launch(now_, gate, call_);
    }

    /// @dev The role epoch counts every change to the role table and
    ///      nothing else: a grant to a holder already holding it is no change.
    function test_RoleEpoch_CountsEveryRoleTableChange() public {
        uint64 e0 = AccessControlFacet(diamond).roleEpoch();
        address who = address(0xA0A0);
        vm.startPrank(admin);
        AccessControlFacet(diamond).grantRole(LibAccessControl.KEEPER_ROLE, who);
        assertEq(AccessControlFacet(diamond).roleEpoch(), e0 + 1, "grant");
        AccessControlFacet(diamond).grantRole(LibAccessControl.KEEPER_ROLE, who);
        assertEq(AccessControlFacet(diamond).roleEpoch(), e0 + 1, "a repeated grant changes nothing");
        AccessControlFacet(diamond).revokeRole(LibAccessControl.KEEPER_ROLE, who);
        assertEq(AccessControlFacet(diamond).roleEpoch(), e0 + 2, "revoke");
        AccessControlFacet(diamond).grantRole(LibAccessControl.KEEPER_ROLE, who);
        vm.stopPrank();
        vm.prank(who);
        AccessControlFacet(diamond).renounceRole(LibAccessControl.KEEPER_ROLE, who);
        assertEq(AccessControlFacet(diamond).roleEpoch(), e0 + 4, "renounce");
    }
}
