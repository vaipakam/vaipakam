// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ConfigureV2Factories} from "../../script/ConfigureV2Factories.s.sol";
import {SlippageCensus} from "../../script/SlippageCensus.s.sol";
import {RehearsalChain} from "../../script/lib/RehearsalChain.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";

/// @dev Stands in for the Diamond: the three V2-factory slots, their
///      ADMIN_ROLE-gated setters and `hasRole`. Counts writes so a test can
///      tell "sent nothing" from "sent the same values again".
contract StubV2FactoryDiamond {
    address public roleHolder;
    address[3] internal slot;
    uint256 public writes;

    constructor(address roleHolder_) {
        roleHolder = roleHolder_;
    }

    function hasRole(bytes32 role, address who) external view returns (bool) {
        return role == LibAccessControl.ADMIN_ROLE && who == roleHolder;
    }

    function getUniswapV2Factory() external view returns (address) { return slot[0]; }
    function getSushiswapV2Factory() external view returns (address) { return slot[1]; }
    function getPancakeswapV2Factory() external view returns (address) { return slot[2]; }

    function setUniswapV2Factory(address a) external { _set(0, a); }
    function setSushiswapV2Factory(address a) external { _set(1, a); }
    function setPancakeswapV2Factory(address a) external { _set(2, a); }

    function _set(uint256 i, address a) internal {
        require(msg.sender == roleHolder, "stub: missing ADMIN_ROLE");
        slot[i] = a;
        ++writes;
    }

    function factories() external view returns (address, address, address) {
        return (slot[0], slot[1], slot[2]);
    }
}

/// @dev Calls the library from an external frame so `expectRevert` can see it.
contract RehearsalChainHarness {
    function check() external view {
        RehearsalChain.requireRehearsalChain("Harness");
    }
}

/// @dev Exposes the census's CSV field encoder.
contract SlippageCensusHarness is SlippageCensus {
    function csvField(string memory raw) external pure returns (string memory) {
        return _csvField(raw);
    }
}

/**
 * @title  DeployScriptHardeningTest
 * @notice #2763 — the script-side fixes: the one rehearsal-chain guard every
 *         mock-wiring script shares, ConfigureV2Factories' admin signer,
 *         read-then-write and Timelock refusal, and the census CSV encoder.
 */
