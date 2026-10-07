// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ConfigureSanctionsOracle} from "../../script/ConfigureSanctionsOracle.s.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";
import {TestnetSanctionsOverlay} from "../../src/compliance/TestnetSanctionsOverlay.sol";
import {ISanctionsList} from "../../src/interfaces/ISanctionsList.sol";

/// @dev Stands in for the Diamond: the four selectors the script calls, with
///      the Diamond's own fail-open read. The overlay on a REAL Diamond is
///      covered by `TestnetSanctionsOverlayDiamondTest`.
contract StubSanctionsDiamond {
    address public owner;
    address internal oracle;

    constructor(address owner_) {
        owner = owner_;
    }

    function getSanctionsOracle() external view returns (address) {
        return oracle;
    }

    function setSanctionsOracle(address a) external {
        require(msg.sender == owner, "stub: not owner");
        oracle = a;
    }

    function isSanctionedAddress(address who) external view returns (bool) {
        if (oracle == address(0)) return false;
        try ISanctionsList(oracle).isSanctioned(who) returns (bool f) {
            return f;
        } catch {
            return false;
        }
    }
}

/// @dev A list with a fixed answer, standing in for an upstream a recorded
///      overlay might extend.
contract FixedSanctionsList {
    function isSanctioned(address) external pure returns (bool) {
        return false;
    }
}

/**
 * @title  ConfigureSanctionsOracleTest
 * @notice #2439 — what `ConfigureSanctionsOracle` sets and records: on a
 *         testnet, the admin's test list alone (no upstream), reused while it
 *         is fit; on a mainnet, a refusal, because the only on-chain source the
 *         script was written for — Chainalysis's oracle — was retired (#2443).
 */
