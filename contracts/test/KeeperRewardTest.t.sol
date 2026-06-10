// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LibKeeperReward} from "../src/libraries/LibKeeperReward.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Test harness that exposes the internal LibKeeperReward.payVpfiReward
///      via a deployed Diamond facet path. We can't directly call internal
///      library functions; instead we run them via the LibKeeperReward
///      library at storage level — which is exactly how a real housekeeping
///      facet will use it. For this Phase-0 test we exercise the library
///      directly via a thin facet-like wrapper deployed inside the Diamond's
///      address (using vm.prank + delegate to simulate).
contract _PayHarness {
    function pay(address keeper, bytes32 actionKind, uint256 gasUsed)
        external returns (uint256)
    {
        return LibKeeperReward.payVpfiReward(keeper, actionKind, gasUsed);
    }
}

contract KeeperRewardTest is SetupTest {
    ERC20Mock internal vpfi;
    address internal keeper;

    function setUp() public {
        setupHelper();
        vpfi = new ERC20Mock("VPFI", "VPFI", 18);
        keeper = makeAddr("keeper");

        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        // Seed the diamond's VPFI balance + the keeperRewardBudget slot.
        vpfi.mint(address(diamond), 1_000_000e18);
        _seedKeeperBudget(500_000e18);
    }

    /// @dev Write directly into `s.keeperRewardBudget` via the diamond's
    ///      EIP-7201 storage slot, same probe pattern as TreasuryYieldTest.
    function _seedKeeperBudget(uint256 amount) internal {
        bytes32 baseSlot = 0x76f6f3ffb4e1cbadb2d289330bfeb7bd9d50e6e2407a61733161f6e3e1d10e00;
        // keeperRewardBudget is at a known offset within the Storage
        // struct. Probe to find it: write candidate, read back via
        // getKeeperRewardBudget, restore prior if mismatch.
        for (uint256 i = 0; i < 5000; ++i) {
            bytes32 slot = bytes32(uint256(baseSlot) + i);
            bytes32 prior = vm.load(address(diamond), slot);
            vm.store(address(diamond), slot, bytes32(amount));
            uint256 readBack = TreasuryFacet(address(diamond)).getKeeperRewardBudget();
            if (readBack == amount) return;
            vm.store(address(diamond), slot, prior);
        }
        revert("could not locate keeperRewardBudget slot");
    }

    function _t() internal view returns (TreasuryFacet) {
        return TreasuryFacet(address(diamond));
    }

    // ─── Config setters: happy paths ──────────────────────────────

    function test_SetKeeperRewardMultBps_HappyPath() public {
        _t().setKeeperRewardMultBps(30_000);
        assertEq(_t().getKeeperRewardMultBps(), 30_000);
    }

    function test_SetKeeperRewardMultBps_DefaultsTo20000() public view {
        assertEq(_t().getKeeperRewardMultBps(), 20_000);
    }

    function test_SetKeeperRewardCashOutSpreadBps_HappyPath() public {
        _t().setKeeperRewardCashOutSpreadBps(750);
        assertEq(_t().getKeeperRewardCashOutSpreadBps(), 750);
    }

    function test_SetKeeperRewardCashOutSpreadBps_DefaultsTo500() public view {
        assertEq(_t().getKeeperRewardCashOutSpreadBps(), 500);
    }

    function test_SetKeeperRewardEnabled_HappyPath() public {
        _t().setKeeperRewardEnabled(true);
        assertTrue(_t().getKeeperRewardEnabled());
        _t().setKeeperRewardEnabled(false);
        assertFalse(_t().getKeeperRewardEnabled());
    }

    function test_SetKeeperRewardTwapMaxAgeSec_HappyPath() public {
        _t().setKeeperRewardTwapMaxAgeSec(900);
        assertEq(_t().getKeeperRewardTwapMaxAgeSec(), 900);
    }

    function test_SetKeeperRewardTwapMaxAgeSec_DefaultsTo1800() public view {
        assertEq(_t().getKeeperRewardTwapMaxAgeSec(), 1800);
    }

    // ─── Config setters: bound enforcement ────────────────────────

    function test_SetKeeperRewardMultBps_RevertWhen_BelowMin() public {
        vm.expectRevert();
        _t().setKeeperRewardMultBps(9_999);
    }

    function test_SetKeeperRewardMultBps_RevertWhen_AboveMax() public {
        vm.expectRevert();
        _t().setKeeperRewardMultBps(100_001);
    }

    function test_SetKeeperRewardCashOutSpreadBps_RevertWhen_BelowMin() public {
        vm.expectRevert();
        _t().setKeeperRewardCashOutSpreadBps(99);
    }

    function test_SetKeeperRewardCashOutSpreadBps_RevertWhen_AboveMax() public {
        vm.expectRevert();
        _t().setKeeperRewardCashOutSpreadBps(2001);
    }

    function test_SetKeeperRewardMultBps_RevertWhen_NotAdmin() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        _t().setKeeperRewardMultBps(20_000);
    }

    function test_SetKeeperRewardEnabled_RevertWhen_NotAdmin() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        _t().setKeeperRewardEnabled(true);
    }
}