contract DeployScriptHardeningTest is Test {
    uint256 internal adminKey = 0xA11CE;
    address internal admin;
    string internal root;

    // Canonical Ethereum factories, as ConfigureV2Factories carries them.
    address internal constant ETH_UNI_V2 = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address internal constant ETH_SUSHI_V2 = 0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac;
    address internal constant ETH_PANCAKE_V2 = 0x1097053Fd2ea711dad45caCcc45EfF7548fCB362;

    function setUp() public {
        admin = vm.addr(adminKey);
        vm.setEnv("ADMIN_PRIVATE_KEY", vm.toString(adminKey));
    }

    // ── RehearsalChain ────────────────────────────────────────────────

    /// @notice One sequential test: the env var is process-wide, so its
    ///         cases must not run beside each other.
    function test_RehearsalChain_AnvilAlways_TestnetOnlyWhenNamed_ProductionNever() public {
        RehearsalChainHarness h = new RehearsalChainHarness();

        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "0");
        vm.chainId(31337);
        h.check();

        vm.chainId(84532);
        vm.expectRevert();
        h.check();

        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "421614");
        vm.expectRevert();
        h.check(); // names another testnet

        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "84532");
        h.check();

        vm.chainId(8453);
        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "8453");
        vm.expectRevert();
        h.check(); // a production chain, even when named

        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "0");
    }

    // ── ConfigureV2Factories ──────────────────────────────────────────

    function _script(uint256 chainId, string memory name, address diamond)
        internal
        returns (ConfigureV2Factories s)
    {
        vm.chainId(chainId);
        s = new ConfigureV2Factories();
        root = string.concat(ARTIFACT_SCRATCH_PREFIX, "configure-v2-factories-", name);
        s.setArtifactRootOverride(root);
        string memory dir = string.concat(root, "/", Deployments.chainSlug());
        vm.createDir(dir, true);
        vm.writeJson(
            string.concat("{\"chainId\":", vm.toString(chainId), ",\"diamond\":\"", vm.toString(diamond), "\"}"),
            string.concat(dir, "/addresses.json")
        );
    }

    /// @notice The admin holds ADMIN_ROLE: the canonical factories are
    ///         written, and a second run finds them matching and sends nothing.
    function test_V2Factories_AdminWrites_ThenIdempotent() public {
        StubV2FactoryDiamond d = new StubV2FactoryDiamond(admin);
        ConfigureV2Factories s = _script(1, "admin", address(d));

        s.run();
        (address uni, address sushi, address pancake) = d.factories();
        assertEq(uni, ETH_UNI_V2);
        assertEq(sushi, ETH_SUSHI_V2);
        assertEq(pancake, ETH_PANCAKE_V2);
        assertEq(d.writes(), 3, "one setter per differing slot");

        s.run();
        assertEq(d.writes(), 3, "a matching chain sends nothing");
        vm.removeDir(root, true);
    }

    /// @notice A chain whose targets are all zero clears stale factories,
    ///         where the script used to print "skipping" and leave them.
    function test_V2Factories_AllZeroTargets_ClearStaleFactories() public {
        StubV2FactoryDiamond d = new StubV2FactoryDiamond(admin);
        vm.prank(admin);
        d.setSushiswapV2Factory(makeAddr("staleSushi"));
        ConfigureV2Factories s = _script(31337, "clear", address(d));

        s.run();
        (address uni, address sushi, address pancake) = d.factories();
        assertEq(uni, address(0));
        assertEq(sushi, address(0), "the stale factory is cleared");
        assertEq(pancake, address(0));
        assertEq(d.writes(), 2, "only the differing slot is written");
        vm.removeDir(root, true);
    }

    /// @notice After handover the Timelock holds ADMIN_ROLE: the run sends
    ///         nothing and refuses with the calldata to propose.
    function test_V2Factories_AdminWithoutRole_RefusesWithTimelockCalldata() public {
        StubV2FactoryDiamond d = new StubV2FactoryDiamond(makeAddr("timelock"));
        ConfigureV2Factories s = _script(1, "timelock", address(d));

        (bool ok, bytes memory ret) = address(s).call(abi.encodeCall(ConfigureV2Factories.run, ()));
        assertFalse(ok, "refused");
        assertEq(d.writes(), 0, "nothing sent");
        string memory reason = abi.decode(_stripSelector(ret), (string));
        assertTrue(vm.contains(reason, "does not hold ADMIN_ROLE"), reason);
        assertTrue(vm.contains(reason, "through the Timelock"), reason);
        string memory uniCall = vm.toString(abi.encodeWithSignature("setUniswapV2Factory(address)", ETH_UNI_V2));
        assertTrue(vm.contains(reason, uniCall), "carries the setter calldata");
        vm.removeDir(root, true);
    }

    function _stripSelector(bytes memory ret) internal pure returns (bytes memory out) {
        out = new bytes(ret.length - 4);
        for (uint256 i = 0; i < out.length; ++i) out[i] = ret[i + 4];
    }

    // ── SlippageCensus CSV ────────────────────────────────────────────

    function test_CensusCsvField_KeepsOneColumnOneRowAndNoFormula() public {
        SlippageCensusHarness h = new SlippageCensusHarness();
        assertEq(h.csvField("USDC"), "USDC", "a plain symbol is unchanged");
        assertEq(h.csvField(""), "");
        assertEq(h.csvField("A,B"), "\"A,B\"", "a comma is quoted");
        assertEq(h.csvField("say \"hi\""), "\"say \"\"hi\"\"\"", "quotes are doubled");
        assertEq(h.csvField("X\nCENSUS,forged"), "\"X CENSUS,forged\"", "a newline cannot start a row");
        assertEq(h.csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)", "a formula reads as text");
        assertEq(h.csvField("-1,2"), "\"'-1,2\"");
        assertEq(h.csvField("\t@x"), " @x", "a leading control byte becomes a space");
    }
}
