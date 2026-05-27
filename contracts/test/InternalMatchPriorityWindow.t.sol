// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SetupComposable} from "./composable/SetupComposable.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
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
contract InternalMatchPriorityWindowTest is Test {

    // ── Stage 6 composition migration (2026-05-27) ──────────────────────
    // Inherit only forge-std `Test`; the Diamond + facet routing + state
    // are owned by a `SetupComposable` instance the test composes via
    // `setUp`. Common SetupTest fields are mirrored locally below so the
    // bulk of test-body code keeps compiling unchanged.
    SetupComposable internal helpers;
    VaipakamDiamond internal diamond;
    address internal owner;
    address internal lender;
    address internal borrower;
    address internal mockERC20;
    address internal mockCollateralERC20;
    address internal mockIlliquidERC20;
    address internal mockNft721;
    address internal mockZeroExProxy;
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 internal constant RENTAL_BUFFER_BPS = 500;
    uint256 internal constant MIN_HEALTH_FACTOR = 150 * 1e16;
    uint256 internal constant LOAN_ID = 4711;

    function setUp() public {
        helpers = new SetupComposable();
        helpers.bootstrap(address(this));
        diamond = helpers.diamond();
        owner = helpers.owner();
        lender = helpers.lender();
        borrower = helpers.borrower();
        mockERC20 = helpers.mockERC20();
        mockCollateralERC20 = helpers.mockCollateralERC20();
        mockIlliquidERC20 = helpers.mockIlliquidERC20();
        mockNft721 = helpers.mockNft721();
        mockZeroExProxy = helpers.mockZeroExProxy();
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
}
