// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {RefreshChangedFacetsInPlace} from "../../script/RefreshChangedFacetsInPlace.s.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {OwnershipFacet} from "../../src/facets/OwnershipFacet.sol";
import {PerkFacet} from "../../src/facets/PerkFacet.sol";
import {RewardEpochFacet} from "../../src/facets/RewardEpochFacet.sol";
import {RewardCustodyFacet} from "../../src/facets/RewardCustodyFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {MetricsFacet} from "../../src/facets/MetricsFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {RefreshAllFacetsInPlace} from "../../script/RefreshAllFacetsInPlace.s.sol";

/**
 * @title  RefreshChangedFacetsTest
 * @notice The changed-facet refresh refreshes exactly the facets whose
 *         EXECUTABLE code differs from this tree's build, and nothing else.
 *
 * @dev    A freshly deployed Diamond already runs this tree's code, so a
 *         facet is made "stale" by rewriting the code at its live address
 *         (`vm.etch`) — the routing still points at it, exactly as a live
 *         Diamond's routing points at a facet built from an older tree. The
 *         script compares code, not versions, so this is the property under
 *         test, not a stand-in for it. Each staleness fixture is first asserted
 *         LIVE (the etched code really differs), so a test cannot pass against a
 *         fixture that changed nothing.
 */
