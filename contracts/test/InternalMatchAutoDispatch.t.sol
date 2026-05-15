// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title InternalMatchAutoDispatch.t.sol
 * @notice EC-003 Phase 3 — exercises the new
 *         `attemptInternalMatchAutoDispatch` helper directly + via
 *         the cross-facet dispatch path. End-to-end auto-dispatch
 *         from `triggerLiquidation` / `triggerDefault` /
 *         `claimAsLenderWithRetry` requires a heavier integration
 *         setup (HF mocks + sequencer + KYC + liquidity classifier);
 *         that broader coverage lives in the scenario suite.
 */
contract InternalMatchAutoDispatchTest is SetupTest {
    uint256 internal constant LOAN_A = 9001;
    uint256 internal constant LOAN_B = 9002;
    address internal matcher;
    address internal borrowerB;
    address internal lenderB;

    function setUp() public {
        setupHelper();
        matcher = makeAddr("matcher");
        borrowerB = makeAddr("borrowerB");
        lenderB = makeAddr("lenderB");

        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
    }

    function _seedLoan(
        uint256 id,
        address lender_,
        address borrower_,
        address principal,
        uint256 principalAmt,
        address collateral,
        uint256 collateralAmt
    ) internal {
        LibVaipakam.Loan memory l;
        l.id = id;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = principal;
        l.principal = principalAmt;
        l.collateralAsset = collateral;
        l.collateralAmount = collateralAmt;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(id, l);

        address bEscrow = EscrowFactoryFacet(address(diamond))
            .getOrCreateUserEscrow(borrower_);
        ERC20Mock(collateral).mint(bEscrow, collateralAmt);
        TestMutatorFacet(address(diamond)).setProtocolTrackedEscrowBalanceRaw(
            borrower_, collateral, collateralAmt
        );
    }

    function _mockLtv(uint256 loanId, uint256 ltv) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId),
            abi.encode(ltv)
        );
    }

    // ─── onlyDiamondInternal coverage ───────────────────────────────

    function test_attemptAutoDispatch_eoa_reverts() public {
        // Direct EOA call to the external function should hit
        // `onlyDiamondInternal` and revert.
        vm.expectRevert(RiskFacet.OnlyDiamondInternal.selector);
        RiskFacet(address(diamond)).attemptInternalMatchAutoDispatch(LOAN_A);
    }

    // ─── No-candidate fall-through (returns false) ──────────────────

    function test_attemptAutoDispatch_killSwitchOff_returnsFalse() public {
        // Disable internal-match → auto-dispatch is inert.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(false);

        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);

        // Invoke via cross-facet pattern — pretend Diamond is calling us.
        vm.prank(address(diamond));
        bool dispatched = RiskFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A);
        assertFalse(dispatched);
    }

    function test_attemptAutoDispatch_noOpposingCandidate_returnsFalse() public {
        // Only one loan in the asset pair; no opposing-direction counterparty.
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);

        vm.prank(address(diamond));
        bool dispatched = RiskFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A);
        assertFalse(dispatched);
    }

    // ─── Happy path: auto-dispatch fires + settles ──────────────────

    function test_attemptAutoDispatch_validCandidate_settlesAndReturnsTrue() public {
        // Two opposing-direction Active loans, both liquidatable. The
        // helper should match them, transition both to InternalMatched,
        // and pay the 1% matcher bonus to `msg.sender`.
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        // LTV mocks — both legs need LTV >= floor (8500) to pass the
        // view's gate AND _executeTwoWayMatch's per-leg LTV check.
        _mockLtv(LOAN_A, 9_000);
        _mockLtv(LOAN_B, 9_000);

        address aLenderEscrow = EscrowFactoryFacet(address(diamond))
            .getOrCreateUserEscrow(lender);
        address bLenderEscrow = EscrowFactoryFacet(address(diamond))
            .getOrCreateUserEscrow(lenderB);

        uint256 aLenderXBefore = IERC20(mockERC20).balanceOf(aLenderEscrow);
        uint256 bLenderYBefore = IERC20(mockCollateralERC20).balanceOf(bLenderEscrow);

        // Cross-facet pattern — simulate `matcher` calling Diamond,
        // which delegates to RiskFacet's gated entry. `msg.sender` of
        // the inner call is the Diamond, satisfying onlyDiamondInternal.
        vm.prank(address(diamond));
        bool dispatched = RiskFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A);
        assertTrue(dispatched);

        LibVaipakam.Loan memory aAfter = LoanFacet(address(diamond)).getLoanDetails(LOAN_A);
        LibVaipakam.Loan memory bAfter = LoanFacet(address(diamond)).getLoanDetails(LOAN_B);
        assertEq(uint8(aAfter.status), uint8(LibVaipakam.LoanStatus.InternalMatched));
        assertEq(uint8(bAfter.status), uint8(LibVaipakam.LoanStatus.InternalMatched));
        assertEq(aAfter.principal, 0);
        assertEq(bAfter.principal, 0);

        // Lender payouts: 990 each leg (1000 - 1% matcher fee).
        assertEq(IERC20(mockERC20).balanceOf(aLenderEscrow) - aLenderXBefore, 990);
        assertEq(IERC20(mockCollateralERC20).balanceOf(bLenderEscrow) - bLenderYBefore, 990);
        // Matcher bonus paid to msg.sender — which inside the
        // delegatecall context is `address(diamond)`.
        assertEq(IERC20(mockERC20).balanceOf(address(diamond)), 10);
        assertEq(IERC20(mockCollateralERC20).balanceOf(address(diamond)), 10);
    }

    // ─── LTV-floor gate on Active candidates ────────────────────────

    function test_attemptAutoDispatch_candidateBelowLtvFloor_returnsFalse() public {
        // Loan B exists in the opposing pair but its LTV is BELOW the
        // floor (healthy loan). The view's LTV-floor gate should skip
        // it; auto-dispatch falls through with no match.
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        // A is liquidatable; B is healthy (LTV 5000 < floor 8500).
        _mockLtv(LOAN_A, 9_000);
        _mockLtv(LOAN_B, 5_000);

        vm.prank(address(diamond));
        bool dispatched = RiskFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A);
        assertFalse(dispatched, "healthy candidate must not be force-liquidated");
    }

    // ─── Caller-side terminal short-circuit ─────────────────────────

    function test_attemptAutoDispatch_callerNotMatchable_returnsFalse() public {
        // The caller-loan is in a terminal status — auto-dispatch returns
        // false without trying to settle.
        _seedLoan(LOAN_A, lender, borrower, mockERC20, 1000, mockCollateralERC20, 1000);
        _seedLoan(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1000, mockERC20, 1000);
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            LOAN_A,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );

        vm.prank(address(diamond));
        bool dispatched = RiskFacet(address(diamond))
            .attemptInternalMatchAutoDispatch(LOAN_A);
        assertFalse(dispatched);
    }
}
