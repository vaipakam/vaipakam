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

/// @dev A Chainalysis-shaped oracle whose owner is baked into its code, so it
///      survives `vm.etch` onto the real Chainalysis addresses.
contract FakeChainalysisOracle {
    address internal immutable OWNER;

    constructor(address owner_) {
        OWNER = owner_;
    }

    function owner() external view returns (address) {
        return OWNER;
    }

    function isSanctioned(address) external pure returns (bool) {
        return false;
    }
}

/**
 * @title  ConfigureSanctionsOracleTest
 * @notice #2439 — what `ConfigureSanctionsOracle` sets and records: an overlay
 *         over Chainalysis on a testnet that has it, an overlay alone on one
 *         that does not, Chainalysis directly on a mainnet, a refusal on a
 *         mainnet without it, reuse of a recorded overlay, and the refusals
 *         for a foreign owner on either side.
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

    function _etchChainalysis(address at, address owner_) internal {
        vm.etch(at, address(new FakeChainalysisOracle(owner_)).code);
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

    function _artifact() internal view returns (string memory) {
        return vm.readFile(string.concat(root, "/", Deployments.chainSlug(), "/addresses.json"));
    }

    function _cleanup() internal {
        vm.removeDir(root, true);
    }

    // ── Testnets ──────────────────────────────────────────────────────

    /// @notice Base Sepolia: a fresh overlay over Chainalysis, owned by the
    ///         admin, set on the Diamond and recorded with its upstream.
    function test_Testnet_WithChainalysis_SetsAnOverlayOverIt() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(84532, "base-sepolia", address(d));
        address chainalysis = s.CHAINALYSIS_DEFAULT();
        _etchChainalysis(chainalysis, s.CHAINALYSIS_OWNER());

        s.run();

        TestnetSanctionsOverlay overlay = TestnetSanctionsOverlay(d.getSanctionsOracle());
        assertTrue(address(overlay) != address(0) && address(overlay) != chainalysis, "an overlay is configured");
        assertEq(address(overlay.upstream()), chainalysis, "over Chainalysis");
        assertEq(overlay.owner(), admin, "owned by the admin");

        string memory json = _artifact();
        assertEq(vm.parseJsonAddress(json, ".sanctionsOracle"), address(overlay));
        assertEq(vm.parseJsonString(json, ".sanctionsOracleKind"), "testnet-overlay");
        assertEq(vm.parseJsonAddress(json, ".sanctionsUpstream"), chainalysis);
        _cleanup();
    }

    /// @notice A testnet Chainalysis does not cover gets an overlay that is the
    ///         whole list, and no upstream key.
    function test_Testnet_WithoutChainalysis_SetsAnOverlayAlone() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(421614, "arb-sepolia", address(d));

        s.run();

        TestnetSanctionsOverlay overlay = TestnetSanctionsOverlay(d.getSanctionsOracle());
        assertEq(address(overlay.upstream()), address(0));
        string memory json = _artifact();
        assertEq(vm.parseJsonString(json, ".sanctionsOracleKind"), "testnet-overlay");
        assertFalse(vm.keyExistsJson(json, ".sanctionsUpstream"), "no upstream recorded where there is none");
        _cleanup();
    }

    /// @notice A second run reuses the recorded overlay: its flags survive.
    function test_Testnet_SecondRun_ReusesTheRecordedOverlay() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(84532, "reuse", address(d));
        _etchChainalysis(s.CHAINALYSIS_DEFAULT(), s.CHAINALYSIS_OWNER());

        s.run();
        address first = d.getSanctionsOracle();
        s.run();

        assertEq(d.getSanctionsOracle(), first, "the same overlay");
        assertEq(vm.parseJsonAddress(_artifact(), ".sanctionsOracle"), first);
        _cleanup();
    }

    /// @notice A recorded overlay over a different upstream is replaced, not
    ///         reused.
    function test_Testnet_RecordedOverlayWithAnotherUpstream_IsReplaced() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(84532, "replace", address(d));
        _etchChainalysis(s.CHAINALYSIS_DEFAULT(), s.CHAINALYSIS_OWNER());
        TestnetSanctionsOverlay stale = new TestnetSanctionsOverlay(admin, address(0));
        string memory file = string.concat(root, "/", Deployments.chainSlug(), "/addresses.json");
        vm.writeJson(vm.toString(address(stale)), file, ".sanctionsOracle");

        s.run();

        address configured = d.getSanctionsOracle();
        assertTrue(configured != address(stale), "the stale overlay is not reused");
        assertEq(address(TestnetSanctionsOverlay(configured).upstream()), s.CHAINALYSIS_DEFAULT());
        _cleanup();
    }

    // ── Mainnets ──────────────────────────────────────────────────────

    /// @notice Base: Chainalysis's Base address directly, kind recorded, no
    ///         overlay and no upstream key.
    function test_Mainnet_SetsChainalysisDirectly() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(8453, "base", address(d));
        address chainalysis = s.CHAINALYSIS_BASE();
        _etchChainalysis(chainalysis, s.CHAINALYSIS_OWNER());

        s.run();

        assertEq(d.getSanctionsOracle(), chainalysis);
        string memory json = _artifact();
        assertEq(vm.parseJsonAddress(json, ".sanctionsOracle"), chainalysis);
        assertEq(vm.parseJsonString(json, ".sanctionsOracleKind"), "chainalysis");
        assertFalse(vm.keyExistsJson(json, ".sanctionsUpstream"));
        _cleanup();
    }

    /// @notice A mainnet with no verified Chainalysis oracle is refused, not
    ///         left unscreened and not given an overlay.
    function test_Mainnet_WithoutChainalysis_IsRefused() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(1101, "zkevm", address(d));

        vm.expectRevert(
            bytes(
                "ConfigureSanctionsOracle: no verified Chainalysis oracle on this mainnet; configuring another screen needs a recorded decision"
            )
        );
        s.run();
        assertEq(d.getSanctionsOracle(), address(0));
        _cleanup();
    }

    // ── Refusals ──────────────────────────────────────────────────────

    /// @notice A contract at the Chainalysis address that Chainalysis does not
    ///         own is refused before anything is configured.
    function test_ForeignOwnerAtTheChainalysisAddress_IsRefused() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(admin);
        ConfigureSanctionsOracle s = _script(8453, "impostor", address(d));
        _etchChainalysis(s.CHAINALYSIS_BASE(), makeAddr("impostor"));

        vm.expectRevert(
            bytes("ConfigureSanctionsOracle: the oracle at the Chainalysis address is not owned by Chainalysis")
        );
        s.run();
        assertEq(d.getSanctionsOracle(), address(0));
        _cleanup();
    }

    /// @notice A Diamond the admin key does not own (a timelock) is refused,
    ///         and the oracle is left as it was.
    function test_DiamondNotOwnedByAdmin_IsRefused() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(makeAddr("timelock"));
        ConfigureSanctionsOracle s = _script(8453, "timelock", address(d));
        _etchChainalysis(s.CHAINALYSIS_BASE(), s.CHAINALYSIS_OWNER());

        vm.expectRevert(bytes("ConfigureSanctionsOracle: ADMIN_PRIVATE_KEY is not the Diamond owner"));
        s.run();
        assertEq(d.getSanctionsOracle(), address(0));
        _cleanup();
    }

    /// @notice Already pointing at the target, a run sends nothing and still
    ///         records — so an artifact can be backfilled for a Diamond someone
    ///         configured by hand.
    function test_AlreadyConfigured_RecordsWithoutResetting() public {
        StubSanctionsDiamond d = new StubSanctionsDiamond(makeAddr("timelock"));
        ConfigureSanctionsOracle s = _script(8453, "backfill", address(d));
        address chainalysis = s.CHAINALYSIS_BASE();
        _etchChainalysis(chainalysis, s.CHAINALYSIS_OWNER());
        vm.prank(makeAddr("timelock"));
        d.setSanctionsOracle(chainalysis);

        s.run();

        assertEq(vm.parseJsonAddress(_artifact(), ".sanctionsOracle"), chainalysis);
        _cleanup();
    }

    // ── The table ─────────────────────────────────────────────────────

    function test_ChainalysisTable() public {
        ConfigureSanctionsOracle s = new ConfigureSanctionsOracle();
        address d = s.CHAINALYSIS_DEFAULT();
        assertEq(s.chainalysisFor(1), d);
        assertEq(s.chainalysisFor(42161), d);
        assertEq(s.chainalysisFor(10), d);
        assertEq(s.chainalysisFor(137), d);
        assertEq(s.chainalysisFor(56), d);
        assertEq(s.chainalysisFor(84532), d);
        assertEq(s.chainalysisFor(8453), s.CHAINALYSIS_BASE());
        assertEq(s.chainalysisFor(11155111), address(0));
        assertEq(s.chainalysisFor(421614), address(0));
        assertEq(s.chainalysisFor(31337), address(0));
    }
}
