// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";

import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {OwnershipFacet} from "../../src/facets/OwnershipFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";
import {VaipakamTimelock} from "../../src/governance/VaipakamTimelock.sol";
import {HelperTest} from "../HelperTest.sol";

import {Handover} from "../../script/Handover.s.sol";
import {HandoverGate} from "../../script/HandoverGate.s.sol";
import {HandoverPlan} from "../../script/lib/HandoverPlan.sol";
import {
    CrossChainGuardianHarness,
    OwnableERC20Stub,
    PlainOwnable2StepHarness,
    ChainlinkStyleOwnable2StepHarness,
    TokenAdminRegistryStub
} from "../mocks/GovernanceHarnesses.sol";

/// @dev Exposes the real handover body with an in-memory config, so the test
///      runs exactly what `--phase handover` runs without touching the
///      process environment other suites read.
contract HandoverProbe is Handover {
    function exec(Config memory c) external {
        _execute(c);
    }
}

/**
 * @title HandoverGateTest
 * @notice The live exit gate (#944, #669), proven against a chain built the
 *         way a real deploy builds it: the deployer bootstraps every role and
 *         hands it to the admin key (DeployDiamond step 6), the REAL
 *         `Handover` body runs as the admin, the Timelock accepts every
 *         two-step transfer, and `HandoverGate.evaluate` then reads the
 *         result from the role events and the contracts' own getters.
 *
 * @dev The pass case is the property; every other test removes one step of
 *      a correct handover, or adds one key nobody named, and requires the
 *      gate to name it. The predecessor gate (`DeployerZeroRolesTest`) could
 *      not fail any of these: it never read the chain.
 */
/// @dev Exposes the proof the gate prints for the deploy wrappers to record.
contract HandoverGateProofHarness is HandoverGate {
    function handoverProof(address diamond, address timelock) external view returns (uint64, uint64) {
        return _printHandoverProof(diamond, timelock);
    }
}

