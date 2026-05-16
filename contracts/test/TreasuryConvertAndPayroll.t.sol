// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {PayrollFacet} from "../src/facets/PayrollFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
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
contract TreasuryConvertAndPayrollTest is SetupTest {
    address internal founder;

    // Convert-test target tokens.
    address internal wethTok;
    address internal wbtcTok;
    address internal vpfiTok;
    MockSwapAdapter internal adapter;
    uint256 internal adapterIdx; // slot of `adapter` in s.swapAdapters

    function setUp() public {
        setupHelper();
        founder = makeAddr("founder");
        // Foundry starts `block.timestamp` at 1. Advance well past the
        // 30-day convert interval so the time-leg of the eligibility
        // gate is satisfied for a never-converted treasury
        // (`treasuryLastConversionAt == 0`). Payroll tests warp
        // relative to this base, unaffected.
        vm.warp(block.timestamp + 40 days);
    }

    // ─── Convert harness ─────────────────────────────────────────────────

    /// @dev Wire the three convert targets + a 1:1 mock swap adapter at
    ///      slot 0, and seed `tokenIn` treasury balance + the Diamond's
    ///      physical balance. `tokenIn` is `mockERC20`.
    function _wireConvert(uint256 treasuryAmt) internal {
        wethTok = address(new ERC20Mock("WETH", "WETH", 18));
        wbtcTok = address(new ERC20Mock("WBTC", "WBTC", 8));
        vpfiTok = address(new ERC20Mock("VPFI", "VPFI", 18));

        TestMutatorFacet(address(diamond)).setWethContractRaw(wethTok);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setTreasuryWbtcAsset(wbtcTok);
        // Register the VPFI target. `setVPFIToken` does not validate the
        // target's interface, so a plain ERC20Mock stands in fine — the
        // convert function only swaps INTO it, never calls VPFI methods.
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(vpfiTok);

        adapter = new MockSwapAdapter("mock");
        vm.prank(owner);
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter));
        // SetupTest already registered an adapter at slot 0 — ours is
        // the last entry, whatever its index.
        adapterIdx = AdminFacet(address(diamond)).getSwapAdapters().length - 1;

        // Treasury holds `treasuryAmt` of mockERC20 — counter + physical.
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, treasuryAmt);
        ERC20Mock(mockERC20).mint(address(diamond), treasuryAmt);

        // Pre-fund the adapter so it can pay out each leg (1:1 mock).
        ERC20Mock(wethTok).mint(address(adapter), treasuryAmt);
        ERC20Mock(wbtcTok).mint(address(adapter), treasuryAmt);
        ERC20Mock(vpfiTok).mint(address(adapter), treasuryAmt);
    }

    function _calls() internal view returns (LibSwap.AdapterCall[] memory c) {
        c = new LibSwap.AdapterCall[](1);
        c[0] = LibSwap.AdapterCall({adapterIdx: adapterIdx, data: bytes("")});
    }

    // ─── Convert — gate reverts (no swap needed) ─────────────────────────

    function test_convert_treasuryNotDiamond_reverts() public {
        TestMutatorFacet(address(diamond)).setTreasuryAddress(makeAddr("extEOA"));
        vm.prank(owner);
        vm.expectRevert(TreasuryFacet.TreasuryNotDiamond.selector);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _calls(), _calls(), _calls(), 0, 0, 0
        );
    }

    function test_convert_zeroBalance_reverts() public {
        // treasury == diamond (SetupTest), but no accrued balance.
        vm.prank(owner);
        vm.expectRevert(TreasuryFacet.ZeroAmount.selector);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _calls(), _calls(), _calls(), 0, 0, 0
        );
    }

    function test_convert_targetUnset_reverts() public {
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, 10_000);
        TestMutatorFacet(address(diamond)).setWethContractRaw(address(0));
        vm.prank(owner);
        vm.expectRevert(TreasuryFacet.TreasuryConvertTargetUnset.selector);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _calls(), _calls(), _calls(), 0, 0, 0
        );
    }

    // ─── Convert — happy path ────────────────────────────────────────────

    function test_convert_happyPath_splitsAndCredits() public {
        _wireConvert(10_000);

        vm.prank(owner);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _calls(), _calls(), _calls(), 0, 0, 0
        );

        // Default allocation 40/30/30: toEth 4000, toWbtc 3000, toVpfi remainder 3000.
        assertEq(_treasuryBal(mockERC20), 0, "tokenIn balance zeroed");
        assertEq(_treasuryBal(wethTok), 4_000, "WETH leg credited");
        assertEq(_treasuryBal(wbtcTok), 3_000, "WBTC leg credited");
        assertEq(_treasuryBal(vpfiTok), 3_000, "VPFI leg (remainder) credited");
        // Each leg swapped 1:1 through the mock — 3 distinct legs.
        assertEq(adapter.callCount(), 3, "one swap per leg");
    }

    function test_convert_skipLeg_whenTokenInIsEthTarget() public {
        _wireConvert(10_000);
        // Make the WETH target == tokenIn — the ETH leg must skip-credit
        // (no self-swap), only WBTC + VPFI legs swap.
        TestMutatorFacet(address(diamond)).setWethContractRaw(mockERC20);

        vm.prank(owner);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _calls(), _calls(), _calls(), 0, 0, 0
        );

        // ETH leg (4000) credited straight back to mockERC20; WBTC + VPFI swapped.
        assertEq(_treasuryBal(mockERC20), 4_000, "ETH leg skip-credited to tokenIn");
        assertEq(_treasuryBal(wbtcTok), 3_000, "WBTC leg credited");
        assertEq(_treasuryBal(vpfiTok), 3_000, "VPFI leg credited");
        assertEq(adapter.callCount(), 2, "self-target leg skipped the swap");
    }

    function test_convert_notEligible_secondConversionTooSoon_reverts() public {
        _wireConvert(10_000);
        // First conversion succeeds (time-leg: never converted) and
        // stamps `treasuryLastConversionAt = now`.
        vm.prank(owner);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _calls(), _calls(), _calls(), 0, 0, 0
        );
        // A fresh small balance, retried immediately — inside the 30-day
        // interval AND below the USD threshold ⇒ the gate rejects it.
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, 100);
        ERC20Mock(mockERC20).mint(address(diamond), 100);
        vm.prank(owner);
        vm.expectRevert(TreasuryFacet.ConversionNotEligible.selector);
        TreasuryFacet(address(diamond)).convertTreasuryAsset(
            mockERC20, _calls(), _calls(), _calls(), 0, 0, 0
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
            mockERC20, _calls(), _calls(), _calls(), 0, 0, 0
        );

        // Whole call reverted — the CEI-zeroed input balance is rolled back.
        assertEq(_treasuryBal(mockERC20), 10_000, "input balance restored on revert");
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
