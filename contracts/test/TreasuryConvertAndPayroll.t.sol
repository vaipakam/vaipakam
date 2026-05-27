// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTreasury} from "./setup/SetupTreasury.t.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {PayrollFacet} from "../src/facets/PayrollFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title TreasuryConvertAndPayroll.t.sol
 * @notice T-600 — coverage for `TreasuryFacet.convertTreasuryAsset`
 *         (convert accumulated fees to the ETH/wBTC/VPFI target allocation) and
 *         the `PayrollFacet` founder-salary streams.
 */
contract TreasuryConvertAndPayrollTest is SetupTreasury {
    address internal founder;

    // Convert-test target tokens.
    address internal wethTok;
    address internal wbtcTok;
    address internal vpfiTok;
    MockSwapAdapter internal adapter;
    uint256 internal adapterIdx; // slot of `adapter` in s.swapAdapters

    function setUp() public override {
        super.setUp(); // SetupTreasury → SetupCore → TestBase
        founder = makeAddr("founder");
        // Foundry starts `block.timestamp` at 1. Advance well past the
        // 30-day convert interval so the time-leg of the eligibility
        // gate is satisfied for a never-converted treasury
        // (`treasuryLastConversionAt == 0`). Payroll tests warp
        // relative to this base, unaffected.
        vm.warp(block.timestamp + 40 days);
    }

    // ─── Convert harness ─────────────────────────────────────────────────

    /// @dev Wire a 1:1 mock swap adapter, the standard 3-entry target
    ///      allocation (40/30/30), and seed `tokenIn` (= `mockERC20`)
    ///      treasury balance + the Diamond's physical balance.
    function _wireConvert(uint256 treasuryAmt) internal {
        wethTok = address(new ERC20Mock("WETH", "WETH", 18));
        wbtcTok = address(new ERC20Mock("WBTC", "WBTC", 8));
        vpfiTok = address(new ERC20Mock("VPFI", "VPFI", 18));

        adapter = new MockSwapAdapter("mock");
        vm.prank(owner);
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter));
        // SetupTest already registered an adapter at slot 0 — ours is
        // the last entry, whatever its index.
        adapterIdx = AdminFacet(address(diamond)).getSwapAdapters().length - 1;

        _setTargets(wethTok, 4000, wbtcTok, 3000, vpfiTok, 3000);

        // Treasury holds `treasuryAmt` of mockERC20 — counter + physical.
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, treasuryAmt);
        ERC20Mock(mockERC20).mint(address(diamond), treasuryAmt);

        // Pre-fund the adapter so it can pay out each leg (1:1 mock).
        ERC20Mock(wethTok).mint(address(adapter), treasuryAmt);
        ERC20Mock(wbtcTok).mint(address(adapter), treasuryAmt);
        ERC20Mock(vpfiTok).mint(address(adapter), treasuryAmt);
    }

    /// @dev Replace the convert target allocation with a 3-entry list.
    function _setTargets(
        address a0, uint16 b0, address a1, uint16 b1, address a2, uint16 b2
    ) internal {
        LibVaipakam.TreasuryConvertTarget[] memory t =
            new LibVaipakam.TreasuryConvertTarget[](3);
        t[0] = LibVaipakam.TreasuryConvertTarget({asset: a0, bps: b0});
        t[1] = LibVaipakam.TreasuryConvertTarget({asset: a1, bps: b1});
        t[2] = LibVaipakam.TreasuryConvertTarget({asset: a2, bps: b2});
        vm.prank(owner);
        ConfigFacet(address(diamond)).setTreasuryConvertTargets(t);
    }

    /// @dev `n` per-target try-lists, each a single call at `adapterIdx`.
    function _perTargetCalls(uint256 n)
        internal
        view
        returns (LibSwap.AdapterCall[][] memory pc)
    {
        pc = new LibSwap.AdapterCall[][](n);
        for (uint256 i = 0; i < n; ++i) {
            pc[i] = new LibSwap.AdapterCall[](1);
            pc[i][0] = LibSwap.AdapterCall({adapterIdx: adapterIdx, data: bytes("")});
        }
    }

    function _minOuts(uint256 n) internal pure returns (uint256[] memory m) {
        m = new uint256[](n);
    }

    // ─── Convert — gate reverts (no swap needed) ─────────────────────────

    function test_convert_treasuryNotDiamond_reverts() public {
        TestMutatorFacet(address(diamond)).setTreasuryAddress(makeAddr("extEOA"));
        vm.prank(owner);
        vm.expectRevert(TreasuryFacet.TreasuryNotDiamond.selector);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(0), _minOuts(0)
        );
    }

    function test_convert_zeroBalance_reverts() public {
        // treasury == diamond (SetupTest), but no accrued balance.
        vm.prank(owner);
        vm.expectRevert(TreasuryFacet.ZeroAmount.selector);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(0), _minOuts(0)
        );
    }

    function test_convert_noTargets_reverts() public {
        // Balance seeded + eligible, but no target allocation configured.
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, 10_000);
        vm.prank(owner);
        vm.expectRevert(TreasuryFacet.TreasuryConvertNoTargets.selector);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(0), _minOuts(0)
        );
    }

    function test_convert_arityMismatch_reverts() public {
        _wireConvert(10_000); // 3 targets configured
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryFacet.TreasuryConvertArityMismatch.selector, 2, 3
            )
        );
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(2), _minOuts(2)
        );
    }

    // ─── Convert — happy path ────────────────────────────────────────────

    function test_convert_happyPath_splitsAndCredits() public {
        _wireConvert(10_000);

        vm.prank(owner);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(3), _minOuts(3)
        );

        // Allocation 40/30/30: 4000 WETH, 3000 wBTC, 3000 VPFI (remainder).
        assertEq(_treasuryBal(mockERC20), 0, "tokenIn balance zeroed");
        assertEq(_treasuryBal(wethTok), 4_000, "WETH leg credited");
        assertEq(_treasuryBal(wbtcTok), 3_000, "wBTC leg credited");
        assertEq(_treasuryBal(vpfiTok), 3_000, "VPFI leg (remainder) credited");
        assertEq(adapter.callCount(), 3, "one swap per leg");
    }

    function test_convert_skipLeg_whenTokenInIsTarget() public {
        _wireConvert(10_000);
        // Re-point the first target at `tokenIn` itself — that leg must
        // skip-credit (no self-swap); only the other two legs swap.
        _setTargets(mockERC20, 4000, wbtcTok, 3000, vpfiTok, 3000);

        vm.prank(owner);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(3), _minOuts(3)
        );

        assertEq(_treasuryBal(mockERC20), 4_000, "self-target leg skip-credited");
        assertEq(_treasuryBal(wbtcTok), 3_000, "wBTC leg credited");
        assertEq(_treasuryBal(vpfiTok), 3_000, "VPFI leg credited");
        assertEq(adapter.callCount(), 2, "self-target leg skipped the swap");
    }

    function test_convert_notEligible_secondConversionTooSoon_reverts() public {
        _wireConvert(10_000);
        // First conversion succeeds (time-leg: never converted) and
        // stamps `treasuryLastConversionAt = now`.
        vm.prank(owner);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(3), _minOuts(3)
        );
        // A fresh small balance, retried immediately — inside the 30-day
        // interval AND below the USD threshold ⇒ the gate rejects it.
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, 100);
        ERC20Mock(mockERC20).mint(address(diamond), 100);
        vm.prank(owner);
        vm.expectRevert(TreasuryFacet.ConversionNotEligible.selector);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(3), _minOuts(3)
        );
    }

    function test_convert_softFailure_revertsAndRollsBack() public {
        _wireConvert(10_000);
        adapter.setShouldRevert(true);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryFacet.TreasuryConvertSwapFailed.selector, wethTok
            )
        );
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(3), _minOuts(3)
        );

        // Whole call reverted — the CEI-zeroed input balance is rolled back.
        assertEq(_treasuryBal(mockERC20), 10_000, "input balance restored on revert");
    }

    // ─── Convert target-list validation ──────────────────────────────────

    function test_setTreasuryConvertTargets_empty_reverts() public {
        LibVaipakam.TreasuryConvertTarget[] memory t =
            new LibVaipakam.TreasuryConvertTarget[](0);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidTreasuryConvertTargets.selector, "empty"
            )
        );
        ConfigFacet(address(diamond)).setTreasuryConvertTargets(t);
    }

    function test_setTreasuryConvertTargets_bpsNot10000_reverts() public {
        LibVaipakam.TreasuryConvertTarget[] memory t =
            new LibVaipakam.TreasuryConvertTarget[](2);
        t[0] = LibVaipakam.TreasuryConvertTarget({asset: makeAddr("a"), bps: 4000});
        t[1] = LibVaipakam.TreasuryConvertTarget({asset: makeAddr("b"), bps: 5000});
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidTreasuryConvertTargets.selector, "bps-not-10000"
            )
        );
        ConfigFacet(address(diamond)).setTreasuryConvertTargets(t);
    }

    function test_setTreasuryConvertTargets_duplicate_reverts() public {
        address dup = makeAddr("dup");
        LibVaipakam.TreasuryConvertTarget[] memory t =
            new LibVaipakam.TreasuryConvertTarget[](2);
        t[0] = LibVaipakam.TreasuryConvertTarget({asset: dup, bps: 5000});
        t[1] = LibVaipakam.TreasuryConvertTarget({asset: dup, bps: 5000});
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidTreasuryConvertTargets.selector, "duplicate-asset"
            )
        );
        ConfigFacet(address(diamond)).setTreasuryConvertTargets(t);
    }

    function test_setTreasuryConvertTargets_addRemoveReweight() public {
        _wireConvert(10_000);
        // Re-point to a different 2-entry allocation (a "remove + reweight")
        // and confirm the convert function follows the new list.
        LibVaipakam.TreasuryConvertTarget[] memory t =
            new LibVaipakam.TreasuryConvertTarget[](2);
        t[0] = LibVaipakam.TreasuryConvertTarget({asset: wethTok, bps: 7000});
        t[1] = LibVaipakam.TreasuryConvertTarget({asset: vpfiTok, bps: 3000});
        vm.prank(owner);
        ConfigFacet(address(diamond)).setTreasuryConvertTargets(t);

        vm.prank(owner);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _perTargetCalls(2), _minOuts(2)
        );
        assertEq(_treasuryBal(wethTok), 7_000, "reweighted WETH leg");
        assertEq(_treasuryBal(vpfiTok), 3_000, "reweighted VPFI leg");
        assertEq(_treasuryBal(wbtcTok), 0, "removed wBTC leg got nothing");
    }

    // ─── Payroll — create / fund ─────────────────────────────────────────

    uint256 internal constant RATE = 1e15; // asset-wei per second

    function test_createPayrollStream() public {
        vm.prank(owner);
        uint256 id = PayrollFacet(address(diamond)).createPayrollStream(
            founder, mockERC20, RATE
        );
        assertEq(id, 1, "first stream id is 1");
        LibVaipakam.PayrollStream memory st =
            PayrollFacet(address(diamond)).getPayrollStream(id);
        assertEq(st.beneficiary, founder);
        assertEq(st.asset, mockERC20);
        assertEq(st.ratePerSecond, RATE);
        assertEq(st.funded, 0);
        assertTrue(st.exists);
        assertEq(PayrollFacet(address(diamond)).getPayrollStreamCount(), 1);
    }

    function test_createPayrollStream_zeroBeneficiary_reverts() public {
        vm.prank(owner);
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        PayrollFacet(address(diamond)).createPayrollStream(address(0), mockERC20, RATE);
    }

    function test_fundPayrollStream_debitsTreasury() public {
        uint256 id = _newStream(RATE);
        _seedTreasury(mockERC20, 1_000_000);

        vm.prank(owner);
        PayrollFacet(address(diamond)).fundPayrollStream(id, 400_000);

        assertEq(_treasuryBal(mockERC20), 600_000, "treasury debited by the top-up");
        assertEq(
            PayrollFacet(address(diamond)).getPayrollStream(id).funded,
            400_000,
            "stream funded credited"
        );
    }

    function test_fundPayrollStream_insufficientTreasury_reverts() public {
        uint256 id = _newStream(RATE);
        _seedTreasury(mockERC20, 100);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PayrollFacet.PayrollTreasuryInsufficient.selector, mockERC20, 500, 100
            )
        );
        PayrollFacet(address(diamond)).fundPayrollStream(id, 500);
    }

    function test_fundPayrollStream_unknownStream_reverts() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PayrollFacet.PayrollStreamNotFound.selector, 99)
        );
        PayrollFacet(address(diamond)).fundPayrollStream(99, 1);
    }

    // ─── Payroll — withdraw ──────────────────────────────────────────────

    function test_withdrawSalary_paysBeneficiary() public {
        uint256 id = _newStream(RATE);
        _fund(id, 1_000_000 * RATE);

        vm.warp(block.timestamp + 1_000);
        uint256 expected = 1_000 * RATE;

        vm.prank(founder);
        PayrollFacet(address(diamond)).withdrawSalary(id);

        assertEq(IERC20(mockERC20).balanceOf(founder), expected, "beneficiary paid");
        assertEq(
            PayrollFacet(address(diamond)).getPayrollStream(id).withdrawn,
            expected,
            "withdrawn recorded"
        );
    }

    function test_withdrawSalary_clampedToFunded() public {
        uint256 id = _newStream(RATE);
        _fund(id, 500 * RATE); // funds only 500 seconds' worth

        vm.warp(block.timestamp + 10_000); // accrue 10_000s — far more than funded
        vm.prank(founder);
        PayrollFacet(address(diamond)).withdrawSalary(id);

        // Withdrawal clamped to `funded` — the stream dried up.
        assertEq(IERC20(mockERC20).balanceOf(founder), 500 * RATE, "clamped to funded");
    }

    function test_withdrawSalary_nonBeneficiary_reverts() public {
        uint256 id = _newStream(RATE);
        _fund(id, 1_000 * RATE);
        vm.warp(block.timestamp + 100);
        vm.prank(makeAddr("intruder"));
        vm.expectRevert(PayrollFacet.NotPayrollBeneficiary.selector);
        PayrollFacet(address(diamond)).withdrawSalary(id);
    }

    function test_withdrawSalary_nothingToWithdraw_reverts() public {
        uint256 id = _newStream(RATE); // never funded, no time warped
        vm.prank(founder);
        vm.expectRevert(PayrollFacet.NothingToWithdraw.selector);
        PayrollFacet(address(diamond)).withdrawSalary(id);
    }

    // ─── Payroll — rate change / pause ───────────────────────────────────

    function test_setPayrollRate_settlesBeforeChange() public {
        uint256 id = _newStream(RATE);
        _fund(id, 1_000_000 * RATE);

        vm.warp(block.timestamp + 100);          // 100s at RATE
        vm.prank(owner);
        PayrollFacet(address(diamond)).setPayrollRate(id, 2 * RATE);
        vm.warp(block.timestamp + 200);          // 200s at 2*RATE

        // No retroactive re-pricing: 100*RATE + 200*2*RATE.
        uint256 expected = 100 * RATE + 200 * 2 * RATE;
        vm.prank(founder);
        PayrollFacet(address(diamond)).withdrawSalary(id);
        assertEq(IERC20(mockERC20).balanceOf(founder), expected, "rate change not retroactive");
    }

    function test_pause_freezesAccrual() public {
        uint256 id = _newStream(RATE);
        _fund(id, 1_000_000 * RATE);

        vm.warp(block.timestamp + 100);          // accrue 100s
        vm.prank(owner);
        PayrollFacet(address(diamond)).setPayrollStreamPaused(id, true);
        vm.warp(block.timestamp + 9_999);        // paused window — no accrual
        vm.prank(owner);
        PayrollFacet(address(diamond)).setPayrollStreamPaused(id, false);
        vm.warp(block.timestamp + 50);           // accrue 50s more

        uint256 expected = 150 * RATE;           // 100 + 50, the paused 9_999 excluded
        vm.prank(founder);
        PayrollFacet(address(diamond)).withdrawSalary(id);
        assertEq(IERC20(mockERC20).balanceOf(founder), expected, "paused window did not accrue");
    }

    // ─── Payroll — structural guarantee (the load-bearing negative test) ──

    function test_treasuryAccrual_doesNotFundStream() public {
        // A stream's `funded` must move ONLY via an explicit
        // `fundPayrollStream` top-up — never as a side effect of fees
        // landing in the treasury. This is what keeps the salary a
        // salary, not a securities-style revenue share.
        uint256 id = _newStream(RATE);

        // Simulate a large fee accrual into the treasury.
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, 1_000_000);
        ERC20Mock(mockERC20).mint(address(diamond), 1_000_000);

        // The stream is still unfunded — accrual did not touch it.
        assertEq(
            PayrollFacet(address(diamond)).getPayrollStream(id).funded,
            0,
            "treasury accrual must not fund the stream"
        );
        vm.warp(block.timestamp + 100_000);
        assertEq(
            PayrollFacet(address(diamond)).getWithdrawableSalary(id),
            0,
            "nothing withdrawable without an explicit top-up"
        );

        // Only an explicit top-up funds it — and exactly by that amount.
        vm.prank(owner);
        PayrollFacet(address(diamond)).fundPayrollStream(id, 777);
        assertEq(
            PayrollFacet(address(diamond)).getPayrollStream(id).funded,
            777,
            "funded == the explicit top-up, NOT the treasury balance"
        );
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _treasuryBal(address asset) internal view returns (uint256) {
        return TreasuryFacet(address(diamond)).getTreasuryBalance(asset);
    }

    function _newStream(uint256 rate) internal returns (uint256 id) {
        vm.prank(owner);
        id = PayrollFacet(address(diamond)).createPayrollStream(founder, mockERC20, rate);
    }

    function _seedTreasury(address asset, uint256 amount) internal {
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(asset, amount);
        ERC20Mock(asset).mint(address(diamond), amount);
    }

    /// @dev Seed treasury with `amount` and fund the stream fully with it.
    function _fund(uint256 id, uint256 amount) internal {
        _seedTreasury(mockERC20, amount);
        vm.prank(owner);
        PayrollFacet(address(diamond)).fundPayrollStream(id, amount);
    }
}
