// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestnetSanctionsOverlay} from "../../src/compliance/TestnetSanctionsOverlay.sol";
import {ISanctionsList} from "../../src/interfaces/ISanctionsList.sol";
import {MockSanctionsList} from "../mocks/MockSanctionsList.sol";

/**
 * @title  TestnetSanctionsOverlayTest
 * @notice #2439 — the overlay's own contract: the testnet-only constructor,
 *         the OR of its two lists, upstream failure passed through unchanged,
 *         source attribution, and owner-only flagging.
 */
contract TestnetSanctionsOverlayTest is Test {
    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    address internal wallet = makeAddr("wallet");
    address internal other = makeAddr("other");

    MockSanctionsList internal upstream;
    TestnetSanctionsOverlay internal overlay;

    event OverlayFlagSet(address indexed who, bool flagged);

    function setUp() public {
        upstream = new MockSanctionsList();
        overlay = new TestnetSanctionsOverlay(admin, address(upstream));
    }

    // ── Construction ──────────────────────────────────────────────────

    /// @notice Every mainnet the protocol targets is refused.
    function test_Constructor_RefusesMainnets() public {
        uint256[7] memory mainnets = [uint256(1), 8453, 42161, 10, 137, 56, 1101];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            vm.expectRevert(abi.encodeWithSelector(TestnetSanctionsOverlay.NotATestnet.selector, mainnets[i]));
            new TestnetSanctionsOverlay(admin, address(0));
        }
    }

    /// @notice A chain id nobody has classified is refused too: the list is an
    ///         allowlist.
    function test_Constructor_RefusesAnUnlistedChain() public {
        vm.chainId(999_999);
        vm.expectRevert(abi.encodeWithSelector(TestnetSanctionsOverlay.NotATestnet.selector, 999_999));
        new TestnetSanctionsOverlay(admin, address(0));
    }

    /// @notice Each listed testnet accepts it.
    function test_Constructor_AcceptsEveryListedTestnet() public {
        uint256[7] memory testnets = [uint256(84532), 11155111, 421614, 11155420, 80002, 97, 31337];
        for (uint256 i; i < testnets.length; ++i) {
            vm.chainId(testnets[i]);
            TestnetSanctionsOverlay o = new TestnetSanctionsOverlay(admin, address(0));
            assertTrue(o.isTestnetChain(testnets[i]));
        }
    }

    function test_Constructor_RefusesAnUpstreamWithNoCode() public {
        address eoa = makeAddr("not-an-oracle");
        vm.expectRevert(abi.encodeWithSelector(TestnetSanctionsOverlay.UpstreamHasNoCode.selector, eoa));
        new TestnetSanctionsOverlay(admin, eoa);
    }

    function test_Constructor_RecordsOwnerAndUpstream() public view {
        assertEq(overlay.owner(), admin);
        assertEq(address(overlay.upstream()), address(upstream));
    }

    // ── The OR of two lists ───────────────────────────────────────────

    function test_IsSanctioned_FalseWhenNeitherListFlags() public view {
        assertFalse(overlay.isSanctioned(wallet));
    }

    function test_IsSanctioned_TrueOnAnUpstreamFlag() public {
        upstream.setFlagged(wallet, true);
        assertTrue(overlay.isSanctioned(wallet));
        (bool byOverlay, bool byUpstream) = overlay.sanctionSource(wallet);
        assertFalse(byOverlay);
        assertTrue(byUpstream);
    }

    function test_IsSanctioned_TrueOnAnOverlayFlag() public {
        vm.prank(admin);
        overlay.setFlagged(wallet, true);
        assertTrue(overlay.isSanctioned(wallet));
        assertFalse(overlay.isSanctioned(other));
        (bool byOverlay, bool byUpstream) = overlay.sanctionSource(wallet);
        assertTrue(byOverlay);
        assertFalse(byUpstream);
    }

    function test_SanctionSource_ReportsBothWhenBothFlag() public {
        upstream.setFlagged(wallet, true);
        vm.prank(admin);
        overlay.setFlagged(wallet, true);
        (bool byOverlay, bool byUpstream) = overlay.sanctionSource(wallet);
        assertTrue(byOverlay);
        assertTrue(byUpstream);
    }

    /// @notice Clearing the overlay flag leaves an upstream flag standing: the
    ///         overlay can add to its upstream's list, never subtract from it.
    function test_ClearingTheOverlayFlag_DoesNotClearAnUpstreamFlag() public {
        upstream.setFlagged(wallet, true);
        vm.startPrank(admin);
        overlay.setFlagged(wallet, true);
        overlay.setFlagged(wallet, false);
        vm.stopPrank();
        assertTrue(overlay.isSanctioned(wallet));
    }

    function test_NoUpstream_TheOverlayIsTheWholeList() public {
        TestnetSanctionsOverlay solo = new TestnetSanctionsOverlay(admin, address(0));
        assertFalse(solo.isSanctioned(wallet));
        vm.prank(admin);
        solo.setFlagged(wallet, true);
        assertTrue(solo.isSanctioned(wallet));
        (bool byOverlay, bool byUpstream) = solo.sanctionSource(wallet);
        assertTrue(byOverlay);
        assertFalse(byUpstream);
    }

    // ── Upstream failure ──────────────────────────────────────────────

    /// @notice An upstream outage reaches the caller unchanged for an address
    ///         the overlay has not flagged, so the Diamond's fail-open and
    ///         fail-closed screens see exactly what the upstream would give them.
    function test_UpstreamOutage_PropagatesForAnUnflaggedAddress() public {
        upstream.setRevertOnRead(true);
        vm.expectRevert(bytes("oracle-outage"));
        overlay.isSanctioned(wallet);
    }

    /// @notice An overlay flag does not depend on upstream being reachable.
    function test_UpstreamOutage_AnOverlayFlagStillAnswersTrue() public {
        vm.prank(admin);
        overlay.setFlagged(wallet, true);
        upstream.setRevertOnRead(true);
        assertTrue(overlay.isSanctioned(wallet));
    }

    /// @notice Attribution asks both sources, so it cannot be answered while
    ///         one of them is down.
    function test_UpstreamOutage_AttributionReverts() public {
        vm.prank(admin);
        overlay.setFlagged(wallet, true);
        upstream.setRevertOnRead(true);
        vm.expectRevert(bytes("oracle-outage"));
        overlay.sanctionSource(wallet);
    }

    // ── Who may flag ──────────────────────────────────────────────────

    function test_SetFlagged_IsOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        overlay.setFlagged(wallet, true);
        assertFalse(overlay.isSanctioned(wallet));
    }

    function test_SetFlaggedBatch_IsOwnerOnly() public {
        address[] memory who = new address[](1);
        who[0] = wallet;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        overlay.setFlaggedBatch(who, true);
    }

    function test_SetFlagged_EmitsTheChange() public {
        vm.expectEmit(true, false, false, true, address(overlay));
        emit OverlayFlagSet(wallet, true);
        vm.prank(admin);
        overlay.setFlagged(wallet, true);
    }

    function test_SetFlaggedBatch_FlagsAndEmitsEach() public {
        address[] memory who = new address[](2);
        who[0] = wallet;
        who[1] = other;
        vm.expectEmit(true, false, false, true, address(overlay));
        emit OverlayFlagSet(wallet, true);
        vm.expectEmit(true, false, false, true, address(overlay));
        emit OverlayFlagSet(other, true);
        vm.prank(admin);
        overlay.setFlaggedBatch(who, true);
        assertTrue(overlay.isSanctioned(wallet));
        assertTrue(overlay.isSanctioned(other));
    }

    function test_SetFlaggedBatch_RefusesAnEmptyBatch() public {
        vm.prank(admin);
        vm.expectRevert(TestnetSanctionsOverlay.EmptyBatch.selector);
        overlay.setFlaggedBatch(new address[](0), true);
    }

    /// @notice Ownership moves in two steps, so a mistyped new owner cannot
    ///         take the list.
    function test_Ownership_IsTwoStep() public {
        vm.prank(admin);
        overlay.transferOwnership(stranger);
        assertEq(overlay.owner(), admin);
        vm.prank(stranger);
        overlay.acceptOwnership();
        assertEq(overlay.owner(), stranger);
    }

    /// @notice It satisfies the interface the Diamond reads.
    function test_ImplementsISanctionsList() public view {
        ISanctionsList asList = ISanctionsList(address(overlay));
        assertFalse(asList.isSanctioned(wallet));
    }
}
