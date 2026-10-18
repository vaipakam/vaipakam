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
    address internal safe = makeAddr("safe"); // remover
    address internal bot = makeAddr("bot"); // adder
    address internal stranger = makeAddr("stranger");
    address internal a = makeAddr("a");
    address internal b = makeAddr("b");
    address internal c = makeAddr("c");

    bytes32 internal constant H1 = keccak256("sdn_advanced.xml@2026-10-15");
    bytes32 internal constant H2 = keccak256("sdn_advanced.xml@2026-10-16");

    MockTimestampedSanctionsOracle internal redstone;
    SanctionsList internal list;

    event AdderSet(address indexed account, bool enabled);
    event DelistingsPending(uint64 indexed version, uint32 count);
    event RemoverSet(address indexed account, bool enabled);
    event AddressListed(address indexed who, uint64 indexed version);
    event AddressDelisted(address indexed who, uint64 indexed version);
    event ListUpdated(
        uint64 indexed version,
        bytes32 indexed sourceHash,
        uint32 sourcePublicationDate,
        uint256 added,
        uint256 removed,
        uint256 listedCount,
        address indexed safe
    );

    function setUp() public {
        // A mainnet chain id: unlike the testnet overlay, this list may live
        // anywhere.
        vm.chainId(1);
        redstone = new MockTimestampedSanctionsOracle();
        list = new SanctionsList(admin, address(redstone));
        vm.startPrank(admin);
        list.setRemover(safe, true);
        list.setAdder(bot, true);
        vm.stopPrank();
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

    function _update(address[] memory add, address[] memory remove, bytes32 h, uint32 pub) internal {
        uint64 v = list.listVersion();
        vm.prank(safe);
        list.applyUpdate(v, add, remove, h, pub, 0);
    }

    // ── Construction ──────────────────────────────────────────────────

    function test_Constructor_RecordsOwnerAndSecondary() public view {
        assertEq(list.owner(), admin);
        assertEq(address(list.secondary()), address(redstone));
        assertEq(list.listVersion(), 0);
        assertEq(list.lastUpdatedAt(), 0);
        assertEq(list.sourceHash(), bytes32(0));
        assertEq(list.sourcePublicationDate(), 0);
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

    function test_SetRoles_AreOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        list.setAdder(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        list.setRemover(stranger, true);
        vm.stopPrank();
    }

    function test_SetRoles_EmitAndToggle() public {
        vm.startPrank(admin);
        vm.expectEmit(true, false, false, true, address(list));
        emit AdderSet(stranger, true);
        list.setAdder(stranger, true);
        assertTrue(list.isAdder(stranger));
        assertFalse(list.isRemover(stranger), "adder and remover are separate rights");
        vm.expectEmit(true, false, false, true, address(list));
        emit RemoverSet(stranger, true);
        list.setRemover(stranger, true);
        assertTrue(list.isRemover(stranger));
        list.setAdder(stranger, false);
        list.setRemover(stranger, false);
        vm.stopPrank();
        assertFalse(list.isAdder(stranger));
        assertFalse(list.isRemover(stranger));
    }

    function test_SetRoles_RefuseZero() public {
        vm.startPrank(admin);
        vm.expectRevert(SanctionsList.ZeroAddress.selector);
        list.setAdder(address(0), true);
        vm.expectRevert(SanctionsList.ZeroAddress.selector);
        list.setRemover(address(0), true);
        vm.stopPrank();
    }

    /// @notice The adder lists addresses and records refreshes, but can never
    ///         delist — not even one address alongside additions (#2443,
    ///         owner decision 2026-10-18).
    function test_Adder_ListsButCannotDelist() public {
        vm.prank(bot);
        list.applyUpdate(0, _arr(a, b), _none(), H1, 20261015, 0);
        assertTrue(list.listedByOwnList(a));
        vm.prank(bot);
        list.applyUpdate(1, _none(), _none(), H1, 20261015, 0); // a refresh
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotRemover.selector, bot));
        list.applyUpdate(2, _arr(c), _arr(a), H2, 20261016, 0);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotRemover.selector, bot));
        list.applyUpdate(2, _none(), _arr(a), H2, 20261016, 0);
        assertTrue(list.listedByOwnList(a));
    }

    /// @notice One publication that both adds and delists: the adder applies
    ///         the additions, then the remover applies the delistings against
    ///         the SAME publication. Repeating a publication with additions
    ///         stays refused.
    function test_SplitPublication_AdderAddsThenRemoverDelists() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(bot);
        list.applyUpdate(1, _arr(b), _none(), H2, 20261016, 1);
        assertEq(list.pendingDelistings(), 1, "the publication is only partly applied");
        (,,,, uint32 pending,,,) = list.freshness();
        assertEq(pending, 1);
        vm.expectEmit(true, false, false, true, address(list));
        emit DelistingsPending(3, 0);
        vm.expectEmit(true, true, false, true, address(list));
        emit ListUpdated(3, H2, 20261016, 0, 1, 1, safe);
        vm.prank(safe);
        list.applyUpdate(2, _none(), _arr(a), H2, 20261016, 0);
        assertFalse(list.listedByOwnList(a));
        assertTrue(list.listedByOwnList(b));
        assertEq(list.pendingDelistings(), 0);
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsList.PublicationNotNewer.selector, uint32(20261016), H2, uint32(20261016), H2)
        );
        list.applyUpdate(3, _arr(c), _none(), H2, 20261016, 0);
    }

    /// @notice A repeat of a partly applied publication cannot clear its
    ///         outstanding delistings without applying them (Codex #2543 r8).
    function test_Pending_ARefreshCannotClearOutstandingDelistings() public {
        _update(_arr(a, b), _none(), H1, 20261015);
        vm.prank(bot);
        list.applyUpdate(1, _arr(c), _none(), H2, 20261016, 2);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.PendingDelistingsMismatch.selector, uint32(0), uint32(2)));
        list.applyUpdate(2, _none(), _none(), H2, 20261016, 0);
        vm.prank(bot);
        list.applyUpdate(2, _none(), _none(), H2, 20261016, 2); // an honest refresh keeps it
        assertEq(list.pendingDelistings(), 2);
        // Partial completion lowers it by what was applied.
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.PendingDelistingsMismatch.selector, uint32(0), uint32(1)));
        list.applyUpdate(3, _none(), _arr(a), H2, 20261016, 0);
        vm.prank(safe);
        list.applyUpdate(3, _none(), _arr(a), H2, 20261016, 1);
        assertEq(list.pendingDelistings(), 1);
        vm.prank(safe);
        list.applyUpdate(4, _none(), _arr(b), H2, 20261016, 0);
        assertEq(list.pendingDelistings(), 0);
        // A new publication takes its own declaration again.
        vm.prank(bot);
        list.applyUpdate(5, _none(), _none(), keccak256("p3"), 20261017, 0);
        assertEq(list.pendingDelistings(), 0);
    }

    /// @notice A remover may apply a whole update, additions included.
    function test_Remover_AppliesAWholeUpdate() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(safe);
        list.applyUpdate(1, _arr(b), _arr(a), H2, 20261016, 0);
        assertFalse(list.listedByOwnList(a));
        assertTrue(list.listedByOwnList(b));
    }

    /// @notice The owner decides who updates, but is not itself an safe.
    function test_ApplyUpdate_RefusesTheOwnerUnlessAppointed() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotUpdater.selector, admin));
        list.applyUpdate(0, _arr(a), _none(), H1, 20261015, 0);
    }

    function test_ApplyUpdate_RefusesAStranger() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotUpdater.selector, stranger));
        list.applyUpdate(0, _arr(a), _none(), H1, 20261015, 0);
    }

    function test_ApplyUpdate_RefusesARemovedRemover() public {
        vm.prank(admin);
        list.setRemover(safe, false);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotUpdater.selector, safe));
        list.applyUpdate(0, _arr(a), _none(), H1, 20261015, 0);
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
        emit ListUpdated(1, H1, 20261015, 2, 0, 2, safe);
        _update(_arr(a, b), _none(), H1, 20261015);

        assertEq(list.listVersion(), 1);
        assertEq(list.lastUpdatedAt(), 1_760_000_000);
        assertEq(list.sourceHash(), H1);
        assertEq(list.sourcePublicationDate(), 20261015);
        assertEq(list.listedCount(), 2);
        assertTrue(list.listedByOwnList(a));
        assertTrue(list.isSanctioned(b));
        assertFalse(list.isSanctioned(c));
        assertEq(list.listedSinceVersion(a), 1);
    }

    function test_ApplyUpdate_DelistsAndEmits() public {
        _update(_arr(a, b), _none(), H1, 20261015);
        vm.expectEmit(true, true, false, true, address(list));
        emit AddressListed(c, 2);
        vm.expectEmit(true, true, false, true, address(list));
        emit AddressDelisted(a, 2);
        vm.expectEmit(true, true, true, true, address(list));
        emit ListUpdated(2, H2, 20261016, 1, 1, 2, safe);
        _update(_arr(c), _arr(a), H2, 20261016);

        assertFalse(list.isSanctioned(a));
        assertTrue(list.isSanctioned(b));
        assertTrue(list.isSanctioned(c));
        assertEq(list.listedSinceVersion(a), 0);
        assertEq(list.listedSinceVersion(b), 1);
        assertEq(list.listedSinceVersion(c), 2);
    }

    /// @notice "Checked the newest publication, nothing changed" is recorded.
    function test_ApplyUpdate_AnEmptyUpdateStillRecordsFreshness() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.warp(block.timestamp + 1 days);
        _update(_none(), _none(), H2, 20261016);
        assertEq(list.listVersion(), 2);
        assertEq(list.lastUpdatedAt(), block.timestamp);
        assertEq(list.sourceHash(), H2);
        assertEq(list.sourcePublicationDate(), 20261016);
        assertEq(list.listedCount(), 1);
    }

    function test_ApplyUpdate_RefusesAStaleVersion() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.StaleListVersion.selector, 0, 1));
        list.applyUpdate(0, _arr(b), _none(), H2, 20261016, 0);
    }

    function test_ApplyUpdate_RefusesAddingAListedAddress() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.AlreadyListed.selector, a));
        list.applyUpdate(1, _arr(a), _none(), H2, 20261016, 0);
    }

    function test_ApplyUpdate_RefusesADuplicateAddition() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.AlreadyListed.selector, a));
        list.applyUpdate(0, _arr(a, a), _none(), H1, 20261015, 0);
    }

    function test_ApplyUpdate_RefusesRemovingAnUnlistedAddress() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotListed.selector, a));
        list.applyUpdate(0, _none(), _arr(a), H1, 20261015, 0);
    }

    function test_ApplyUpdate_RefusesAddAndRemoveOfTheSameAddress() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.AddedAndRemovedInOneUpdate.selector, a));
        list.applyUpdate(0, _arr(a), _arr(a), H1, 20261015, 0);
    }

    function test_ApplyUpdate_RefusesTheZeroAddress() public {
        vm.startPrank(safe);
        vm.expectRevert(SanctionsList.ZeroAddress.selector);
        list.applyUpdate(0, _arr(address(0)), _none(), H1, 20261015, 0);
        vm.expectRevert(SanctionsList.ZeroAddress.selector);
        list.applyUpdate(0, _none(), _arr(address(0)), H1, 20261015, 0);
        vm.stopPrank();
    }

    function test_ApplyUpdate_RequiresProvenance() public {
        vm.startPrank(safe);
        vm.expectRevert(SanctionsList.MissingSourceHash.selector);
        list.applyUpdate(0, _arr(a), _none(), bytes32(0), 20261015, 0);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.InvalidPublicationDate.selector, uint32(0)));
        list.applyUpdate(0, _arr(a), _none(), H1, 0, 0);
        vm.stopPrank();
    }

    /// @notice A failing update changes nothing: no partial listing, no
    ///         version bump, no provenance overwrite.
    function test_ApplyUpdate_IsAllOrNothing() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotListed.selector, c));
        list.applyUpdate(1, _arr(b), _arr(c), H2, 20261016, 0);
        assertFalse(list.listedByOwnList(b));
        assertEq(list.listVersion(), 1);
        assertEq(list.sourceHash(), H1);
    }

    // ── Publication ordering (Codex #2543 r1) ─────────────────────────

    event PublicationRollbackAuthorized(
        uint64 indexed version, uint32 publicationDate, bytes32 sourceHash, uint32 recordedDate, bytes32 recordedHash
    );
    event PublicationRollbackApplied(uint64 indexed version, uint32 fromDate, bytes32 fromHash, uint32 toDate, bytes32 toHash);
    event PublicationRollbackCleared(uint64 indexed version, uint32 authorizedDate, bytes32 authorizedHash);

    bytes32 internal constant H0 = keccak256("sdn_advanced.xml@2026-10-14");
    bytes32 internal constant H1B = keccak256("sdn_advanced.xml@2026-10-15-reissue");

    /// @notice An older publication cannot roll the list back, even with a
    ///         diff that applies cleanly to the current state.
    function test_Order_RefusesAnOlderPublication() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsList.PublicationNotNewer.selector, uint32(20261014), H0, uint32(20261015), H1)
        );
        list.applyUpdate(1, _none(), _arr(a), H0, 20261014, 0);
        assertTrue(list.listedByOwnList(a));
    }

    /// @notice The same file again, with no changes, is a recorded refresh.
    function test_Order_SameDateSameHashNoChangesIsARefresh() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.warp(block.timestamp + 1 hours);
        _update(_none(), _none(), H1, 20261015);
        assertEq(list.listVersion(), 2);
        assertEq(list.lastUpdatedAt(), block.timestamp);
    }

    /// @notice The same file cannot carry changes a second time.
    function test_Order_SameDateSameHashWithChangesIsRefused() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsList.PublicationNotNewer.selector, uint32(20261015), H1, uint32(20261015), H1)
        );
        list.applyUpdate(1, _arr(b), _none(), H1, 20261015, 0);
    }

    /// @notice A different file on the recorded date cannot be ordered by
    ///         date alone, so it needs the owner's sign-off.
    function test_Order_SameDateDifferentHashIsRefused() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsList.PublicationNotNewer.selector, uint32(20261015), H1B, uint32(20261015), H1)
        );
        list.applyUpdate(1, _none(), _none(), H1B, 20261015, 0);
    }

    /// @notice The owner's one-shot authorization lets exactly the named
    ///         publication through, is evented both ways, and is consumed.
    function test_Order_OwnerAuthorizedRollback() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.expectEmit(true, false, false, true, address(list));
        emit PublicationRollbackAuthorized(1, 20261014, H0, 20261015, H1);
        vm.prank(admin);
        list.authorizePublicationRollback(1, 20261014, H0);
        assertEq(list.rollbackAuthorizedDate(), 20261014);

        // A different hash on the authorized date is still refused.
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsList.PublicationNotNewer.selector, uint32(20261014), H1B, uint32(20261015), H1)
        );
        list.applyUpdate(1, _none(), _arr(a), H1B, 20261014, 0);

        vm.expectEmit(true, false, false, true, address(list));
        emit PublicationRollbackApplied(2, 20261015, H1, 20261014, H0);
        vm.prank(safe);
        list.applyUpdate(1, _none(), _arr(a), H0, 20261014, 0);
        assertFalse(list.listedByOwnList(a));
        assertEq(list.sourcePublicationDate(), 20261014);
        assertEq(list.rollbackAuthorizedDate(), 0);
        assertEq(list.rollbackAuthorizedHash(), bytes32(0));

        // Consumed: a further older file is refused again.
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsList.PublicationNotNewer.selector, uint32(20261013), H0, uint32(20261014), H0)
        );
        list.applyUpdate(2, _none(), _none(), H0, 20261013, 0);
    }

    function test_Order_AuthorizationIsOwnerOnlyAndClearable() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        list.authorizePublicationRollback(1, 20261014, H0);
        vm.startPrank(admin);
        list.authorizePublicationRollback(1, 20261014, H0);
        list.authorizePublicationRollback(0, 0, bytes32(0));
        vm.stopPrank();
        assertEq(list.rollbackAuthorizedDate(), 0);
        assertEq(list.rollbackAuthorizedHash(), bytes32(0));
    }

    function test_Order_AuthorizationValidatesItsInput() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.InvalidPublicationDate.selector, uint32(20261300)));
        list.authorizePublicationRollback(0, 20261300, H0);
        vm.expectRevert(SanctionsList.MissingSourceHash.selector);
        list.authorizePublicationRollback(0, 20261014, bytes32(0));
        vm.stopPrank();
    }

    /// @notice An authorization for a NEWER publication is refused — it
    ///         would never be consumed and would linger (Codex #2543 r2).
    function test_Order_RefusesAForwardDatedAuthorization() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.RollbackNotNeeded.selector, uint32(20261016), uint32(20261015)));
        list.authorizePublicationRollback(1, 20261016, H2);
        // Before any update, every date is newer than "none".
        SanctionsList fresh = new SanctionsList(admin, address(0));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.RollbackNotNeeded.selector, uint32(20261014), uint32(0)));
        fresh.authorizePublicationRollback(0, 20261014, H0);
    }

    /// @notice A newer update that does not use a pending authorization
    ///         clears it, evented, so it cannot be used later against a state
    ///         it was never granted for.
    function test_Order_ANewerUpdateClearsAnUnusedAuthorization() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(admin);
        list.authorizePublicationRollback(1, 20261014, H0);
        vm.expectEmit(true, false, false, true, address(list));
        emit PublicationRollbackCleared(2, 20261014, H0);
        _update(_arr(b), _none(), H2, 20261016);
        assertEq(list.rollbackAuthorizedDate(), 0);
        assertEq(list.rollbackAuthorizedHash(), bytes32(0));
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsList.PublicationNotNewer.selector, uint32(20261014), H0, uint32(20261016), H2)
        );
        list.applyUpdate(2, _none(), _arr(b), H0, 20261014, 0);
    }

    /// @notice The grant is bound to the list version the owner reviewed: if
    ///         an update lands between the owner signing and the grant being
    ///         mined, the grant is refused rather than spent against a state
    ///         nobody reviewed (Codex #2543 r5).
    function test_Order_AuthorizationIsBoundToTheReviewedVersion() public {
        _update(_arr(a), _none(), H1, 20261015); // version 1: the owner reviews this
        _update(_arr(b), _none(), H2, 20261016); // version 2 lands first
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.StaleListVersion.selector, uint64(1), uint64(2)));
        list.authorizePublicationRollback(1, 20261014, H0);
        assertEq(list.rollbackAuthorizedDate(), 0);
        // A clear needs no binding.
        vm.prank(admin);
        list.authorizePublicationRollback(0, 0, bytes32(0));
    }

    /// @notice A same-date refresh clears a pending authorization too.
    function test_Order_ARefreshClearsAnUnusedAuthorization() public {
        _update(_arr(a), _none(), H1, 20261015);
        vm.prank(admin);
        list.authorizePublicationRollback(1, 20261015, H1B);
        vm.expectEmit(true, false, false, true, address(list));
        emit PublicationRollbackCleared(2, 20261015, H1B);
        _update(_none(), _none(), H1, 20261015);
        assertEq(list.rollbackAuthorizedDate(), 0);
    }

    /// @notice Encodings that are not `YYYYMMDD` are refused: `YYMMDD`, a
    ///         Unix timestamp, month 13, month 0, day 32, day 0.
    function test_Order_RefusesMalformedDates() public {
        uint32[6] memory bad = [uint32(261015), 1760000000, 20261301, 20260015, 20261032, 20261000];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(safe);
            vm.expectRevert(abi.encodeWithSelector(SanctionsList.InvalidPublicationDate.selector, bad[i]));
            list.applyUpdate(0, _arr(a), _none(), H1, bad[i], 0);
        }
    }

    // ── Enumeration ───────────────────────────────────────────────────

    function test_ListedPage_EnumeratesTheSet() public {
        _update(_arr(a, b), _none(), H1, 20261015);
        _update(_arr(c), _none(), H2, 20261016);
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
        _update(_arr(a), _none(), H1, 20261015);
        (bool own, bool sec) = list.sanctionSource(a);
        assertTrue(own);
        assertFalse(sec);
    }

    function test_SanctionSource_ReportsBoth() public {
        _update(_arr(a), _none(), H1, 20261015);
        redstone.setFlagged(a, true);
        (bool own, bool sec) = list.sanctionSource(a);
        assertTrue(own);
        assertTrue(sec);
    }

    /// @notice Delisting from the own record cannot clear a secondary flag.
    function test_Delisting_DoesNotClearASecondaryFlag() public {
        _update(_arr(a), _none(), H1, 20261015);
        redstone.setFlagged(a, true);
        _update(_none(), _arr(a), H2, 20261016);
        assertTrue(list.isSanctioned(a));
    }

    function test_NoSecondary_TheOwnRecordIsTheWholeList() public {
        SanctionsList solo = new SanctionsList(admin, address(0));
        vm.prank(admin);
        solo.setRemover(safe, true);
        assertFalse(solo.isSanctioned(a));
        vm.prank(safe);
        solo.applyUpdate(0, _arr(a), _none(), H1, 20261015, 0);
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
        _update(_arr(a), _none(), H1, 20261015);
        redstone.setRevertOnRead(true);
        assertTrue(list.isSanctioned(a));
        assertTrue(list.listedByOwnList(a));
    }

    function test_SecondaryOutage_AttributionReverts() public {
        _update(_arr(a), _none(), H1, 20261015);
        redstone.setRevertOnRead(true);
        vm.expectRevert(bytes("oracle-outage"));
        list.sanctionSource(a);
    }

    // ── Freshness ─────────────────────────────────────────────────────

    function test_Freshness_ReportsBothSources() public {
        vm.warp(1_760_000_000);
        _update(_arr(a), _none(), H1, 20261015);
        redstone.setLastUpdate(1_759_900_000);
        (
            uint64 version,
            uint64 ownAt,
            bytes32 h,
            uint32 pub,
            uint32 pending,
            bool hasSec,
            bool secKnown,
            uint256 secAt
        ) = list.freshness();
        assertEq(pending, 0);
        assertEq(version, 1);
        assertEq(ownAt, 1_760_000_000);
        assertEq(h, H1);
        assertEq(pub, 20261015);
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
        (,,,,, bool hasSec, bool secKnown,) = plain.freshness();
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
        (,,,,, bool hasSec, bool secKnown, uint256 secAt) = solo.freshness();
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
        _update(add, _none(), H1, 20261015);
        address[] memory remove = new address[](nRemove);
        for (uint256 i; i < nRemove; ++i) {
            remove[i] = add[i];
        }
        _update(_none(), remove, H2, 20261016);
        assertEq(list.listedCount(), uint256(nAdd) - nRemove);
        for (uint256 i; i < nAdd; ++i) {
            assertEq(list.isSanctioned(add[i]), i >= nRemove);
        }
    }
}
