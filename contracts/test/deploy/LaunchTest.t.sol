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

    function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(target, value, data, predecessor, salt));
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

/// @dev Has code; stands in for the price feed and the swap adapter, whose
///      readiness checks only ask that a contract is registered.
contract LaunchCodeStub {}

/**
 * @title LaunchTest
 * @notice #945 / #946: the deploy leaves the Diamond paused, and the first
 *         unpause goes through `Launch.s.sol`, which reads every
 *         `LaunchReadiness` requirement off the chain and follows the
 *         chain's rule — local warns and unpauses, a testnet refuses a NOT
 *         MET check, a production chain refuses anything short of fully
 *         met and never broadcasts (the Timelock unpauses).
 */
contract LaunchTest is Test {
    uint256 internal constant DEPLOYER_KEY = 1;
    uint256 internal constant ADMIN_KEY = 2;
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
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    /// @dev Configure the four Diamond-side requirements.
    function _configure() internal {
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchCodeStub()));
        AdminFacet(diamond).addSwapAdapter(address(new LaunchCodeStub()));
        vm.stopPrank();
    }

    function _poolWithLane() internal returns (address) {
        LaunchMockPool pool = new LaunchMockPool();
        uint64[] memory l = new uint64[](1);
        l[0] = 1;
        pool.setLanes(l);
        return address(pool);
    }

    /// @dev The handover's end state for the unpause path: the Timelock holds
    ///      UNPAUSER_ROLE, the role root and the ownership; the admin key
    ///      holds neither role. Ownership moves before the root is renounced,
    ///      as the Diamond requires.
    function _handOverUnpause(address timelock) internal {
        vm.startPrank(admin);
        AccessControlFacet(diamond).grantRole(bytes32(0), timelock);
        AccessControlFacet(diamond).grantRole(LibAccessControl.UNPAUSER_ROLE, timelock);
        OwnershipFacet(diamond).transferOwnership(timelock);
        AccessControlFacet(diamond).renounceRole(LibAccessControl.UNPAUSER_ROLE, admin);
        AccessControlFacet(diamond).renounceRole(bytes32(0), admin);
        vm.stopPrank();
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
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchCodeStub()));
        AdminFacet(diamond).addSwapAdapter(address(new LaunchCodeStub()));
        vm.stopPrank();
        vm.expectRevert(bytes("Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run"));
        launcher.launch(diamond, address(0), address(0), admin, ADMIN_KEY);
        assertTrue(AdminFacet(diamond).paused());
    }

    function test_Testnet_RefusesWithADisabledOnlySwapRoute() public {
        vm.chainId(84532);
        vm.startPrank(admin);
        ProfileFacet(diamond).setSanctionsOracle(address(new MockSanctionsList()));
        OracleAdminFacet(diamond).setEthUsdFeed(address(new LaunchCodeStub()));
        address adapter = address(new LaunchCodeStub());
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
        Launch.Outcome o = launcher.launch(diamond, address(0), timelock, admin, ADMIN_KEY);
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
            bytes("Launch: the admin key still holds UNPAUSER_ROLE or the role root - the handover is not complete")
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
}
