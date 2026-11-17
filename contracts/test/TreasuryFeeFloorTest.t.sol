// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {TreasuryFeeFacet} from "../src/facets/TreasuryFeeFacet.sol";
import {FeeLevelsFacet} from "../src/facets/FeeLevelsFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ITreasuryFeeHost} from "../src/interfaces/ITreasuryFeeHost.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";

/// @title  TreasuryFeeFloorTest
/// @notice #3649 stage 3 — the treasury floor split
///         (`ShortfallReserveDesign.md` section 8, `FeeLevelsDesign.md`
///         section 11): the treasury keeps a fee up to its floor and the part
///         above it is the reserve's, counted as held by the treasury until a
///         reserve is named. Initiation floor 0.1% of the principal, interest
///         floor 1% of the interest, an extension's added fee the reserve's
///         whole, every other fee the treasury's whole.
contract TreasuryFeeFloorTest is SetupTest {
    event TreasuryFeeSplit(
        address indexed asset, ITreasuryFeeHost.FeeKind indexed kind, uint256 treasuryPart, uint256 reservePart
    );

    address internal treasury;
    TreasuryFeeFacet internal host;
    FeeLevelsFacet internal levels;
    ConfigFacet internal config;

    function setUp() public {
        setupHelper();
        treasury = makeAddr("floorTreasury");
        LibTestVaultBeacon.setTreasury(address(diamond), treasury);
        host = TreasuryFeeFacet(address(diamond));
        levels = FeeLevelsFacet(address(diamond));
        config = ConfigFacet(address(diamond));
    }

    function _push(uint256 amount, ITreasuryFeeHost.FeeKind kind, uint256 base) internal returns (uint256 accrued) {
        ERC20Mock(mockERC20).mint(address(diamond), amount);
        vm.prank(address(diamond));
        accrued = host.collectFeeFromDiamond(mockERC20, amount, kind, base);
    }

    /// @dev {_push} with the split event expected from the host call itself
    ///      (the mint's Transfer comes first, so the expectation is set after it).
    function _pushExpect(
        uint256 amount,
        ITreasuryFeeHost.FeeKind kind,
        uint256 base,
        uint256 treasuryPart,
        uint256 reservePart
    ) internal {
        ERC20Mock(mockERC20).mint(address(diamond), amount);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit TreasuryFeeSplit(mockERC20, kind, treasuryPart, reservePart);
        vm.prank(address(diamond));
        host.collectFeeFromDiamond(mockERC20, amount, kind, base);
    }

    function _held() internal view returns (uint256) {
        return host.getReservePartHeldByTreasury(mockERC20);
    }

    // ── The split ────────────────────────────────────────────────────────

    /// A 0.2% initiation fee on 10,000: the treasury keeps 10 (0.1%), the
    /// reserve's part is the other 10. Both go to the treasury today.
    function test_initiationFee_floorThenReserve() public {
        _pushExpect(20 ether, ITreasuryFeeHost.FeeKind.Initiation, 10_000 ether, 10 ether, 10 ether);
        assertEq(_held(), 10 ether, "the reserve's part is counted");
        assertEq(ERC20Mock(mockERC20).balanceOf(treasury), 20 ether, "the treasury holds the whole fee today");
    }

    /// A fee discounted to or below the floor sends nothing to the reserve:
    /// a discount comes out of the reserve's part first.
    function test_feeAtOrBelowFloor_allTreasury() public {
        _pushExpect(7 ether, ITreasuryFeeHost.FeeKind.Initiation, 10_000 ether, 7 ether, 0);
        _push(10 ether, ITreasuryFeeHost.FeeKind.Initiation, 10_000 ether);
        assertEq(_held(), 0, "nothing above the floor");
    }

    /// The floor rounds up, so the treasury is never short of it by rounding.
    function test_floorRoundsUp() public {
        // 0.1% of 1,001 wei is 1.001 wei: the floor is 2 wei.
        _pushExpect(3, ITreasuryFeeHost.FeeKind.Initiation, 1001, 2, 1);
    }

    /// The 10% share of 1,000 interest is 100: the floor is 1% of the
    /// interest (10), the reserve's part 90.
    function test_interestShare_floorOnTheInterest() public {
        _pushExpect(100 ether, ITreasuryFeeHost.FeeKind.Interest, 1_000 ether, 10 ether, 90 ether);
        assertEq(_held(), 90 ether);
    }

    /// An extension's added fee takes no floor: the reserve's whole.
    function test_extensionFee_reserveWhole() public {
        _pushExpect(5 ether, ITreasuryFeeHost.FeeKind.Extension, 0, 0, 5 ether);
        assertEq(_held(), 5 ether);
    }

    /// Every other fee is the treasury's whole and is not split.
    function test_otherFee_treasuryWhole_noSplitEvent() public {
        vm.recordLogs();
        _push(5 ether, ITreasuryFeeHost.FeeKind.Other, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != TreasuryFeeSplit.selector, "not split");
        }
        assertEq(_held(), 0);
        assertEq(ERC20Mock(mockERC20).balanceOf(treasury), 5 ether);
    }

    /// One extension from 30 to 365 days and the same extension made in
    /// steps send the same totals to each side (design test 8): the
    /// initiation floor is taken once, at acceptance, and an added fee
    /// carries none.
    function test_extensionInStepsMatchesOneStep() public {
        _push(20 ether, ITreasuryFeeHost.FeeKind.Initiation, 10_000 ether);
        _push(80 ether, ITreasuryFeeHost.FeeKind.Extension, 0);
        uint256 oneStep = _held();
        assertEq(oneStep, 90 ether);
        // A fresh asset for the stepped path.
        ERC20Mock other = new ERC20Mock("O", "O", 18);
        address asset = address(other);
        other.mint(address(diamond), 100 ether);
        vm.startPrank(address(diamond));
        host.collectFeeFromDiamond(asset, 20 ether, ITreasuryFeeHost.FeeKind.Initiation, 10_000 ether);
        for (uint256 i; i < 8; ++i) {
            host.collectFeeFromDiamond(asset, 10 ether, ITreasuryFeeHost.FeeKind.Extension, 0);
        }
        vm.stopPrank();
        assertEq(host.getReservePartHeldByTreasury(asset), oneStep, "same reserve total");
    }

    /// The host stays Diamond-only.
    function test_hostIsDiamondOnly() public {
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        host.collectFeeFromDiamond(mockERC20, 1, ITreasuryFeeHost.FeeKind.Interest, 1);
    }

    // ── Settings ─────────────────────────────────────────────────────────

    function test_floorDefaults() public view {
        (uint256 i, uint256 r) = levels.getTreasuryFeeFloors();
        assertEq(i, 10, "0.1% of the principal");
        assertEq(r, 100, "1% of the interest");
    }

    function test_setFloors_appliesAndRestores() public {
        levels.setTreasuryFeeFloors(5, 200);
        (uint256 i, uint256 r) = levels.getTreasuryFeeFloors();
        assertEq(i, 5);
        assertEq(r, 200);
        _pushExpect(100 ether, ITreasuryFeeHost.FeeKind.Interest, 1_000 ether, 20 ether, 80 ether);
        levels.setTreasuryFeeFloors(0, 0);
        (i, r) = levels.getTreasuryFeeFloors();
        assertEq(i, 10);
        assertEq(r, 100);
    }

    function test_setFloors_bounds() public {
        vm.expectRevert(abi.encodeWithSelector(FeeLevelsFacet.InvalidTreasuryFeeFloors.selector, 21, 100));
        levels.setTreasuryFeeFloors(21, 100);
        vm.expectRevert(abi.encodeWithSelector(FeeLevelsFacet.InvalidTreasuryFeeFloors.selector, 10, 501));
        levels.setTreasuryFeeFloors(10, 501);
        levels.setTreasuryFeeFloors(10, 500); // half of the 10% share
    }

    /// The half rule (design thread 2026-11-17): a floor may not exceed half
    /// the rate it is taken from, checked from both sides, so the part above
    /// the floor never closes.
    function test_halfRule_bothSides() public {
        // Above half the 0.2% base rate.
        vm.expectRevert(abi.encodeWithSelector(FeeLevelsFacet.InvalidTreasuryFeeFloors.selector, 11, 100));
        levels.setTreasuryFeeFloors(11, 100);
        // Above half a lowered interest share.
        config.setFeesConfig(400, 0);
        vm.expectRevert(abi.encodeWithSelector(FeeLevelsFacet.InvalidTreasuryFeeFloors.selector, 10, 201));
        levels.setTreasuryFeeFloors(10, 201);
        // The rates may not fall below twice the floors in force.
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidFeeBps.selector, 19, 20));
        config.setFeesConfig(1000, 19);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidFeeBps.selector, 199, 200));
        config.setFeesConfig(199, 0);
        config.setFeesConfig(200, 20);
    }

    function test_setFloors_adminOnly() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        levels.setTreasuryFeeFloors(10, 100);
    }
}
