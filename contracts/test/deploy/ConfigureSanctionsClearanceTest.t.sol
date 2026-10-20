// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
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
}

/// @dev Answers `oracle()` like an attestor and nothing else: a stale record
///      pointing at a contract that shares one selector.
contract OracleOnlyAttestor {
    address public oracle;

    constructor(address oracle_) {
        oracle = oracle_;
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
}
