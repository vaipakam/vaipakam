// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {GasSuiteBase} from "./GasSuiteBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../../src/facets/NumeraireConfigFacet.sol";
import {StandingInstructionFacet} from "../../src/facets/StandingInstructionFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  GasSuiteInstructionsTest
 * @notice The gas suite's standing-instruction actions (#3915,
 *         RefactorRulesDesign §5.1): funding a loan reserve, setting the
 *         instructions, and one run of each executor (collateral top-up,
 *         interest payment, repayment at the due date). The loan is the
 *         StandingInstructionTest fixture's: 1,000 principal at 12% with
 *         monthly interest over 90 days, 5,000 collateral.
 *
 * forge-config: default.isolate = true
 */
contract GasSuiteInstructionsTest is GasSuiteBase {
    uint8 internal constant PAYMENT = 0;
    uint8 internal constant COLLATERAL_RESERVE = 1;
    uint256 internal loanId;
    uint256 internal startTs;
    address internal runner;

    function setUp() public {
        _setUpGasSuite();
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        _priceOnGuard(mockERC20, int256(1_000 * 1e8));
        _priceOnGuard(mockCollateralERC20, int256(1_000 * 1e8));
        runner = makeAddr("gasRunner");
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender);
        p.interestRateBps = 1200;
        p.interestRateBpsMax = 1200;
        p.collateralAmount = 5000 ether;
        p.collateralAmountMax = 5000 ether;
        p.durationDays = 90;
        p.allowsPartialRepay = false;
        p.periodicInterestCadence = LibVaipakam.PeriodicInterestCadence.Monthly;
        uint256 offerId = _createOffer(lender, p);
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        startTs = vm.getBlockTimestamp();
    }

    function test_gas_reserve_fund() public {
        _mintApprove(mockERC20, 50 ether);
        _measure(
            "instruction_reserve_fund",
            borrower,
            abi.encodeCall(StandingInstructionFacet.fundLoanReserve, (loanId, PAYMENT, 50 ether))
        );
    }

    function test_gas_instruction_set() public {
        _measure(
            "instruction_set",
            borrower,
            abi.encodeCall(
                StandingInstructionFacet.setStandingInstructions,
                (loanId, StandingInstructionFacet.InstructionInput(1.3e18, 1.6e18, true, false, 0))
            )
        );
    }

    function test_gas_instruction_run_topup() public {
        _fund(COLLATERAL_RESERVE, 3000 ether);
        _set(1.3e18, 1.6e18, false, false, 0);
        // Collateral at 28% of the principal asset's price: the health factor
        // falls from 4.25 to about 1.19, under the 1.3 trigger.
        _priceOnGuard(mockCollateralERC20, int256(280 * 1e8));
        _measure("instruction_run_topup", runner, abi.encodeCall(StandingInstructionFacet.runCollateralTopUp, (loanId)));
    }

    function test_gas_instruction_run_interest() public {
        _fund(PAYMENT, 50 ether);
        _set(0, 0, true, false, 0);
        vm.warp(startTs + 30 days);
        _measure("instruction_run_interest", runner, abi.encodeCall(StandingInstructionFacet.runInterestPayment, (loanId)));
    }

    function test_gas_instruction_run_due_repay() public {
        _set(0, 0, false, true, 1 hours);
        vm.warp(startTs + 90 days - 1 hours);
        _fund(PAYMENT, 1100 ether);
        _measure("instruction_run_due_repay", runner, abi.encodeCall(StandingInstructionFacet.runDueRepayment, (loanId)));
    }

    function _mintApprove(address asset, uint256 amount) internal {
        ERC20Mock(asset).mint(borrower, amount);
        vm.prank(borrower);
        IERC20(asset).approve(address(diamond), amount);
    }

    function _fund(uint8 kind, uint256 amount) internal {
        _mintApprove(kind == PAYMENT ? mockERC20 : mockCollateralERC20, amount);
        vm.prank(borrower);
        StandingInstructionFacet(address(diamond)).fundLoanReserve(loanId, kind, amount);
    }

    function _set(uint64 trigger, uint64 target, bool payInterest, bool repayAtDue, uint32 lead) internal {
        vm.prank(borrower);
        StandingInstructionFacet(address(diamond)).setStandingInstructions(
            loanId, StandingInstructionFacet.InstructionInput(trigger, target, payInterest, repayAtDue, lead)
        );
    }
}
