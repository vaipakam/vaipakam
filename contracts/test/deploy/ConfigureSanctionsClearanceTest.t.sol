// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {StandInFlagReplay} from "../../script/lib/StandInFlagReplay.sol";
import {TestnetSanctionsOracleStandIn} from "../../src/compliance/TestnetSanctionsOracleStandIn.sol";
import {SanctionsClearanceAttestor} from "../../src/compliance/SanctionsClearanceAttestor.sol";
import {ICrossChainMessenger} from "../../src/crosschain/ICrossChainMessenger.sol";
import {CcipMessenger} from "../../src/crosschain/CcipMessenger.sol";
import {ISanctionsList} from "../../src/interfaces/ISanctionsList.sol";
import {ConfigureSanctionsClearance} from "../../script/ConfigureSanctionsClearance.s.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";

/// @dev Exposes the script's reuse rules for the stand-in and the attestor.
contract ConfigureSanctionsClearanceHarness is ConfigureSanctionsClearance {
    function reusableStandIn(address candidate, address admin) external view returns (bool) {
        return _reusableStandIn(candidate, admin);
    }

    function recordedAttestorToReuse(address standIn_, address messenger) external view returns (address) {
        return _recordedAttestorToReuse(standIn_, CcipMessenger(payable(messenger)));
    }

    function setReplace(address old, uint256 fromBlock) external {
        replaceAttestor = old;
        carryFromBlock = fromBlock;
    }

    function ensureHandler(address m, address handler) external {
        _ensureHandler(CcipMessenger(payable(m)), handler);
    }

    function ensurePeer(address m, uint256 remote, address peer) external {
        _ensurePeer(CcipMessenger(payable(m)), remote, peer);
    }

    function flagsToCarry(address m, address s, address a) external returns (address[] memory) {
        return _flagsToCarry(
            CcipMessenger(payable(m)), TestnetSanctionsOracleStandIn(s), SanctionsClearanceAttestor(payable(a))
        );
    }
}

/// @dev Exposes the flag replay.
contract FlagReplayHarness {
    function replay(Vm.EthGetLogs[] memory logs, address standIn) external pure returns (address[] memory) {
        return StandInFlagReplay.flaggedNow(logs, standIn);
    }
}

/// @dev Answers `oracle()` like an attestor and nothing else: a stale record
///      pointing at a contract that shares one selector.
contract OracleOnlyAttestor {
    address public oracle;

    constructor(address oracle_) {
        oracle = oracle_;
    }
}

/// @dev A stand-in as built before #3113: it says it is one and the admin
///      alone owns it, but it has no refresher role.
contract StandInWithoutRefresher {
    address public owner;
    address public pendingOwner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isTestnetStandIn() external pure returns (bool) {
        return true;
    }
}

/// @dev Answers every call with two words, the first one `value`.
contract WideAnswer {
    address internal immutable value;

    constructor(address value_) {
        value = value_;
    }

    fallback() external {
        address v = value;
        assembly {
            mstore(0, v)
            mstore(32, v)
            return(0, 64)
        }
    }
}

/**
 * @title  ConfigureSanctionsClearanceTest
 * @notice #2443 — the parts of `ConfigureSanctionsClearance` that need no
 *         live CCIP lane: it refuses a mainnet before reading anything, and it
 *         reuses a recorded stand-in only while the admin alone controls it.
 *         An attestor binds its oracle for good, so a stand-in with a pending
 *         ownership transfer, or another owner, must never be bound. The
 *         wiring itself is proven against the live testnets by
 *         `SanctionsClearanceLiveForkTest`.
 */