contract ConfigureSanctionsOracleTest is Test {
    uint256 internal adminKey = 0xA11CE;
    uint256 internal deployerKey = 0xDE9;
    address internal admin;

    string internal root;

    function setUp() public {
        admin = vm.addr(adminKey);
        vm.setEnv("ADMIN_PRIVATE_KEY", vm.toString(adminKey));
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(deployerKey));
    }

    /// @dev A fresh script on `chainId` whose artifact (under a scratch root)
    ///      names `diamond`.
    function _script(uint256 chainId, string memory name, address diamond)
        internal
        returns (ConfigureSanctionsOracle s)
    {
        vm.chainId(chainId);
        s = new ConfigureSanctionsOracle();
        root = string.concat(ARTIFACT_SCRATCH_PREFIX, "configure-sanctions-", name);
        s.setArtifactRootOverride(root);
        string memory dir = string.concat(root, "/", Deployments.chainSlug());
        vm.createDir(dir, true);
        vm.writeJson(
            string.concat("{\"chainId\":", vm.toString(chainId), ",\"diamond\":\"", vm.toString(diamond), "\"}"),
            string.concat(dir, "/addresses.json")
        );
    }

    function _file() internal view returns (string memory) {
        return string.concat(root, "/", Deployments.chainSlug(), "/addresses.json");
    }

    function _artifact() internal view returns (string memory) {
        return vm.readFile(_file());
    }

    function _cleanup() internal {
        vm.removeDir(root, true);
    }

    // ── Testnets ──────────────────────────────────────────────────────

    /// @notice Base Sepolia: a fresh overlay with no upstream, owned by the
    ///         admin, set on the Diamond and recorded.
    function test_Testnet_SetsTheAdminsTestListAlone() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(84532, "base-sepolia", address(d));

        s.run();

        TestnetSanctionsOverlay overlay = TestnetSanctionsOverlay(d.getSanctionsOracle());
        assertTrue(address(overlay).code.length != 0, "an overlay is configured");
        assertEq(address(overlay.upstream()), address(0), "no upstream: the retired oracle is not layered in");
        assertEq(overlay.owner(), admin, "owned by the admin");

        string memory json = _artifact();
        assertEq(vm.parseJsonAddress(json, ".sanctions.oracle"), address(overlay));
        assertEq(vm.parseJsonString(json, ".sanctions.kind"), "testnet-overlay");
        assertFalse(vm.keyExistsJson(json, ".sanctions.upstream"));
        assertEq(vm.parseJsonAddress(json, ".sanctionsTestnetOverlay"), address(overlay), "the deployment is recorded");
        _cleanup();
    }

    /// @notice A testnet Diamond the admin does not own: the overlay is still
    ///         deployed and recorded (a revert would have discarded it, and the
    ///         printed call would then name an address with no code), the
    ///         oracle is left unchanged and NOT recorded as configured. Once the
    ///         owner makes the call, a re-run reuses that overlay and records.
    function test_Testnet_DiamondNotOwnedByAdmin_DeploysAndRecordsTheOverlay_LeavesTheOracle() public {
        address timelock = makeAddr("timelock");
        StubSanctionsDiamond d = new StubSanctionsDiamond(timelock);
        ConfigureSanctionsOracle s = _script(84532, "testnet-timelock", address(d));

        s.run();

        assertEq(d.getSanctionsOracle(), address(0), "the oracle is not changed");
        string memory json = _artifact();
        address overlay = vm.parseJsonAddress(json, ".sanctionsTestnetOverlay");
        assertTrue(overlay.code.length != 0, "the overlay the call names exists");
        assertFalse(vm.keyExistsJson(json, ".sanctions"), "not recorded as configured");

        vm.prank(timelock);
        d.setSanctionsOracle(overlay);
        s.run();

        assertEq(d.getSanctionsOracle(), overlay, "the scheduled overlay stays");
        assertEq(vm.parseJsonAddress(_artifact(), ".sanctions.oracle"), overlay, "now recorded as configured");
        _cleanup();
    }

    /// @notice Codex #2442 r3 — the `.sanctions` record is replaced whole, so
    ///         a field written by an earlier configuration (here an upstream)
    ///         does not survive.
    function test_Testnet_PriorRecord_IsReplacedWhole() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(421614, "stale-record", address(d));
        vm.writeJson(
            string.concat(
                "{\"oracle\":\"", vm.toString(address(0xBEEF)),
                "\",\"kind\":\"chainalysis\",\"upstream\":\"", vm.toString(address(0xC0FFEE)), "\"}"
            ),
            _file(),
            ".sanctions"
        );

        s.run();

        string memory json = _artifact();
        assertEq(vm.parseJsonAddress(json, ".sanctions.oracle"), d.getSanctionsOracle());
        assertEq(vm.parseJsonString(json, ".sanctions.kind"), "testnet-overlay");
        assertFalse(vm.keyExistsJson(json, ".sanctions.upstream"), "the earlier field is gone");
        _cleanup();
    }

    /// @notice A second run reuses the recorded overlay: its flags survive.
    function test_Testnet_SecondRun_ReusesTheRecordedOverlay() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(84532, "reuse", address(d));

        s.run();
        address first = d.getSanctionsOracle();
        vm.prank(admin);
        TestnetSanctionsOverlay(first).setFlagged(makeAddr("flagged"), true);
        s.run();

        assertEq(d.getSanctionsOracle(), first, "the same overlay");
        assertTrue(TestnetSanctionsOverlay(first).isSanctioned(makeAddr("flagged")), "its flags survive");
        assertEq(vm.parseJsonAddress(_artifact(), ".sanctions.oracle"), first);
        _cleanup();
    }

    /// @notice A recorded overlay that layers over an upstream (e.g. the
    ///         retired Chainalysis oracle) is replaced, not reused.
    function test_Testnet_RecordedOverlayWithAnUpstream_IsReplaced() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(84532, "replace", address(d));
        TestnetSanctionsOverlay layered = new TestnetSanctionsOverlay(admin, address(new FixedSanctionsList()));
        vm.writeJson(vm.toString(address(layered)), _file(), ".sanctionsTestnetOverlay");

        s.run();

        address configured = d.getSanctionsOracle();
        assertTrue(configured != address(layered), "the layered overlay is not reused");
        assertEq(address(TestnetSanctionsOverlay(configured).upstream()), address(0));
        _cleanup();
    }

    /// @notice A recorded overlay owned by someone else is not reused: its
    ///         owner decides who is flagged.
    function test_Testnet_RecordedOverlayOwnedByAnother_IsReplaced() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(84532, "foreign-owner", address(d));
        TestnetSanctionsOverlay foreign = new TestnetSanctionsOverlay(makeAddr("someone"), address(0));
        vm.writeJson(vm.toString(address(foreign)), _file(), ".sanctionsTestnetOverlay");

        s.run();

        address configured = d.getSanctionsOracle();
        assertTrue(configured != address(foreign), "an overlay someone else owns is not reused");
        assertEq(TestnetSanctionsOverlay(configured).owner(), admin);
        _cleanup();
    }

    /// @notice A recorded overlay the admin owns but has begun handing to
    ///         someone else is not reused either.
    function test_Testnet_RecordedOverlayWithPendingTransfer_IsReplaced() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(84532, "pending-owner", address(d));
        TestnetSanctionsOverlay pending = new TestnetSanctionsOverlay(admin, address(0));
        vm.prank(admin);
        pending.transferOwnership(makeAddr("next"));
        vm.writeJson(vm.toString(address(pending)), _file(), ".sanctionsTestnetOverlay");

        s.run();

        assertTrue(d.getSanctionsOracle() != address(pending), "an overlay mid-transfer is not reused");
        _cleanup();
    }

    /// @notice Already pointing at the recorded overlay, a run sends nothing
    ///         and still records — so an artifact can be backfilled for a
    ///         Diamond whose owner made the call by hand.
    function test_Testnet_AlreadyConfigured_RecordsWithoutResetting() public {
        address timelock = makeAddr("timelock");
        StubSanctionsDiamond d = new StubSanctionsDiamond(timelock);
        ConfigureSanctionsOracle s = _script(84532, "backfill", address(d));
        TestnetSanctionsOverlay overlay = new TestnetSanctionsOverlay(admin, address(0));
        vm.writeJson(vm.toString(address(overlay)), _file(), ".sanctionsTestnetOverlay");
        vm.prank(timelock);
        d.setSanctionsOracle(address(overlay));

        s.run();

        assertEq(vm.parseJsonAddress(_artifact(), ".sanctions.oracle"), address(overlay));
        _cleanup();
    }

    // ── Mainnets ──────────────────────────────────────────────────────

    /// @notice Every mainnet is refused — including the ones Chainalysis's
    ///         retired oracle still answers on — and nothing is deployed,
    ///         configured or recorded.
    function test_Mainnet_IsRefused() public {
        uint256[6] memory mainnets = [uint256(1), 8453, 42161, 10, 137, 56];
        for (uint256 i; i < mainnets.length; ++i) {
            StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
            ConfigureSanctionsOracle s = _script(mainnets[i], string.concat("mainnet-", vm.toString(mainnets[i])), address(d));

            vm.expectRevert(
                bytes(
                    "ConfigureSanctionsOracle: no supported on-chain sanctions source for a mainnet (Chainalysis retired its oracle on 2026-03-18; see #2443)"
                )
            );
            s.run();

            assertEq(d.getSanctionsOracle(), address(0));
            assertFalse(vm.keyExistsJson(_artifact(), ".sanctions"));
            assertFalse(vm.keyExistsJson(_artifact(), ".sanctionsTestnetOverlay"));
            _cleanup();
        }
    }
}