contract HandoverGateTest is Test {
    uint256 internal constant ADMIN_KEY = 0xA11CE;
    uint256 internal constant DELAY = 1 hours;

    address internal deployer = makeAddr("deployer");
    address internal admin = vm.addr(ADMIN_KEY);
    address internal governanceSafe = makeAddr("governanceSafe");
    address internal pauserSafe = makeAddr("pauserSafe");
    address internal keeperBot = makeAddr("keeperBot");
    address internal watcherBot = makeAddr("watcherBot");
    address internal billerBot = makeAddr("billerBot");
    address internal stranger = makeAddr("stranger");

    VaipakamDiamond internal diamond;
    VaipakamTimelock internal timelock;
    CrossChainGuardianHarness internal messenger;
    PlainOwnable2StepHarness internal rateGovernor;
    ChainlinkStyleOwnable2StepHarness internal tokenPool;
    OwnableERC20Stub internal vpfiToken;
    TokenAdminRegistryStub internal cctRegistry;

    HandoverGate internal gate;

    /// @dev What a scenario changes about an otherwise correct handover.
    struct Twist {
        bool extraRootHolder; // admin grants root to `stranger` before handover
        bool extraKeeper; // admin grants KEEPER_ROLE to `stranger` before handover
        bool extraProposer; // the Timelock is deployed with a second proposer
        bool wrongGuardian; // the messenger's guardian is not the Pauser Safe
        bool skipMessengerAccept; // the Timelock never accepts the messenger
        bool skipPoolAccept; // the Timelock never accepts the CCIP pool
        bool skipCctAccept; // the Timelock never accepts the CCT administrator
        bool noWatcher; // WATCHER_ADDRESS = 0: role deliberately left unheld
    }

    function setUp() public {
        // Both Safes are contracts on this chain, as Handover requires.
        vm.etch(governanceSafe, hex"00");
        vm.etch(pauserSafe, hex"00");
        gate = new HandoverGate();
    }

    // ─── The proof a pass prints (#945, Codex #2686 r9 + r14) ──────────────

    /// @notice A pass prints the Diamond's role epoch and the Timelock's
    ///         executed-call count, both read in the state it proved: the
    ///         launch binds both, so a role change or ANY Timelock call
    ///         after this proof makes the launch proposal refuse.
    function test_Proof_CarriesTheRoleEpochAndTheTimelockCallCount() public {
        _build(_none());
        HandoverGateProofHarness h = new HandoverGateProofHarness();
        (uint64 epoch, uint64 calls) = h.handoverProof(address(diamond), address(timelock));
        assertEq(epoch, AccessControlFacet(address(diamond)).roleEpoch());
        assertEq(calls, timelock.executedCalls());
    }

    /// @notice A Timelock that does not count its calls cannot be bound,
    ///         so the gate refuses to print a proof for it.
    function test_Proof_RefusesATimelockWithoutACallCount() public {
        _build(_none());
        HandoverGateProofHarness h = new HandoverGateProofHarness();
        vm.expectRevert(
            bytes(
                "HandoverGate: the Timelock does not count its executed calls (executedCalls) - it predates the launch binding (#945); fresh deploy"
            )
        );
        h.handoverProof(address(diamond), stranger);
    }

    // ─── Scenarios ──────────────────────────────────────────────────────────

    function test_CorrectHandover_Passes() public {
        (string[] memory failures, string[] memory notChecked) = _evaluate(_build(_none()));
        _assertNoFailures(failures);
        assertEq(notChecked.length, 0, "nothing should be left notChecked");
    }

    /// @notice The case `hasRole` on known addresses cannot see: a third key
    ///         holding the role root. Only the event history names it.
    function test_UnnamedRootHolder_Fails() public {
        Twist memory t = _none();
        t.extraRootHolder = true;
        (string[] memory failures,) = _evaluate(_build(t));
        _assertMentions(failures, "DEFAULT_ADMIN_ROLE is held by", stranger);
    }

    function test_UnnamedBotRoleHolder_Fails() public {
        Twist memory t = _none();
        t.extraKeeper = true;
        (string[] memory failures,) = _evaluate(_build(t));
        _assertMentions(failures, "KEEPER_ROLE is held by", stranger);
    }

    function test_AdminKeyEndsWithNoDiamondRole() public {
        _build(_none());
        bytes32[] memory bots = HandoverPlan.botRoles();
        for (uint256 i; i < bots.length; ++i) {
            assertFalse(AccessControlFacet(address(diamond)).hasRole(bots[i], admin), "admin kept a bot role");
            assertTrue(
                AccessControlFacet(address(diamond)).hasRole(bots[i], [keeperBot, watcherBot, billerBot][i]),
                "bot role not on its bot key"
            );
        }
        assertFalse(
            AccessControlFacet(address(diamond)).hasRole(HandoverPlan.DEFAULT_ADMIN_ROLE, admin), "admin kept root"
        );
    }

    function test_BotRoleLeftUnheldOnPurpose_Passes() public {
        Twist memory t = _none();
        t.noWatcher = true;
        (string[] memory failures,) = _evaluate(_build(t));
        _assertNoFailures(failures);
        assertFalse(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.WATCHER_ROLE, admin));
    }

    function test_ExtraTimelockProposer_Fails() public {
        Twist memory t = _none();
        t.extraProposer = true;
        (string[] memory failures,) = _evaluate(_build(t));
        _assertMentions(failures, "PROPOSER_ROLE is held by", stranger);
    }

    function test_UnacceptedOwnership_Fails() public {
        Twist memory t = _none();
        t.skipMessengerAccept = true;
        (string[] memory failures,) = _evaluate(_build(t));
        _assertContains(failures, "ccipMessenger: owner() is");
        _assertContains(failures, "ccipMessenger: a transfer to");
    }

    /// @notice CHAINLINK's two-step shape hides its pending owner; the gate
    ///         must still see the outstanding request, from the events.
    function test_UnacceptedChainlinkPool_Fails() public {
        Twist memory t = _none();
        t.skipPoolAccept = true;
        (string[] memory failures,) = _evaluate(_build(t));
        _assertContains(failures, "vpfiTokenPool: its last OwnershipTransferRequested is still outstanding");
    }

    function test_UnacceptedCctAdministrator_Fails() public {
        Twist memory t = _none();
        t.skipCctAccept = true;
        (string[] memory failures,) = _evaluate(_build(t));
        _assertContains(failures, "VPFI CCT administrator is");
        _assertContains(failures, "VPFI CCT administrator transfer to");
    }

    function test_WrongGuardian_Fails() public {
        Twist memory t = _none();
        t.wrongGuardian = true;
        (string[] memory failures,) = _evaluate(_build(t));
        _assertContains(failures, "ccipMessenger: guardian() is");
    }

    /// @notice A log range that starts after the deploy (a wrong
    ///         `deployBlock`, an RPC that truncated the range) must FAIL, not
    ///         read as "no other holders".
    function test_TruncatedHistory_Fails() public {
        HandoverGate.Inputs memory inp = _build(_none());
        Vm.Log[] memory raw = vm.getRecordedLogs();
        // Cut the range just after the deploy's first root grant.
        uint256 cut;
        while (raw[cut].emitter != address(diamond) || raw[cut].topics[0] != keccak256("RoleGranted(bytes32,address,address)")) {
            ++cut;
        }
        (string[] memory failures,) = gate.evaluate(inp, _toEntries(raw, cut + 1));
        _assertContains(failures, "Diamond history in range does not reach its construction");
    }

    /// @notice A `deployBlock` set just before the handover: the first
    ///         Diamond event left is the handover's OWN root grant to the
    ///         Timelock, which looks like an anchor and is not. A root holder
    ///         granted earlier would be invisible, so the gate must refuse.
    function test_LateDeployBlock_Fails() public {
        Twist memory t = _none();
        t.extraRootHolder = true;
        HandoverGate.Inputs memory inp = _build(t);
        Vm.Log[] memory raw = vm.getRecordedLogs();
        bytes32 granted = keccak256("RoleGranted(bytes32,address,address)");
        bytes32 toTimelock = bytes32(uint256(uint160(address(timelock))));
        uint256 cut;
        while (
            raw[cut].emitter != address(diamond) || raw[cut].topics[0] != granted || raw[cut].topics[1] != bytes32(0)
                || raw[cut].topics[2] != toTimelock
        ) {
            ++cut;
        }
        (string[] memory failures,) = gate.evaluate(inp, _toEntries(raw, cut));
        // Nothing in this range names the stranger, and hasRole is asked
        // only of named accounts: the construction anchor is the one thing
        // between this range and a pass.
        _assertContains(failures, "Diamond history in range does not reach its construction");
    }

    /// @notice The replay ends on a revoke but the chain says the account
    ///         still holds the role: a live holder the replay alone would
    ///         drop. Every observed pair is compared in both directions.
    function test_RevokedInEventsButStillHeld_Fails() public {
        HandoverGate.Inputs memory inp = _build(_none());
        HandoverGate.LogEntry[] memory got = _logs();
        HandoverGate.LogEntry[] memory logs = new HandoverGate.LogEntry[](got.length + 1);
        for (uint256 i; i < got.length; ++i) {
            logs[i] = got[i];
        }
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("RoleRevoked(bytes32,address,address)");
        topics[1] = LibAccessControl.KEEPER_ROLE;
        topics[2] = bytes32(uint256(uint160(keeperBot)));
        topics[3] = bytes32(uint256(uint160(address(timelock))));
        logs[got.length] =
            HandoverGate.LogEntry({emitter: address(diamond), topics: topics, data: "", order: type(uint256).max});
        (string[] memory failures,) = gate.evaluate(inp, logs);
        _assertMentions(failures, "does not hold KEEPER_ROLE but hasRole says yes", keeperBot);
    }

    /// @notice A GuardianPausable target whose `guardian()` cannot be read
    ///         (the wrong contract, or an implementation without the fast
    ///         pause) fails rather than being skipped.
    function test_UnreadableGuardian_Fails() public {
        HandoverGate.Inputs memory inp = _build(_none());
        inp.targets[2].guardian = true; // the rate governor has no guardian()
        (string[] memory failures,) = gate.evaluate(inp, _logs());
        _assertContains(failures, "vpfiPoolRateGovernor: guardian() unreadable");
    }

    /// @notice A contract the chain must carry, missing from the artifact:
    ///         not checked on a testnet, a failure on production. Never read
    ///         as nothing to hand over.
    function test_MissingRequiredTarget_UncheckedThenFailsOnProduction() public {
        HandoverGate.Inputs memory inp = _build(_none());
        HandoverGate.LogEntry[] memory logs = _logs();
        HandoverPlan.Target[] memory t = new HandoverPlan.Target[](inp.targets.length + 1);
        for (uint256 i; i < inp.targets.length; ++i) {
            t[i] = inp.targets[i];
        }
        t[inp.targets.length] =
            HandoverPlan.Target("vpfiReturnSender", address(0), HandoverPlan.OwnableKind.OpenZeppelin, true, true);
        inp.targets = t;

        (string[] memory failures, string[] memory notChecked) = gate.evaluate(inp, logs);
        _assertNoFailures(failures);
        _assertContains(notChecked, "vpfiReturnSender is missing from addresses.json");

        inp.production = true;
        (failures,) = gate.evaluate(inp, logs);
        _assertContains(failures, "vpfiReturnSender is missing from addresses.json");
    }

    function test_MissingVpfiToken_UncheckedThenFailsOnProduction() public {
        HandoverGate.Inputs memory inp = _build(_none());
        HandoverGate.LogEntry[] memory logs = _logs();
        inp.vpfiToken = address(0);
        (string[] memory failures, string[] memory notChecked) = gate.evaluate(inp, logs);
        _assertNoFailures(failures);
        _assertContains(notChecked, "records no VPFI token");

        inp.production = true;
        (failures,) = gate.evaluate(inp, logs);
        _assertContains(failures, "records no VPFI token");
    }

    /// @notice The plan lists every contract a chain role must carry, even
    ///         when the artifact lacks it, so an incomplete artifact cannot
    ///         shrink the handover or the gate.
    function test_PlanListsRequiredSlotsOnAnEmptyArtifact() public {
        vm.chainId(421614); // a mirror
        HandoverPlan.Target[] memory m = HandoverPlan.read("{}");
        assertEq(m.length, 7, "mirror: 4 shared + mirror token, reward receiver, return sender");
        for (uint256 i; i < m.length; ++i) {
            assertTrue(m[i].required && m[i].addr == address(0), "every listed slot is a required gap");
        }
        vm.chainId(84532); // canonical
        HandoverPlan.Target[] memory c = HandoverPlan.read("{}");
        assertEq(c.length, 7, "canonical: 4 shared + buyback receiver, return receiver, token");
    }

    /// @notice Unset CCIP registry: the CCT administrator is reported as not
    ///         checked off a production chain — never silently passed.
    function test_UnsetCctRegistry_ReportedUnchecked() public {
        HandoverGate.Inputs memory inp = _build(_none());
        inp.cctRegistry = address(0);
        (string[] memory failures, string[] memory notChecked) = gate.evaluate(inp, _logs());
        _assertNoFailures(failures);
        assertEq(notChecked.length, 1, "the CCT administrator must be named as notChecked");
    }

    function test_UnsetCctRegistry_FailsOnProduction() public {
        HandoverGate.Inputs memory inp = _build(_none());
        inp.cctRegistry = address(0);
        inp.production = true;
        (string[] memory failures,) = gate.evaluate(inp, _logs());
        _assertContains(failures, "VPFI CCT administrator NOT CHECKED");
        // Production also demands the 48h delay this test's Timelock lacks.
        _assertContains(failures, "Timelock delay");
    }

    /// @notice The registry routes VPFI through a pool other than the
    ///         artifact's (Codex #2686 r7): the artifact's pool was proven
    ///         Timelock-owned, the routed one was not, so the gate fails.
    function test_RegistryRoutingAnotherPool_Fails() public {
        HandoverGate.Inputs memory inp = _build(_none());
        cctRegistry.setPool(address(vpfiToken), address(0xBAD));
        (string[] memory failures,) = gate.evaluate(inp, _logs());
        _assertContains(failures, "the CCIP registry routes VPFI through");
    }

    /// @notice The routed pool's rate limits are settable by someone other
    ///         than the bounded governor: the gate fails.
    function test_PoolRateAdminNotTheGovernor_Fails() public {
        HandoverGate.Inputs memory inp = _build(_none());
        tokenPool.setRateLimitAdmin(stranger);
        (string[] memory failures,) = gate.evaluate(inp, _logs());
        _assertContains(failures, "VPFI pool rate-limit admin is");
    }

    // ─── Fixture ────────────────────────────────────────────────────────────

    function _none() internal pure returns (Twist memory t) {}

    /// @dev Builds a chain the way a real deploy does and runs the real
    ///      handover on it, applying `t`. Records every event from the first
    ///      deploy transaction on.
    function _build(Twist memory t) internal returns (HandoverGate.Inputs memory inp) {
        vm.recordLogs();

        // DeployDiamond: the deployer bootstraps every role, then hands every
        // role and the ownership to the admin key (step 6).
        vm.startPrank(deployer);
        diamond = _deployMinDiamond();
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        ac.initializeAccessControl();
        bytes32[] memory roles = LibAccessControl.grantableRoles();
        for (uint256 i; i < roles.length; ++i) {
            ac.grantRole(roles[i], admin);
        }
        IERC173(address(diamond)).transferOwnership(admin);
        for (uint256 i = roles.length; i > 0; --i) {
            ac.renounceRole(roles[i - 1], deployer);
        }
        vm.stopPrank();

        // DeployTimelock + the cross-chain stack, admin-owned.
        address[] memory proposers = new address[](t.extraProposer ? 2 : 1);
        proposers[0] = governanceSafe;
        if (t.extraProposer) proposers[1] = stranger;
        address[] memory executors = new address[](1); // open executor
        address[] memory cancellers = new address[](1);
        cancellers[0] = pauserSafe;
        timelock = new VaipakamTimelock(DELAY, proposers, executors, cancellers);

        messenger = CrossChainGuardianHarness(
            address(
                new ERC1967Proxy(
                    address(new CrossChainGuardianHarness()),
                    abi.encodeCall(CrossChainGuardianHarness.initialize, (admin))
                )
            )
        );
        rateGovernor = new PlainOwnable2StepHarness(admin);
        tokenPool = new ChainlinkStyleOwnable2StepHarness(admin);
        vpfiToken = new OwnableERC20Stub(admin);
        cctRegistry = new TokenAdminRegistryStub();
        cctRegistry.seed(address(vpfiToken), admin);
        cctRegistry.setPool(address(vpfiToken), address(tokenPool));
        tokenPool.setRateLimitAdmin(address(rateGovernor));

        vm.startPrank(admin);
        messenger.setGuardian(t.wrongGuardian ? stranger : pauserSafe);
        if (t.extraRootHolder) ac.grantRole(HandoverPlan.DEFAULT_ADMIN_ROLE, stranger);
        if (t.extraKeeper) ac.grantRole(LibAccessControl.KEEPER_ROLE, stranger);
        vm.stopPrank();

        // The REAL handover body.
        Handover.Config memory c;
        c.adminKey = ADMIN_KEY;
        c.admin = admin;
        c.governanceSafe = governanceSafe;
        c.pauserSafe = pauserSafe;
        c.diamond = address(diamond);
        c.timelock = address(timelock);
        c.botHolders = new address[](3);
        c.botHolders[0] = keeperBot;
        c.botHolders[1] = t.noWatcher ? address(0) : watcherBot;
        c.botHolders[2] = billerBot;
        c.targets = _targets();
        c.vpfiToken = address(vpfiToken);
        c.cctRegistry = address(cctRegistry);
        new HandoverProbe().exec(c);

        // The Safe-scheduled acceptances.
        if (!t.skipMessengerAccept) _accept(address(messenger), abi.encodeWithSignature("acceptOwnership()"));
        _accept(address(rateGovernor), abi.encodeWithSignature("acceptOwnership()"));
        if (!t.skipPoolAccept) _accept(address(tokenPool), abi.encodeWithSignature("acceptOwnership()"));
        _accept(address(vpfiToken), abi.encodeWithSignature("acceptOwnership()"));
        if (!t.skipCctAccept) {
            _accept(address(cctRegistry), abi.encodeWithSignature("acceptAdminRole(address)", address(vpfiToken)));
        }

        inp.diamond = address(diamond);
        inp.timelock = address(timelock);
        inp.admin = admin;
        inp.governanceSafe = governanceSafe;
        inp.pauserSafe = pauserSafe;
        inp.executor = address(0);
        inp.botHolders = c.botHolders;
        inp.targets = c.targets;
        inp.vpfiToken = address(vpfiToken);
        inp.vpfiPool = address(tokenPool);
        inp.rateGovernor = address(rateGovernor);
        inp.cctRegistry = address(cctRegistry);
        inp.production = false;
    }

    function _targets() internal view returns (HandoverPlan.Target[] memory t) {
        t = new HandoverPlan.Target[](4);
        t[0] = HandoverPlan.Target("ccipMessenger", address(messenger), HandoverPlan.OwnableKind.OpenZeppelin, true, true);
        t[1] = HandoverPlan.Target("vpfiTokenPool", address(tokenPool), HandoverPlan.OwnableKind.Chainlink, true, false);
        t[2] = HandoverPlan.Target(
            "vpfiPoolRateGovernor", address(rateGovernor), HandoverPlan.OwnableKind.OpenZeppelin, true, false
        );
        t[3] = HandoverPlan.Target("vpfiToken", address(vpfiToken), HandoverPlan.OwnableKind.OpenZeppelin, true, false);
    }

    function _accept(address target, bytes memory data) internal {
        bytes32 salt = keccak256(abi.encode(target, data));
        vm.prank(governanceSafe);
        timelock.schedule(target, 0, data, bytes32(0), salt, DELAY);
        vm.warp(block.timestamp + DELAY + 1);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    /// @dev Every recorded event, in emission order.
    function _logs() internal returns (HandoverGate.LogEntry[] memory) {
        return _toEntries(vm.getRecordedLogs(), 0);
    }

    /// @dev `raw` from index `drop` on, as the gate's log entries.
    function _toEntries(Vm.Log[] memory raw, uint256 drop)
        internal
        pure
        returns (HandoverGate.LogEntry[] memory out)
    {
        out = new HandoverGate.LogEntry[](raw.length - drop);
        for (uint256 i = drop; i < raw.length; ++i) {
            out[i - drop] =
                HandoverGate.LogEntry({emitter: raw[i].emitter, topics: raw[i].topics, data: raw[i].data, order: i});
        }
    }

    function _evaluate(HandoverGate.Inputs memory inp) internal returns (string[] memory, string[] memory) {
        return gate.evaluate(inp, _logs());
    }

    function _deployMinDiamond() internal returns (VaipakamDiamond d) {
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        d = new VaipakamDiamond(deployer, address(cutFacet));
        HelperTest h = new HelperTest();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(new OwnershipFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: h.getOwnershipFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(new AccessControlFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: h.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(d)).diamondCut(cuts, address(0), "");
    }

    // ─── Assertions ─────────────────────────────────────────────────────────

    function _assertNoFailures(string[] memory failures) internal pure {
        if (failures.length == 0) return;
        string memory all;
        for (uint256 i; i < failures.length; ++i) {
            all = string.concat(all, "\n  ", failures[i]);
        }
        revert(string.concat("gate failed a correct handover:", all));
    }

    function _assertContains(string[] memory failures, string memory needle) internal pure {
        for (uint256 i; i < failures.length; ++i) {
            if (_has(failures[i], needle)) return;
        }
        revert(string.concat("no failure mentions: ", needle));
    }

    function _assertMentions(string[] memory failures, string memory needle, address who) internal pure {
        string memory w = vm.toString(who);
        for (uint256 i; i < failures.length; ++i) {
            if (_has(failures[i], needle) && _has(failures[i], w)) return;
        }
        revert(string.concat("no failure mentions: ", needle, " ", w));
    }

    function _has(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i; i + n.length <= h.length; ++i) {
            bool ok = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
