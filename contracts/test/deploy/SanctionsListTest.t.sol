// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SanctionsList} from "../../src/compliance/SanctionsList.sol";
import {ISanctionsList} from "../../src/interfaces/ISanctionsList.sol";
import {MockSanctionsList} from "../mocks/MockSanctionsList.sol";
import {MockTimestampedSanctionsOracle, MockSilentFallbackOracle} from "../mocks/MockTimestampedSanctionsOracle.sol";

/**
 * @title  SanctionsListTest
 * @notice #2443 — the mainnet sanctions list: split roles, all-or-nothing
 *         versioned updates, per-address and per-update events, on-chain
 *         provenance and freshness, the OR with an optional secondary
 *         (RedStone-shaped), secondary failure passed through unchanged, and
 *         attribution.
 */
contract SanctionsListTest is Test {
    address internal admin = makeAddr("admin");
    address internal updater = makeAddr("updater");
    address internal stranger = makeAddr("stranger");
    address internal a = makeAddr("a");
    address internal b = makeAddr("b");
    address internal c = makeAddr("c");

    bytes32 internal constant H1 = keccak256("sdn_advanced.xml@2026-10-15");
    bytes32 internal constant H2 = keccak256("sdn_advanced.xml@2026-10-16");

    MockTimestampedSanctionsOracle internal redstone;
    SanctionsList internal list;

    event UpdaterSet(address indexed account, bool enabled);
    event AddressListed(address indexed who, uint64 indexed version);
    event AddressDelisted(address indexed who, uint64 indexed version);
    event ListUpdated(
        uint64 indexed version,
        bytes32 indexed sourceHash,
        string sourcePublicationId,
        uint256 added,
        uint256 removed,
        uint256 listedCount,
        address indexed updater
    );

    function setUp() public {
        // A mainnet chain id: unlike the testnet overlay, this list may live
        // anywhere.
        vm.chainId(1);
        redstone = new MockTimestampedSanctionsOracle();
        list = new SanctionsList(admin, address(redstone));
        vm.prank(admin);
        list.setUpdater(updater, true);
    }

    // ── helpers ───────────────────────────────────────────────────────

    function _arr(address x) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = x;
    }

    function _arr(address x, address y) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = x;
        r[1] = y;
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _update(address[] memory add, address[] memory remove, bytes32 h, string memory pub) internal {
        uint64 v = list.listVersion();
        vm.prank(updater);
        list.applyUpdate(v, add, remove, h, pub);
    }

    // ── Construction ──────────────────────────────────────────────────

    function test_Constructor_RecordsOwnerAndSecondary() public view {
        assertEq(list.owner(), admin);
        assertEq(address(list.secondary()), address(redstone));
        assertEq(list.listVersion(), 0);
        assertEq(list.lastUpdatedAt(), 0);
        assertEq(list.sourceHash(), bytes32(0));
        assertEq(bytes(list.sourcePublicationId()).length, 0);
    }

    function test_Constructor_RefusesASecondaryWithNoCode() public {
        address eoa = makeAddr("not-an-oracle");
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.SecondaryHasNoCode.selector, eoa));
        new SanctionsList(admin, eoa);
    }

    function test_Constructor_AcceptsNoSecondary() public {
        SanctionsList solo = new SanctionsList(admin, address(0));
        assertEq(address(solo.secondary()), address(0));
    }

    /// @notice It is not a test list: no `upstream()` getter, so an off-chain
    ///         reader that tells the two apart by ABI cannot mistake it for
    ///         one.
    function test_HasNoUpstreamGetter() public view {
        (bool ok,) = address(list).staticcall(abi.encodeWithSignature("upstream()"));
        assertFalse(ok);
    }

    // ── Roles ─────────────────────────────────────────────────────────

    function test_SetUpdater_IsOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        list.setUpdater(stranger, true);
    }

    function test_SetUpdater_EmitsAndToggles() public {
        vm.expectEmit(true, false, false, true, address(list));
        emit UpdaterSet(stranger, true);
        vm.prank(admin);
        list.setUpdater(stranger, true);
        assertTrue(list.isUpdater(stranger));
        vm.prank(admin);
        list.setUpdater(stranger, false);
        assertFalse(list.isUpdater(stranger));
    }

    function test_SetUpdater_RefusesZero() public {
        vm.prank(admin);
        vm.expectRevert(SanctionsList.ZeroAddress.selector);
        list.setUpdater(address(0), true);
    }

    /// @notice The owner decides who updates, but is not itself an updater.
    function test_ApplyUpdate_RefusesTheOwnerUnlessAppointed() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotUpdater.selector, admin));
        list.applyUpdate(0, _arr(a), _none(), H1, "2026-10-15");
    }

    function test_ApplyUpdate_RefusesAStranger() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotUpdater.selector, stranger));
        list.applyUpdate(0, _arr(a), _none(), H1, "2026-10-15");
    }

    function test_ApplyUpdate_RefusesARemovedUpdater() public {
        vm.prank(admin);
        list.setUpdater(updater, false);
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotUpdater.selector, updater));
        list.applyUpdate(0, _arr(a), _none(), H1, "2026-10-15");
    }

    function test_Ownership_IsTwoStep() public {
        vm.prank(admin);
        list.transferOwnership(stranger);
        assertEq(list.owner(), admin);
        vm.prank(stranger);
        list.acceptOwnership();
        assertEq(list.owner(), stranger);
    }

    function test_RenounceOwnership_IsDisabled() public {
        vm.prank(admin);
        vm.expectRevert(SanctionsList.RenounceDisabled.selector);
        list.renounceOwnership();
        assertEq(list.owner(), admin);
    }

    // ── Updates ───────────────────────────────────────────────────────

    function test_ApplyUpdate_ListsRecordsProvenanceAndEmits() public {
        vm.warp(1_760_000_000);
        vm.expectEmit(true, true, false, true, address(list));
        emit AddressListed(a, 1);
        vm.expectEmit(true, true, false, true, address(list));
        emit AddressListed(b, 1);
        vm.expectEmit(true, true, true, true, address(list));
        emit ListUpdated(1, H1, "2026-10-15", 2, 0, 2, updater);
        _update(_arr(a, b), _none(), H1, "2026-10-15");

        assertEq(list.listVersion(), 1);
        assertEq(list.lastUpdatedAt(), 1_760_000_000);
        assertEq(list.sourceHash(), H1);
        assertEq(list.sourcePublicationId(), "2026-10-15");
        assertEq(list.listedCount(), 2);
        assertTrue(list.listedByOwnList(a));
        assertTrue(list.isSanctioned(b));
        assertFalse(list.isSanctioned(c));
        assertEq(list.listedSinceVersion(a), 1);
    }

    function test_ApplyUpdate_DelistsAndEmits() public {
        _update(_arr(a, b), _none(), H1, "2026-10-15");
        vm.expectEmit(true, true, false, true, address(list));
        emit AddressListed(c, 2);
        vm.expectEmit(true, true, false, true, address(list));
        emit AddressDelisted(a, 2);
        vm.expectEmit(true, true, true, true, address(list));
        emit ListUpdated(2, H2, "2026-10-16", 1, 1, 2, updater);
        _update(_arr(c), _arr(a), H2, "2026-10-16");

        assertFalse(list.isSanctioned(a));
        assertTrue(list.isSanctioned(b));
        assertTrue(list.isSanctioned(c));
        assertEq(list.listedSinceVersion(a), 0);
        assertEq(list.listedSinceVersion(b), 1);
        assertEq(list.listedSinceVersion(c), 2);
    }

    /// @notice "Checked the newest publication, nothing changed" is recorded.
    function test_ApplyUpdate_AnEmptyUpdateStillRecordsFreshness() public {
        _update(_arr(a), _none(), H1, "2026-10-15");
        vm.warp(block.timestamp + 1 days);
        _update(_none(), _none(), H2, "2026-10-16");
        assertEq(list.listVersion(), 2);
        assertEq(list.lastUpdatedAt(), block.timestamp);
        assertEq(list.sourceHash(), H2);
        assertEq(list.sourcePublicationId(), "2026-10-16");
        assertEq(list.listedCount(), 1);
    }

    function test_ApplyUpdate_RefusesAStaleVersion() public {
        _update(_arr(a), _none(), H1, "2026-10-15");
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.StaleListVersion.selector, 0, 1));
        list.applyUpdate(0, _arr(b), _none(), H2, "2026-10-16");
    }

    function test_ApplyUpdate_RefusesAddingAListedAddress() public {
        _update(_arr(a), _none(), H1, "2026-10-15");
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.AlreadyListed.selector, a));
        list.applyUpdate(1, _arr(a), _none(), H2, "2026-10-16");
    }

    function test_ApplyUpdate_RefusesADuplicateAddition() public {
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.AlreadyListed.selector, a));
        list.applyUpdate(0, _arr(a, a), _none(), H1, "2026-10-15");
    }

    function test_ApplyUpdate_RefusesRemovingAnUnlistedAddress() public {
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotListed.selector, a));
        list.applyUpdate(0, _none(), _arr(a), H1, "2026-10-15");
    }

    function test_ApplyUpdate_RefusesAddAndRemoveOfTheSameAddress() public {
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.AddedAndRemovedInOneUpdate.selector, a));
        list.applyUpdate(0, _arr(a), _arr(a), H1, "2026-10-15");
    }

    function test_ApplyUpdate_RefusesTheZeroAddress() public {
        vm.startPrank(updater);
        vm.expectRevert(SanctionsList.ZeroAddress.selector);
        list.applyUpdate(0, _arr(address(0)), _none(), H1, "2026-10-15");
        vm.expectRevert(SanctionsList.ZeroAddress.selector);
        list.applyUpdate(0, _none(), _arr(address(0)), H1, "2026-10-15");
        vm.stopPrank();
    }

    function test_ApplyUpdate_RequiresProvenance() public {
        vm.startPrank(updater);
        vm.expectRevert(SanctionsList.MissingSourceHash.selector);
        list.applyUpdate(0, _arr(a), _none(), bytes32(0), "2026-10-15");
        vm.expectRevert(SanctionsList.MissingPublicationId.selector);
        list.applyUpdate(0, _arr(a), _none(), H1, "");
        vm.stopPrank();
    }

    /// @notice A failing update changes nothing: no partial listing, no
    ///         version bump, no provenance overwrite.
    function test_ApplyUpdate_IsAllOrNothing() public {
        _update(_arr(a), _none(), H1, "2026-10-15");
        vm.prank(updater);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotListed.selector, c));
        list.applyUpdate(1, _arr(b), _arr(c), H2, "2026-10-16");
        assertFalse(list.listedByOwnList(b));
        assertEq(list.listVersion(), 1);
        assertEq(list.sourceHash(), H1);
    }

    // ── Enumeration ───────────────────────────────────────────────────

    function test_ListedPage_EnumeratesTheSet() public {
        _update(_arr(a, b), _none(), H1, "2026-10-15");
        _update(_arr(c), _none(), H2, "2026-10-16");
        address[] memory all = list.listedPage(0, 10);
        assertEq(all.length, 3);
        address[] memory p1 = list.listedPage(1, 1);
        assertEq(p1.length, 1);
        assertEq(p1[0], all[1]);
        assertEq(list.listedPage(3, 10).length, 0);
        assertEq(list.listedPage(2, type(uint256).max).length, 1);
    }

    // ── OR with the secondary ─────────────────────────────────────────

    function test_IsSanctioned_TrueOnASecondaryFlagOnly() public {
        redstone.setFlagged(a, true);
        assertTrue(list.isSanctioned(a));
        (bool own, bool sec) = list.sanctionSource(a);
        assertFalse(own);
        assertTrue(sec);
    }

    function test_IsSanctioned_TrueOnAnOwnListingOnly() public {
        _update(_arr(a), _none(), H1, "2026-10-15");
        (bool own, bool sec) = list.sanctionSource(a);
        assertTrue(own);
        assertFalse(sec);
    }

    function test_SanctionSource_ReportsBoth() public {
        _update(_arr(a), _none(), H1, "2026-10-15");
        redstone.setFlagged(a, true);
        (bool own, bool sec) = list.sanctionSource(a);
        assertTrue(own);
        assertTrue(sec);
    }

    /// @notice Delisting from the own record cannot clear a secondary flag.
    function test_Delisting_DoesNotClearASecondaryFlag() public {
        _update(_arr(a), _none(), H1, "2026-10-15");
        redstone.setFlagged(a, true);
        _update(_none(), _arr(a), H2, "2026-10-16");
        assertTrue(list.isSanctioned(a));
    }

    function test_NoSecondary_TheOwnRecordIsTheWholeList() public {
        SanctionsList solo = new SanctionsList(admin, address(0));
        vm.prank(admin);
        solo.setUpdater(updater, true);
        assertFalse(solo.isSanctioned(a));
        vm.prank(updater);
        solo.applyUpdate(0, _arr(a), _none(), H1, "2026-10-15");
        assertTrue(solo.isSanctioned(a));
        (bool own, bool sec) = solo.sanctionSource(a);
        assertTrue(own);
        assertFalse(sec);
    }

    // ── Secondary failure ─────────────────────────────────────────────

    /// @notice An outage reaches the caller unchanged for an address the own
    ///         record does not list, so the Diamond's fail-open and
    ///         fail-closed screens decide what it means.
    function test_SecondaryOutage_PropagatesForAnUnlistedAddress() public {
        redstone.setRevertOnRead(true);
        vm.expectRevert(bytes("oracle-outage"));
        list.isSanctioned(a);
    }

    function test_SecondaryOutage_AnOwnListingStillAnswersTrue() public {
        _update(_arr(a), _none(), H1, "2026-10-15");
        redstone.setRevertOnRead(true);
        assertTrue(list.isSanctioned(a));
        assertTrue(list.listedByOwnList(a));
    }

    function test_SecondaryOutage_AttributionReverts() public {
        _update(_arr(a), _none(), H1, "2026-10-15");
        redstone.setRevertOnRead(true);
        vm.expectRevert(bytes("oracle-outage"));
        list.sanctionSource(a);
    }

    // ── Freshness ─────────────────────────────────────────────────────

    function test_Freshness_ReportsBothSources() public {
        vm.warp(1_760_000_000);
        _update(_arr(a), _none(), H1, "2026-10-15");
        redstone.setLastUpdate(1_759_900_000);
        (
            uint64 version,
            uint64 ownAt,
            bytes32 h,
            string memory pub,
            bool hasSec,
            bool secKnown,
            uint256 secAt
        ) = list.freshness();
        assertEq(version, 1);
        assertEq(ownAt, 1_760_000_000);
        assertEq(h, H1);
        assertEq(pub, "2026-10-15");
        assertTrue(hasSec);
        assertTrue(secKnown);
        assertEq(secAt, 1_759_900_000);
    }

    function test_Freshness_SecondaryTimestampRevertIsUnknown() public {
        redstone.setRevertOnTimestamp(true);
        (bool known, uint256 ts) = list.secondaryLastUpdate();
        assertFalse(known);
        assertEq(ts, 0);
    }

    /// @notice A secondary without RedStone's freshness read (a plain
    ///         Chainalysis-shaped oracle) yields unknown, not a revert.
    function test_Freshness_SecondaryWithoutTheFunctionIsUnknown() public {
        SanctionsList plain = new SanctionsList(admin, address(new MockSanctionsList()));
        (bool known, uint256 ts) = plain.secondaryLastUpdate();
        assertFalse(known);
        assertEq(ts, 0);
        (,,,, bool hasSec, bool secKnown,) = plain.freshness();
        assertTrue(hasSec);
        assertFalse(secKnown);
    }

    /// @notice A fallback that returns no data is unknown too — the read
    ///         never decodes a short answer.
    function test_Freshness_SilentFallbackIsUnknown() public {
        SanctionsList odd = new SanctionsList(admin, address(new MockSilentFallbackOracle()));
        (bool known,) = odd.secondaryLastUpdate();
        assertFalse(known);
    }

    function test_Freshness_NoSecondary() public {
        SanctionsList solo = new SanctionsList(admin, address(0));
        (,,,, bool hasSec, bool secKnown, uint256 secAt) = solo.freshness();
        assertFalse(hasSec);
        assertFalse(secKnown);
        assertEq(secAt, 0);
    }

    // ── Interface ─────────────────────────────────────────────────────

    function test_ImplementsISanctionsList() public view {
        assertFalse(ISanctionsList(address(list)).isSanctioned(a));
    }

    /// @notice Fuzz: after any single add/remove sequence, `isSanctioned`
    ///         without a secondary flag equals own-record membership, and the
    ///         count matches.
    function testFuzz_MembershipMatchesTheRecord(uint8 nAdd, uint8 nRemove) public {
        nAdd = uint8(bound(nAdd, 1, 40));
        nRemove = uint8(bound(nRemove, 0, nAdd));
        address[] memory add = new address[](nAdd);
        for (uint256 i; i < nAdd; ++i) {
            add[i] = address(uint160(0x1000 + i));
        }
        _update(add, _none(), H1, "2026-10-15");
        address[] memory remove = new address[](nRemove);
        for (uint256 i; i < nRemove; ++i) {
            remove[i] = add[i];
        }
        _update(_none(), remove, H2, "2026-10-16");
        assertEq(list.listedCount(), uint256(nAdd) - nRemove);
        for (uint256 i; i < nAdd; ++i) {
            assertEq(list.isSanctioned(add[i]), i >= nRemove);
        }
    }
}
