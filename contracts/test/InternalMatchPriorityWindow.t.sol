// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskSplitLiquidationFacet} from "../src/facets/RiskSplitLiquidationFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/**
 * @title InternalMatchPriorityWindow.t.sol
 * @notice PR4 of the internal-match work — exercises the
 *         priority-window gate inside the existing
 *         `RiskFacet.triggerLiquidation`. With the kill-switch
 *         off the gate short-circuits and external liquidation
 *         behaves exactly as today; with it on, the gate
 *         reverts `InternalMatchOnlyBand` when the loan's
 *         current LTV is inside `[liquidationLtvBpsAtInit,
 *         liquidationLtvBpsAtInit + externalLiquidationPriorityWindowBps)`.
 *
 *         The intent is the 2% LTV "internal matchers only"
 *         window: external bots are blocked there so internal
 *         matchers have an uncontested priority slot. Above that
 *         window, external opens (worst case ~2% LTV
 *         deterioration vs today; bounded by
 *         MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS = 500).
 *
 *         All HF-blocked / sequencer / sanctions / liquidity-
 *         classification checks happen BEFORE this gate; the
 *         tests cover that interaction via vm.mockCall so the
 *         external path's plumbing isn't load-bearing here.
 */
contract InternalMatchPriorityWindowTest is SetupTest {
    uint256 internal constant LOAN_ID = 4711;

    function setUp() public {
        setupHelper();
        // Seed a synthetic Active loan with Liquid collateral so
        // the gate's reads land on real fields.
        LibVaipakam.Loan memory l;
        l.id = LOAN_ID;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender;
        l.borrower = borrower;
        l.principalAsset = mockERC20;
        l.collateralAsset = mockCollateralERC20;
        l.principal = 1000;
        l.collateralAmount = 1500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, l);

        // Mock the gauntlet so `triggerLiquidation` reaches the
        // priority-window gate cleanly:
        //   - HF < 1 (liquidatable),
        //   - sequencer healthy,
        //   - collateral liquid on active network.
        // Each test then mocks `calculateLTV` to land inside or
        // outside the priority window.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, LOAN_ID),
            abi.encode(uint256(0.99e18))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(bytes4(keccak256("sequencerHealthy()"))),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                bytes4(keccak256("checkLiquidityOnActiveNetwork(address)")),
                mockCollateralERC20
            ),
            abi.encode(uint8(LibVaipakam.LiquidityStatus.Liquid))
        );
    }

    function _adapterCalls() internal pure returns (LibSwap.AdapterCall[] memory) {
        return new LibSwap.AdapterCall[](0);
    }

    function test_killSwitchOff_externalStaysCallable() public {
        // Switch off → priority-window gate short-circuits → external
        // proceeds past it. The downstream swap stack reverts
        // (zero adapter calls, no allowance, etc.) — that's fine
        // for the gate-isolation test: we only assert the gate
        // didn't fire.
        // Force a tight LTV (just above floor) — inside what
        // WOULD have been the priority window if enabled.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, LOAN_ID),
            abi.encode(uint256(8_600))
        );

        // External should NOT revert with InternalMatchOnlyBand.
        // Catch the downstream revert with try/catch and assert
        // the selector doesn't match the gate's error.
        try RiskFacet(address(diamond)).triggerLiquidation(LOAN_ID, _adapterCalls()) {
            // If somehow it succeeds in test env, that's also fine —
            // means the gate didn't fire.
        } catch (bytes memory reason) {
            // safe: no SafeCast variant for bytes-target casts; this site narrows a longer hash to its prefix, which is the intended bytes4(<bytes-expr>) pattern.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 selector = bytes4(reason);
            require(
                selector != RiskFacet.InternalMatchOnlyBand.selector,
                "kill-switch off should not trigger the priority-window gate"
            );
        }
    }

    function test_killSwitchOn_ltvBelowWindowCeiling_reverts() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);

        // LTV inside the priority window: floor=8500, window=200,
        // ceiling=8700. Set LTV = 8600 → INSIDE the band → revert.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, LOAN_ID),
            abi.encode(uint256(8_600))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.InternalMatchOnlyBand.selector,
                uint256(8_600),
                uint256(8_700)
            )
        );
        RiskFacet(address(diamond)).triggerLiquidation(LOAN_ID, _adapterCalls());
    }

    function test_killSwitchOn_ltvAtWindowCeiling_externalOpens() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);

        // LTV at the ceiling exactly (8500 + 200 = 8700) → external
        // opens up. Downstream swap stack will revert (no adapter
        // calls) but the priority-window gate must not fire.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, LOAN_ID),
            abi.encode(uint256(8_700))
        );

        try RiskFacet(address(diamond)).triggerLiquidation(LOAN_ID, _adapterCalls()) {}
        catch (bytes memory reason) {
            // safe: no SafeCast variant for bytes-target casts; this is the
            // standard `bytes4(<bytes-error-payload>)` selector-extraction
            // pattern Solidity tooling uses.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 selector = bytes4(reason);
            require(
                selector != RiskFacet.InternalMatchOnlyBand.selector,
                "LTV at window ceiling should not trigger the gate"
            );
        }
    }

    function test_killSwitchOn_ltvAboveWindow_externalOpens() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);

        // LTV well above the priority-window ceiling (8500 + 200 =
        // 8700). Set LTV = 9500 → external proceeds past the gate.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, LOAN_ID),
            abi.encode(uint256(9_500))
        );

        try RiskFacet(address(diamond)).triggerLiquidation(LOAN_ID, _adapterCalls()) {}
        catch (bytes memory reason) {
            // safe: no SafeCast variant for bytes-target casts; this is the
            // standard `bytes4(<bytes-error-payload>)` selector-extraction
            // pattern Solidity tooling uses.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 selector = bytes4(reason);
            require(
                selector != RiskFacet.InternalMatchOnlyBand.selector,
                "LTV above window should not trigger the gate"
            );
        }
    }

    function test_windowSizeRespectedAfterTune() public {
        // Tune the window to 500 BPS (5%) — the cap. Floor=8500 ⇒
        // ceiling=9000. LTV=8900 should now be inside the window
        // and revert.
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
        ConfigFacet(address(diamond)).setInternalMatchConfig(500, 100);
        vm.stopPrank();

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, LOAN_ID),
            abi.encode(uint256(8_900))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.InternalMatchOnlyBand.selector,
                uint256(8_900),
                uint256(9_000)
            )
        );
        RiskFacet(address(diamond)).triggerLiquidation(LOAN_ID, _adapterCalls());
    }

    /// @notice #395 (Codex r3 P2) — `triggerPartialLiquidation` must defer to
    ///         the internal-match priority window too, or a keeper could use a
    ///         partial to dump collateral externally mid-window and bypass the
    ///         ordering. Same in-window LTV → same `InternalMatchOnlyBand`
    ///         revert as the full-liquidation path above. The loan is
    ///         re-stamped in-term so the partial passes its maturity gate and
    ///         reaches the priority block.
    function test_partial_killSwitchOn_ltvBelowWindowCeiling_reverts() public {
        LibVaipakam.Loan memory l;
        l.id = LOAN_ID;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender;
        l.borrower = borrower;
        l.principalAsset = mockERC20;
        l.collateralAsset = mockCollateralERC20;
        l.principal = 1000;
        l.collateralAmount = 1500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30; // in-term so the partial maturity gate passes
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, l);

        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);

        // LTV inside the window (floor 8500, window 200, ceiling 8700).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, LOAN_ID),
            abi.encode(uint256(8_600))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.InternalMatchOnlyBand.selector,
                uint256(8_600),
                uint256(8_700)
            )
        );
        RiskFacet(address(diamond)).triggerPartialLiquidation(
            LOAN_ID, 5_000, _adapterCalls()
        );
    }

    /// @notice #395 (Codex r5 P2) — `triggerLiquidationSplit` must defer to the
    ///         internal-match priority window too, or a keeper could route an
    ///         in-window loan through the split path and bypass the ordering.
    ///         Same in-window LTV → same `InternalMatchOnlyBand` revert (the
    ///         gate fires before any swap, so an empty split spec is fine).
    function test_split_killSwitchOn_ltvBelowWindowCeiling_reverts() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, LOAN_ID),
            abi.encode(uint256(8_600))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskFacet.InternalMatchOnlyBand.selector,
                uint256(8_600),
                uint256(8_700)
            )
        );
        RiskSplitLiquidationFacet(address(diamond)).triggerLiquidationSplit(
            LOAN_ID, new LibSwap.SplitCall[](0)
        );
    }
}