contract ConfigureSanctionsClearanceTest is Test {
    address internal admin = makeAddr("admin");
    address internal other = makeAddr("other");
    ConfigureSanctionsClearanceHarness internal script;
    TestnetSanctionsOracleStandIn internal standIn;

    function setUp() public {
        vm.chainId(97);
        script = new ConfigureSanctionsClearanceHarness();
        standIn = new TestnetSanctionsOracleStandIn(admin);
    }

    function test_ReusesAStandInOnlyTheAdminControls() public {
        assertTrue(script.reusableStandIn(address(standIn), admin), "the admin's own stand-in is reused");
        assertFalse(script.reusableStandIn(address(standIn), other), "never one another account owns");

        vm.prank(admin);
        standIn.transferOwnership(other);
        assertFalse(script.reusableStandIn(address(standIn), admin), "not while a transfer is pending");

        vm.prank(other);
        standIn.acceptOwnership();
        assertFalse(script.reusableStandIn(address(standIn), admin), "not once another account owns it");
    }

    /// @notice #3113 — a stand-in built before the refresher role is never
    ///         reused, so a fresh wiring never binds an attestor to a list
    ///         only the admin's hand can keep fresh.
    function test_RefusesAStandInWithoutTheRefresherRole() public {
        assertFalse(script.reusableStandIn(address(new StandInWithoutRefresher(admin)), admin));
    }

    function test_RefusesAContractThatIsNotAStandIn() public view {
        // A contract with code but no stand-in marker (the script itself).
        assertFalse(script.reusableStandIn(address(script), admin));
    }

    /// @notice Codex #2601 r7 — the recorded attestor is reused only when it
    ///         reads this stand-in through this messenger, both getters read
    ///         totally: a record that answers one getter, or answers either
    ///         malformed, is "not reusable" (a new attestor), never a stop.
    function test_ReusesTheRecordedAttestorOnlyOnBothReads() public {
        address messenger = address(new OracleOnlyAttestor(address(0))); // any contract
        string memory root = string.concat(ARTIFACT_SCRATCH_PREFIX, "configure-clearance-attestor");
        script.setArtifactRootOverride(root);
        string memory dir = string.concat(root, "/", Deployments.chainSlug());
        vm.createDir(dir, true);
        string memory file = string.concat(dir, "/addresses.json");

        address[4] memory recorded = [
            address(new SanctionsClearanceAttestor(ISanctionsList(address(standIn)), ICrossChainMessenger(messenger))),
            address(new OracleOnlyAttestor(address(standIn))),
            address(new WideAnswer(address(standIn))),
            address(
                new SanctionsClearanceAttestor(ISanctionsList(address(standIn)), ICrossChainMessenger(address(script)))
            )
        ];
        for (uint256 i; i < recorded.length; ++i) {
            vm.writeJson(
                string.concat("{\"chainId\":97,\"sanctionsClearanceAttestor\":\"", vm.toString(recorded[i]), "\"}"),
                file
            );
            address reused = script.recordedAttestorToReuse(address(standIn), messenger);
            assertEq(reused, i == 0 ? recorded[0] : address(0), vm.toString(i));
        }
        vm.removeDir(root, true);
    }

    function test_RefusesEveryMainnetBeforeReadingAnything() public {
        uint256[] memory timelocks = new uint256[](1);
        timelocks[0] = 8453;
        uint256[4] memory mainnets = [uint256(1), 8453, 42161, 56];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            vm.expectRevert(
                bytes(
                    "ConfigureSanctionsClearance: mainnet refused - it deploys a testnet stand-in for RedStone; a mainnet clearance route reads RedStone itself, which waits on RedStone's terms (#2443)"
                )
            );
            script.runWith(admin, admin, 56, timelocks);
        }
    }

    // ── Rotation (#3113) ──────────────────────────────────────────────

    bytes32 internal constant CH = keccak256("vaipakam.ccip.channel.sanctions-clearance");

    /// @dev A messenger the harness owns, so its unbroadcast calls are the owner's.
    function _messenger() internal returns (CcipMessenger) {
        CcipMessenger impl = new CcipMessenger(address(0xC0FFEE));
        return CcipMessenger(
            payable(address(new ERC1967Proxy(address(impl), abi.encodeCall(CcipMessenger.initialize, (address(script))))))
        );
    }

    function test_ReplacesOnlyTheNamedAttestorAsHandler() public {
        CcipMessenger m = _messenger();
        address oldA = makeAddr("oldAttestor");
        address newA = makeAddr("newAttestor");
        script.ensureHandler(address(m), oldA);
        // Without the knob, an existing handler still stops the run.
        vm.expectRevert(bytes("ConfigureSanctionsClearance: another contract handles the clearance channel here - rotating it needs a drain (CcipMessenger.registerChannel); clear it deliberately first"));
        script.ensureHandler(address(m), newA);
        // Naming some other attestor does not license it either.
        script.setReplace(other, 0);
        vm.expectRevert(bytes("ConfigureSanctionsClearance: another contract handles the clearance channel here - rotating it needs a drain (CcipMessenger.registerChannel); clear it deliberately first"));
        script.ensureHandler(address(m), newA);
        // Naming the current handler re-points it, and frees the old one.
        script.setReplace(oldA, 0);
        script.ensureHandler(address(m), newA);
        assertEq(m.handlerOf(CH), newA);
        assertEq(m.channelOf(oldA), bytes32(0));
        assertEq(m.channelOf(newA), CH);
    }

    function test_ReplacesOnlyTheNamedAttestorAsPeer() public {
        CcipMessenger m = _messenger();
        address oldA = makeAddr("oldAttestor");
        address newA = makeAddr("newAttestor");
        script.ensurePeer(address(m), 97, oldA);
        vm.expectRevert(bytes("ConfigureSanctionsClearance: the clearance channel already has another peer for that chain - rotating it needs a drain (CcipMessenger.setChannelPeer); clear it deliberately first"));
        script.ensurePeer(address(m), 97, newA);
        script.setReplace(oldA, 0);
        script.ensurePeer(address(m), 97, newA);
        assertEq(m.channelPeerOf(CH, 97), newA);
    }

    function test_CarriesNothingWithoutARotation() public {
        CcipMessenger m = _messenger();
        assertEq(script.flagsToCarry(address(m), address(standIn), makeAddr("a")).length, 0);
    }

    function test_RefusesARotationItCannotProve() public {
        CcipMessenger m = _messenger();
        TestnetSanctionsOracleStandIn fresh = new TestnetSanctionsOracleStandIn(admin);
        SanctionsClearanceAttestor oldA = new SanctionsClearanceAttestor(ISanctionsList(address(standIn)), ICrossChainMessenger(address(m)));
        SanctionsClearanceAttestor newA = new SanctionsClearanceAttestor(ISanctionsList(address(fresh)), ICrossChainMessenger(address(m)));
        // Naming the attestor the run keeps.
        script.setReplace(address(newA), 1);
        vm.expectRevert(bytes("ConfigureSanctionsClearance: SANCTIONS_CLEARANCE_REPLACE_ATTESTOR names the attestor this run keeps"));
        script.flagsToCarry(address(m), address(fresh), address(newA));
        // Naming an attestor that does not handle the channel here.
        script.setReplace(address(oldA), 1);
        vm.expectRevert(bytes("ConfigureSanctionsClearance: SANCTIONS_CLEARANCE_REPLACE_ATTESTOR is not the clearance channel's handler here"));
        script.flagsToCarry(address(m), address(fresh), address(newA));
        // The handler, but no start block for the old stand-in's history.
        script.ensureHandler(address(m), address(oldA));
        script.setReplace(address(oldA), 0);
        vm.expectRevert(bytes("ConfigureSanctionsClearance: set SANCTIONS_STANDIN_CARRY_FROM_BLOCK to the replaced stand-in's deployment block (or earlier) to carry its flags"));
        script.flagsToCarry(address(m), address(fresh), address(newA));
        // An old attestor whose oracle is not a stand-in.
        SanctionsClearanceAttestor notStandIn = new SanctionsClearanceAttestor(ISanctionsList(address(script)), ICrossChainMessenger(address(m)));
        CcipMessenger m2 = _messenger();
        script.ensureHandler(address(m2), address(notStandIn));
        script.setReplace(address(notStandIn), 1);
        vm.expectRevert(bytes("ConfigureSanctionsClearance: the replaced attestor's oracle is not a testnet stand-in - its flags cannot be carried"));
        script.flagsToCarry(address(m2), address(fresh), address(newA));
    }

    function _flagLog(address emitter, address account, bool on, uint64 blockNumber, uint256 logIndex)
        internal
        pure
        returns (Vm.EthGetLogs memory l)
    {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = StandInFlagReplay.FLAG_SET;
        topics[1] = bytes32(uint256(uint160(account)));
        l.emitter = emitter;
        l.topics = topics;
        l.data = abi.encode(on);
        l.blockNumber = blockNumber;
        l.logIndex = logIndex;
    }

    function test_ReplayKeepsEachAccountsLastSettingInChainOrder() public {
        FlagReplayHarness h = new FlagReplayHarness();
        address s = address(standIn);
        address x = makeAddr("x");
        address y = makeAddr("y");
        address z = makeAddr("z");
        Vm.EthGetLogs[] memory logs = new Vm.EthGetLogs[](5);
        // Given out of order: x on, x off, x on again (last wins); y on then off; z on.
        logs[0] = _flagLog(s, x, true, 30, 0);
        logs[1] = _flagLog(s, y, false, 20, 1);
        logs[2] = _flagLog(s, x, true, 10, 0);
        logs[3] = _flagLog(s, x, false, 20, 0);
        logs[4] = _flagLog(s, z, true, 5, 0);
        Vm.EthGetLogs[] memory more = new Vm.EthGetLogs[](6);
        for (uint256 i; i < 5; ++i) {
            more[i] = logs[i];
        }
        more[5] = _flagLog(s, y, true, 15, 0);
        address[] memory out = h.replay(more, s);
        assertEq(out.length, 2);
        assertEq(out[0], z);
        assertEq(out[1], x);
    }

    function test_ReplayRefusesALogThatIsNotTheStandInsFlagSet() public {
        FlagReplayHarness h = new FlagReplayHarness();
        Vm.EthGetLogs[] memory logs = new Vm.EthGetLogs[](1);
        logs[0] = _flagLog(other, makeAddr("x"), true, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(StandInFlagReplay.NotAFlagSet.selector, 0));
        h.replay(logs, address(standIn));
        logs[0] = _flagLog(address(standIn), makeAddr("x"), true, 1, 0);
        logs[0].data = abi.encode(uint256(2));
        vm.expectRevert(abi.encodeWithSelector(StandInFlagReplay.NotAFlagSet.selector, 0));
        h.replay(logs, address(standIn));
        logs[0] = _flagLog(address(standIn), makeAddr("x"), true, 1, 0);
        logs[0].removed = true;
        vm.expectRevert(abi.encodeWithSelector(StandInFlagReplay.NotAFlagSet.selector, 0));
        h.replay(logs, address(standIn));
    }
}
