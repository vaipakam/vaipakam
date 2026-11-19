// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {MulticallFacet} from "../src/facets/MulticallFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibTerms} from "../src/libraries/LibTerms.sol";

/**
 * @title LegalFacetTest
 * @notice #3734 — the Terms record and its versions:
 *         - no version in force: nothing is checked (design test 9);
 *         - a wallet accepts only by its own transaction, the version in
 *           force or the announced one, kept per version, first time kept
 *           (tests 3, 4);
 *         - during a notice only the version in force counts; the announced
 *           one counts from its time with no call (test 5);
 *         - the notice floor, the spent number, one announcement at a time
 *           (test 6);
 *         - a wallet joining during a notice accepts both versions in one
 *           transaction of its own, and a withdrawal changes nobody's
 *           standing (test 11);
 *         - accepting stays open while paused;
 *         - the minimum version: a small change publishes at once with no
 *           notice, a material change raises the minimum after one, one open
 *           change at a time, and only a version that came into force counts
 *           (tests 16 to 20).
 */
contract LegalFacetTest is SetupTest {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal constant H1 = keccak256("Vaipakam ToS v1");
    bytes32 internal constant H2 = keccak256("Vaipakam ToS v2");
    bytes32 internal constant H3 = keccak256("Vaipakam ToS v3");

    event TermsAccepted(address indexed user, uint32 indexed version, bytes32 hash, uint64 timestamp);
    event TosPublished(uint32 indexed version, bytes32 hash, uint32 minVersion, uint64 at);
    event TosAnnounced(uint32 indexed version, bytes32 hash, uint64 effectiveAt, uint32 minVersion, bool newVersion);
    event TosAnnouncementWithdrawn(uint32 indexed version, bytes32 hash, bool newVersion);
    event TosVersionInForce(uint32 indexed version, bytes32 hash, uint64 effectiveAt, uint32 minVersion, bool newVersion);

    function setUp() public {
        setupHelper();
    }

    function _l() internal view returns (LegalFacet) {
        return LegalFacet(address(diamond));
    }

    function _v1Now() internal {
        _l().announceTos(1, H1, uint64(block.timestamp));
    }

    // ─── No version in force ────────────────────────────────────────────

    function test_NoVersion_NothingChecked() public view {
        assertTrue(_l().isTermsCurrent(alice));
        assertTrue(_l().hasAcceptedCurrentTerms(alice));
        _l().requireCurrentTerms(alice);
        (address w, uint32 v) = _l().termsBlocker(alice, bob);
        assertEq(w, address(0));
        assertEq(v, 0);
        (uint32 cv, bytes32 ch) = _l().getCurrentTos();
        assertEq(cv, 0);
        assertEq(ch, bytes32(0));
    }

    function test_FirstVersionNeedsNoNotice_AndChecksAtOnce() public {
        vm.expectEmit(true, false, false, true, address(diamond));
        emit TosAnnounced(1, H1, uint64(block.timestamp), 1, true);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit TosVersionInForce(1, H1, uint64(block.timestamp), 1, true);
        _v1Now();
        (uint32 cv, bytes32 ch) = _l().getCurrentTos();
        assertEq(cv, 1);
        assertEq(ch, H1);
        assertFalse(_l().isTermsCurrent(alice));
        vm.expectRevert(abi.encodeWithSelector(LibTerms.TermsNotAccepted.selector, alice, uint32(1)));
        _l().requireCurrentTerms(alice);
        (address w, uint32 v) = _l().termsBlocker(address(0), alice);
        assertEq(w, alice);
        assertEq(v, 1);
    }

    // ─── Accepting ──────────────────────────────────────────────────────

    function test_Accept_OwnTransaction_RecordsPerVersion() public {
        _v1Now();
        vm.expectEmit(true, true, false, true, address(diamond));
        emit TermsAccepted(alice, 1, H1, uint64(block.timestamp));
        vm.prank(alice);
        _l().acceptTerms(1, H1);
        assertTrue(_l().isTermsCurrent(alice));
        LibVaipakam.TosAcceptance memory a = _l().getUserTosAcceptanceOf(alice, 1);
        assertEq(a.version, 1);
        assertEq(a.hash, H1);
        assertEq(a.acceptedAt, uint64(block.timestamp));
        // Recorded for the caller only.
        assertFalse(_l().isTermsCurrent(bob));
    }

    function test_Accept_RefusesAnythingButInForceOrAnnounced() public {
        _v1Now();
        vm.startPrank(alice);
        vm.expectRevert(LegalFacet.InvalidTosVersion.selector);
        _l().acceptTerms(1, H2);
        vm.expectRevert(LegalFacet.InvalidTosVersion.selector);
        _l().acceptTerms(2, H2);
        vm.expectRevert(LegalFacet.InvalidTosVersion.selector);
        _l().acceptTerms(0, bytes32(0));
        vm.stopPrank();
    }

    function test_Accept_RepeatKeepsFirstTime() public {
        _v1Now();
        vm.prank(alice);
        _l().acceptTerms(1, H1);
        uint64 first = uint64(vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.recordLogs();
        vm.prank(alice);
        _l().acceptTerms(1, H1);
        assertEq(vm.getRecordedLogs().length, 0, "a repeat writes nothing");
        assertEq(_l().getUserTosAcceptanceOf(alice, 1).acceptedAt, first);
    }

    function test_Accept_OpenWhilePaused() public {
        _v1Now();
        AdminFacet(address(diamond)).pause();
        vm.prank(alice);
        _l().acceptTerms(1, H1);
        assertTrue(_l().isTermsCurrent(alice));
    }

    // ─── Announcements ──────────────────────────────────────────────────

    function test_Notice_OnlyTheVersionInForceCounts() public {
        _v1Now();
        vm.prank(alice);
        _l().acceptTerms(1, H1);
        uint64 at = uint64(block.timestamp + 14 days);
        _l().announceTos(2, H2, at);
        (uint32 av, bytes32 ah, uint64 eff,,) = _l().getAnnouncedTos();
        assertEq(av, 2);
        assertEq(ah, H2);
        assertEq(eff, at);

        // bob accepts only the announced version: not current during the notice.
        vm.prank(bob);
        _l().acceptTerms(2, H2);
        assertFalse(_l().isTermsCurrent(bob), "announced-only is not current yet");
        assertTrue(_l().isTermsCurrent(alice), "the version in force counts");

        // One second before: unchanged. At the time: the new version, no call.
        vm.warp(at - 1);
        assertTrue(_l().isTermsCurrent(alice));
        vm.warp(at);
        (uint32 cv,) = _l().getCurrentTos();
        assertEq(cv, 2);
        (av,,,,) = _l().getAnnouncedTos();
        assertEq(av, 0);
        assertFalse(_l().isTermsCurrent(alice), "stale on the old version");
        assertTrue(_l().isTermsCurrent(bob), "carried over at the time");
        vm.expectRevert(abi.encodeWithSelector(LibTerms.TermsNotAccepted.selector, alice, uint32(2)));
        _l().requireCurrentTerms(alice);
        // The old version can no longer be accepted.
        vm.prank(alice);
        vm.expectRevert(LegalFacet.InvalidTosVersion.selector);
        _l().acceptTerms(1, H1);
        vm.prank(alice);
        _l().acceptTerms(2, H2);
        assertTrue(_l().isTermsCurrent(alice));
    }

    function test_Notice_FloorAndSpentNumbers() public {
        _v1Now();
        // Shorter than the floor.
        uint64 tooSoon = uint64(block.timestamp + 7 days - 1);
        vm.expectRevert(
            abi.encodeWithSelector(LegalFacet.TosNoticeTooShort.selector, tooSoon, uint64(block.timestamp + 7 days))
        );
        _l().announceTos(2, H2, tooSoon);
        // Exactly the floor.
        _l().announceTos(2, H2, uint64(block.timestamp + 7 days));
        // One at a time.
        vm.expectRevert(abi.encodeWithSelector(LegalFacet.TosAnnouncementPending.selector, uint32(2)));
        _l().announceTos(3, H2, uint64(block.timestamp + 8 days));
        // Withdrawn: the number is spent.
        vm.expectEmit(true, false, false, true, address(diamond));
        emit TosAnnouncementWithdrawn(2, H2, true);
        _l().withdrawTosAnnouncement();
        vm.expectRevert(LegalFacet.InvalidTosParams.selector);
        _l().announceTos(2, H2, uint64(block.timestamp + 7 days));
        _l().announceTos(3, H2, uint64(block.timestamp + 7 days));
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(LegalFacet.NoTosAnnouncement.selector);
        _l().withdrawTosAnnouncement(); // already in force: nothing to withdraw
        // A zero fingerprint is refused.
        vm.expectRevert(LegalFacet.InvalidTosParams.selector);
        _l().announceTos(4, bytes32(0), uint64(block.timestamp + 7 days));
    }

    function test_Announce_AdminOnly() public {
        vm.prank(alice);
        vm.expectRevert();
        _l().announceTos(1, H1, uint64(block.timestamp));
        vm.prank(alice);
        vm.expectRevert();
        _l().withdrawTosAnnouncement();
    }

    function test_JoinDuringNotice_BothInOneOwnTransaction_WithdrawalChangesNobody() public {
        _v1Now();
        _l().announceTos(2, H2, uint64(block.timestamp + 14 days));
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](2);
        calls[0] = MulticallFacet.Call(abi.encodeCall(LegalFacet.acceptTerms, (uint32(1), H1)), false);
        calls[1] = MulticallFacet.Call(abi.encodeCall(LegalFacet.acceptTerms, (uint32(2), H2)), false);
        vm.prank(alice);
        MulticallFacet(address(diamond)).multicall(calls);
        assertTrue(_l().isTermsCurrent(alice), "current before");
        assertEq(_l().getUserTosAcceptanceOf(alice, 1).version, 1);
        assertEq(_l().getUserTosAcceptanceOf(alice, 2).version, 2);
        // The latest record is the higher version.
        assertEq(_l().getUserTosAcceptance(alice).version, 2);

        // A withdrawal changes nobody's standing.
        uint256 snap = vm.snapshotState();
        _l().withdrawTosAnnouncement();
        assertTrue(_l().isTermsCurrent(alice));
        (uint32 cv,) = _l().getCurrentTos();
        assertEq(cv, 1);
        vm.revertToState(snap);

        // Or it comes into force: still current.
        vm.warp(block.timestamp + 14 days);
        assertTrue(_l().isTermsCurrent(alice), "current after");
    }

    // ─── Minimum version (design §5) ─────────────────────────────────────

    /// Test 16: a small change is the latest at once with no notice, and the
    /// minimum does not move: a wallet on the older version stays current,
    /// and a new acceptance names the latest only.
    function test_SmallChange_NoNotice_MinimumUnchanged() public {
        _v1Now();
        vm.prank(alice);
        _l().acceptTerms(1, H1);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit TosPublished(2, H2, 1, uint64(block.timestamp));
        _l().publishTos(2, H2);
        (uint32 latest, bytes32 lh, uint32 min) = _l().getTosVersions();
        assertEq(latest, 2);
        assertEq(lh, H2);
        assertEq(min, 1);
        assertTrue(_l().isTermsCurrent(alice), "v1 still counts");
        // bob joins: only the latest can be accepted.
        vm.startPrank(bob);
        vm.expectRevert(LegalFacet.InvalidTosVersion.selector);
        _l().acceptTerms(1, H1);
        _l().acceptTerms(2, H2);
        vm.stopPrank();
        assertTrue(_l().isTermsCurrent(bob));
        assertEq(_l().getTosVersionInForceAt(2), uint64(block.timestamp));
    }

    /// Test 5 / 17: a material change on the version already latest raises
    /// the minimum after the notice; until then standing is on the old one.
    function test_MaterialRaiseOfTheMinimum() public {
        _v1Now();
        vm.prank(alice);
        _l().acceptTerms(1, H1);
        _l().publishTos(2, H2);
        vm.expectRevert(abi.encodeWithSelector(LegalFacet.TosNoticeTooShort.selector, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days)));
        _l().announceTosMinimum(uint64(block.timestamp + 1 days));
        uint64 at = uint64(block.timestamp + 14 days);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit TosAnnounced(2, H2, at, 2, false);
        _l().announceTosMinimum(at);
        (uint32 av,, uint64 eff, uint32 amin, bool isNew) = _l().getAnnouncedTos();
        assertEq(av, 2);
        assertEq(eff, at);
        assertEq(amin, 2);
        assertFalse(isNew);
        vm.warp(at - 1);
        assertTrue(_l().isTermsCurrent(alice), "on the old minimum until the time");
        vm.warp(at);
        assertFalse(_l().isTermsCurrent(alice), "v1 no longer counts");
        (,, uint32 min) = _l().getTosVersions();
        assertEq(min, 2);
        vm.prank(alice);
        _l().acceptTerms(2, H2);
        assertTrue(_l().isTermsCurrent(alice));
        // Nothing left to raise.
        vm.expectRevert(LegalFacet.TosMinimumAlreadyLatest.selector);
        _l().announceTosMinimum(uint64(block.timestamp + 7 days));
    }

    /// Test 18: a wallet whose only acceptance is a withdrawn announced
    /// version is not current, whatever its number.
    function test_WithdrawnVersionNeverCounts() public {
        _v1Now();
        _l().announceTos(2, H2, uint64(block.timestamp + 7 days));
        vm.prank(alice);
        _l().acceptTerms(2, H2);
        _l().withdrawTosAnnouncement();
        assertFalse(_l().isTermsCurrent(alice));
        assertEq(_l().getTosVersionInForceAt(2), 0);
        uint32[] memory mine = _l().getUserAcceptedTosVersions(alice);
        assertEq(mine.length, 1);
        assertEq(mine[0], 2);
    }

    /// Test 19: cancelling a raise of the minimum to the version already
    /// latest changes nothing: the version stays published and counted, its
    /// number is not spent, and the raise can be announced again.
    function test_CancelledRaiseLeavesTheLatestCounted() public {
        _v1Now();
        _l().publishTos(2, H2);
        vm.prank(alice);
        _l().acceptTerms(2, H2);
        assertTrue(_l().isTermsCurrent(alice), "before");
        _l().announceTosMinimum(uint64(block.timestamp + 7 days));
        assertTrue(_l().isTermsCurrent(alice), "during");
        vm.expectEmit(true, false, false, true, address(diamond));
        emit TosAnnouncementWithdrawn(2, H2, false);
        _l().withdrawTosAnnouncement();
        vm.warp(block.timestamp + 8 days);
        assertTrue(_l().isTermsCurrent(alice), "after");
        (uint32 latest,, uint32 min) = _l().getTosVersions();
        assertEq(latest, 2);
        assertEq(min, 1);
        vm.prank(bob);
        _l().acceptTerms(2, H2);
        _l().announceTosMinimum(uint64(vm.getBlockTimestamp() + 7 days));
    }

    /// Test 20: one open change at a time; a spent number inside the
    /// minimum-to-latest range never counts.
    function test_OneOpenChange_SpentNumberInRangeNeverCounts() public {
        _v1Now();
        _l().announceTos(2, H2, uint64(block.timestamp + 7 days));
        vm.expectRevert(abi.encodeWithSelector(LegalFacet.TosAnnouncementPending.selector, uint32(2)));
        _l().publishTos(3, H3);
        vm.expectRevert(abi.encodeWithSelector(LegalFacet.TosAnnouncementPending.selector, uint32(2)));
        _l().announceTos(3, H3, uint64(block.timestamp + 8 days));
        vm.prank(alice);
        _l().acceptTerms(2, H2);
        _l().withdrawTosAnnouncement();
        _l().publishTos(3, H3);
        (uint32 latest,, uint32 min) = _l().getTosVersions();
        assertEq(latest, 3);
        assertEq(min, 1);
        assertFalse(_l().isTermsCurrent(alice), "the spent v2 is inside 1..3 but never came into force");
    }

    /// A small change may put the latest at most MAX_TOS_WINDOW above the
    /// minimum; past it the minimum is raised first.
    function test_SmallChangeWindowIsBounded() public {
        _v1Now();
        for (uint32 v = 2; v <= 17; ++v) _l().publishTos(v, keccak256(abi.encode(v)));
        bytes32 h18 = keccak256(abi.encode(uint32(18)));
        vm.expectRevert(abi.encodeWithSelector(LegalFacet.TosVersionWindowTooWide.selector, uint32(18), uint32(1)));
        _l().publishTos(18, h18);
        _l().announceTosMinimum(uint64(vm.getBlockTimestamp() + 7 days));
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _l().publishTos(18, h18);
        (uint32 latest,, uint32 min) = _l().getTosVersions();
        assertEq(latest, 18);
        assertEq(min, 17);
    }

    /// The window's far end still counts: a wallet whose only acceptance is
    /// the minimum is current with the latest 16 above it.
    function test_WindowFarEndCounts() public {
        _v1Now();
        vm.prank(alice);
        _l().acceptTerms(1, H1);
        for (uint32 v = 2; v <= 17; ++v) _l().publishTos(v, keccak256(abi.encode(v)));
        assertTrue(_l().isTermsCurrent(alice));
    }

    /// A fresh network may start at any version in one call: latest and
    /// minimum both that version.
    function test_FreshNetworkStartsAtThree() public {
        _l().publishTos(3, H3);
        (uint32 latest, bytes32 h, uint32 min) = _l().getTosVersions();
        assertEq(latest, 3);
        assertEq(h, H3);
        assertEq(min, 3);
        assertEq(_l().getTosVersionInForceAt(3), uint64(block.timestamp));
        assertFalse(_l().isTermsCurrent(alice));
        vm.prank(alice);
        _l().acceptTerms(3, H3);
        assertTrue(_l().isTermsCurrent(alice));
    }

    /// Accepting through the wallet's own multicall works while paused.
    function test_MulticallAcceptWhilePaused() public {
        _v1Now();
        _l().announceTos(2, H2, uint64(block.timestamp + 7 days));
        AdminFacet(address(diamond)).pause();
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](2);
        calls[0] = MulticallFacet.Call(abi.encodeCall(LegalFacet.acceptTerms, (uint32(1), H1)), false);
        calls[1] = MulticallFacet.Call(abi.encodeCall(LegalFacet.acceptTerms, (uint32(2), H2)), false);
        vm.prank(alice);
        MulticallFacet(address(diamond)).multicall(calls);
        assertTrue(_l().isTermsCurrent(alice));
        assertEq(_l().getUserAcceptedTosVersions(alice).length, 2);
    }

    function test_BackstopVaultIsExempt() public {
        _v1Now();
        vm.startPrank(owner);
        BackstopFacet(address(diamond)).initializeBackstopVaultImplementation();
        address backstop = BackstopFacet(address(diamond)).provisionBackstopVault();
        vm.stopPrank();
        assertTrue(_l().isTermsCurrent(backstop), "the platform's own vault is exempt");
        assertFalse(_l().isTermsCurrent(alice));
    }
}