contract RefreshChangedFacetsTest is Test {
    uint256 internal constant DEPLOYER_KEY = 1;
    address internal constant TREASURY = address(0xBEEF);
    bytes32 internal constant CUT_TOPIC = keccak256("DiamondCut((address,uint8,bytes4[])[],address,bytes)");

    address internal diamond;
    IDiamondLoupe internal loupe;
    address internal owner;

    function setUp() public {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");
        DeployDiamond deployScript = new DeployDiamond();
        deployScript.runWith(vm.addr(DEPLOYER_KEY), TREASURY, DEPLOYER_KEY);
        diamond = deployScript.diamond();
        loupe = IDiamondLoupe(diamond);
        owner = OwnershipFacet(diamond).owner();
        assertEq(owner, vm.addr(DEPLOYER_KEY), "fixture: the deployer key owns the Diamond");
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _host(bytes4 sel) internal view returns (address) {
        return loupe.facetAddress(sel);
    }

    /// @dev Flip one byte of the EXECUTABLE part of the code at `at` (the
    ///      first byte after the opening PUSH1 0x80, well before the metadata).
    function _makeStale(address at) internal {
        bytes memory code = at.code;
        bytes32 before = keccak256(code);
        code[2] = bytes1(uint8(code[2]) ^ 0x01);
        vm.etch(at, code);
        assertTrue(keccak256(at.code) != before, "fixture-live: the etched code differs");
    }

    /// @dev Flip one byte inside the trailing CBOR metadata only.
    function _changeMetadataOnly(address at) internal {
        bytes memory code = at.code;
        uint256 len = code.length;
        uint256 meta = (uint256(uint8(code[len - 2])) << 8) | uint256(uint8(code[len - 1]));
        assertGt(meta, 4, "fixture: the facet carries metadata");
        uint256 i = len - 2 - meta + 3; // inside the CBOR body
        code[i] = bytes1(uint8(code[i]) ^ 0x01);
        bytes32 before = keccak256(at.code);
        vm.etch(at, code);
        assertTrue(keccak256(at.code) != before, "fixture-live: the metadata really differs");
    }

    function _facetAddresses() internal view returns (address[] memory) {
        return loupe.facetAddresses();
    }

    function _cutsIn(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == CUT_TOPIC) ++n;
        }
    }

    function _recordCurrent() internal view returns (bool) {
        (uint32 v, uint32 req, bytes32 stamped, bytes32 current) = RewardCustodyFacet(diamond).rewardCustodyCutoverStatus();
        return v == req && stamped == current;
    }

    // ── cells ───────────────────────────────────────────────────────────────

    /// A Diamond that already runs this tree's code: nothing is deployed and no
    /// cut is sent.
    function test_CurrentDiamond_RefreshesNothing() public {
        address[] memory before = _facetAddresses();
        RefreshChangedFacetsInPlace script = new RefreshChangedFacetsInPlace();
        vm.recordLogs();
        script.refreshChangedWith(diamond, DEPLOYER_KEY, "");
        assertEq(_cutsIn(vm.getRecordedLogs()), 0, "a current Diamond was cut");
        assertEq(bytes(script.lastChangedKeys()).length, 0, "a current Diamond reported a changed facet");
        assertEq(keccak256(abi.encode(_facetAddresses())), keccak256(abi.encode(before)), "routing moved");
    }

    /// A difference in the metadata alone is not a change: the code that runs
    /// is the same, so nothing is redeployed.
    function test_MetadataOnlyDifference_IsNotAChange() public {
        address perk = _host(PerkFacet.getPerkConfig.selector);
        _changeMetadataOnly(perk);
        RefreshChangedFacetsInPlace script = new RefreshChangedFacetsInPlace();
        vm.recordLogs();
        script.refreshChangedWith(diamond, DEPLOYER_KEY, "");
        assertEq(_cutsIn(vm.getRecordedLogs()), 0, "a metadata-only difference was cut");
        assertEq(_host(PerkFacet.getPerkConfig.selector), perk, "the perk facet moved");
    }

    /// Straddle: two facets whose executable code differs are refreshed —
    /// every one of their selectors moves to fresh bytecode equal to this
    /// tree's build — and every other facet keeps its address. The custody
    /// complete-cut record, current before (only code changed, not routing),
    /// is carried forward and current after. The run restores service.
    function test_RefreshesExactlyTheFacetsWhoseCodeDiffers() public {
        address perk = _host(PerkFacet.getPerkConfig.selector);
        address epoch = _host(RewardEpochFacet.getTransportDayScanIds.selector);
        assertTrue(_recordCurrent(), "fixture: the deploy stamped the complete-cut record");
        _makeStale(perk);
        _makeStale(epoch);
        address[] memory before = _facetAddresses();

        RefreshChangedFacetsInPlace script = new RefreshChangedFacetsInPlace();
        script.refreshChangedWith(diamond, DEPLOYER_KEY, "perkFacet,rewardEpochFacet");

        assertEq(script.lastChangedKeys(), "perkFacet,rewardEpochFacet", "the changed set");
        address newPerk = _host(PerkFacet.getPerkConfig.selector);
        address newEpoch = _host(RewardEpochFacet.getTransportDayScanIds.selector);
        assertTrue(newPerk != perk && newEpoch != epoch, "both stale facets were replaced");
        assertEq(keccak256(newPerk.code), keccak256(address(new PerkFacet()).code), "perk runs this tree's build");
        assertEq(keccak256(newEpoch.code), keccak256(address(new RewardEpochFacet()).code), "epoch runs this tree's build");
        assertEq(_host(PerkFacet.getPriorityRoutingStatus.selector), newPerk, "every perk selector moved");

        address[] memory afterRun = _facetAddresses();
        assertEq(afterRun.length, before.length, "no facet added or dropped");
        for (uint256 i; i < before.length; ++i) {
            if (before[i] == perk || before[i] == epoch) continue;
            bool kept;
            for (uint256 j; j < afterRun.length; ++j) {
                if (afterRun[j] == before[i]) kept = true;
            }
            assertTrue(kept, "an unchanged facet was moved");
        }
        assertTrue(_recordCurrent(), "the complete-cut record is carried forward");
        assertFalse(AdminFacet(diamond).paused(), "service restored");
    }

    /// A selector the build has but the Diamond does not route (a newly added
    /// function) marks its facet changed and is ADDED, while the rest of the
    /// facet is Replaced. The routing changed before the run, so the record was
    /// not current then and is not stamped by this partial run.
    function test_UnroutedSelector_IsAdded_AndAnUncurrentRecordIsNotStamped() public {
        bytes4[] memory gone = new bytes4[](1);
        gone[0] = PerkFacet.getPriorityRoutingStatus.selector;
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(0), action: IDiamondCut.FacetCutAction.Remove, functionSelectors: gone
        });
        vm.prank(owner);
        IDiamondCut(diamond).diamondCut(cut, address(0), "");
        assertEq(_host(gone[0]), address(0), "fixture-live: the selector is unrouted");
        assertFalse(_recordCurrent(), "fixture-live: the record is no longer current");

        RefreshChangedFacetsInPlace script = new RefreshChangedFacetsInPlace();
        script.refreshChangedWith(diamond, DEPLOYER_KEY, "perkFacet");

        address newPerk = _host(PerkFacet.getPerkConfig.selector);
        assertEq(_host(gone[0]), newPerk, "the unrouted selector was added to the refreshed facet");
        assertFalse(_recordCurrent(), "a record that was not current is not stamped by a partial run");
    }

    /// A route this tree no longer installs, left on a facet the run replaces,
    /// is removed (the stale-route sweep).
    function test_RetiredRouteOnAReplacedFacet_IsSwept() public {
        address perk = _host(PerkFacet.getPerkConfig.selector);
        bytes4[] memory retired = new bytes4[](1);
        retired[0] = bytes4(0xdeadbeef);
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: perk, action: IDiamondCut.FacetCutAction.Add, functionSelectors: retired
        });
        vm.prank(owner);
        IDiamondCut(diamond).diamondCut(cut, address(0), "");
        assertEq(_host(retired[0]), perk, "fixture-live: the retired route is routed");
        _makeStale(perk);

        RefreshChangedFacetsInPlace script = new RefreshChangedFacetsInPlace();
        script.refreshChangedWith(diamond, DEPLOYER_KEY, "perkFacet");

        assertEq(_host(retired[0]), address(0), "the retired route was removed");
        assertEq(loupe.facetFunctionSelectors(perk).length, 0, "the old perk bytecode routes nothing");
    }

    /// The operator's expectation must match what the run finds; a mismatch
    /// refuses before any transaction, naming the set actually found.
    function test_ExpectChangedMismatch_Refuses() public {
        _makeStale(_host(PerkFacet.getPerkConfig.selector));
        RefreshChangedFacetsInPlace script = new RefreshChangedFacetsInPlace();
        vm.expectRevert(
            bytes("RefreshChangedFacetsInPlace: EXPECT_CHANGED does not match the changed set found: perkFacet")
        );
        script.refreshChangedWith(diamond, DEPLOYER_KEY, "vaultFactoryFacet");
    }

    /// A key that does not own the Diamond refuses up front.
    function test_NonOwnerKey_Refuses() public {
        RefreshChangedFacetsInPlace script = new RefreshChangedFacetsInPlace();
        vm.expectRevert(bytes("RefreshChangedFacetsInPlace: the signing key is not the diamond owner"));
        script.refreshChangedWith(diamond, 2, "");
    }

    // ── #902: crossing the per-rental rows in place ─────────────────────────

    address internal _hostOfRentalRoute;

    /// @dev Make the Diamond read as pre-#902 (no `vaultSetRentalUser` route)
    ///      with `ids` open, each carrying `assetType`.
    function _pre902WithOpen(uint256[] memory ids, LibVaipakam.AssetType assetType) internal {
        vm.mockCall(
            diamond,
            abi.encodeWithSelector(IDiamondLoupe.facetAddress.selector, VaultFactoryFacet.vaultSetRentalUser.selector),
            abi.encode(address(0))
        );
        vm.mockCall(
            diamond,
            abi.encodeWithSelector(MetricsFacet.getActiveLoansPaginated.selector, uint256(0), uint256(200)),
            abi.encode(ids)
        );
        for (uint256 i; i < ids.length; ++i) {
            LibVaipakam.Loan memory loan;
            loan.id = ids[i];
            loan.assetType = assetType;
            vm.mockCall(diamond, abi.encodeWithSelector(LoanFacet.getLoanDetails.selector, ids[i]), abi.encode(loan));
        }
    }

    /// A pre-#902 Diamond with an open ERC-1155 rental is refused before
    /// anything is deployed, naming the loan: its vault row is keyed by renter
    /// and the per-rental writes would never find it.
    function test_902_OpenErc1155RentalAcrossTheBoundary_Refuses() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 3;
        ids[1] = 9;
        _pre902WithOpen(ids, LibVaipakam.AssetType.ERC1155);
        RefreshChangedFacetsInPlace script = new RefreshChangedFacetsInPlace();
        vm.expectRevert(
            abi.encodeWithSelector(RefreshAllFacetsInPlace.OpenErc1155RentalAcrossPerRentalRows.selector, diamond, uint256(3))
        );
        script.refreshChangedWith(diamond, DEPLOYER_KEY, "");
    }

    /// Open loans of any other kind do not hold the boundary.
    function test_902_OpenNon1155LoansAcrossTheBoundary_Pass() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 4;
        _pre902WithOpen(ids, LibVaipakam.AssetType.ERC721);
        Guard902Harness h = new Guard902Harness();
        h.check(diamond);
    }

    /// A Diamond already past the boundary is not walked, so an open ERC-1155
    /// rental on it (whose row is loan-keyed) does not refuse.
    function test_902_PastTheBoundary_IsNotWalked() public {
        _hostOfRentalRoute = _host(VaultFactoryFacet.vaultSetRentalUser.selector);
        assertTrue(_hostOfRentalRoute != address(0), "fixture: the fresh Diamond routes the rental writes");
        uint256[] memory ids = new uint256[](1);
        ids[0] = 5;
        _pre902WithOpen(ids, LibVaipakam.AssetType.ERC1155);
        // Restore the real route: only the loupe answer is put back, so the
        // open ERC-1155 loan stays in place for a walk that must not happen.
        vm.mockCall(
            diamond,
            abi.encodeWithSelector(IDiamondLoupe.facetAddress.selector, VaultFactoryFacet.vaultSetRentalUser.selector),
            abi.encode(_hostOfRentalRoute)
        );
        Guard902Harness h = new Guard902Harness();
        h.check(diamond);
    }
}

/// @dev Exposes the #902 boundary check of the in-place refreshes.
contract Guard902Harness is RefreshChangedFacetsInPlace {
    function check(address d) external view {
        _requireNoOpenErc1155RentalAcross902(d);
    }
}
