// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOwedAtInternalMatch} from "../src/libraries/LibOwedAtInternalMatch.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title  InternalMatchOwedRecordTest
 * @notice #2427 — what internal matching cleared from a loan it closed, as
 *         `ClaimFacet.getOwedAtInternalMatch` reports it. Every expected figure
 *         is computed here from the loan's terms and the step timestamps, not
 *         read back from the contract, so a wrong accumulation fails.
 */
contract InternalMatchOwedRecordTest is SetupTest {
    uint256 internal constant LOAN_A = 6001;
    uint256 internal constant LOAN_B = 6002;
    uint256 internal constant LOAN_C = 6003;
    uint256 internal constant RATE_BPS = 1_200; // 12% APR
    uint256 internal constant DURATION_DAYS = 90;
    uint256 internal constant T0 = 1_000_000;

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
        vm.warp(T0);
    }

    // ── fixtures ─────────────────────────────────────────────────────────

    /// @dev A liquidatable Active ERC-20 loan started at `T0` at `RATE_BPS`
    ///      for `DURATION_DAYS`, its collateral funded in the borrower vault.
    function _seed(
        uint256 id,
        address lender_,
        address borrower_,
        address principalAsset,
        uint256 principal,
        address collateralAsset,
        uint256 collateral
    ) internal {
        LibVaipakam.Loan memory l;
        l.id = id;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = principalAsset;
        l.principal = principal;
        l.collateralAsset = collateralAsset;
        l.collateralAmount = collateral;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        l.interestRateBps = RATE_BPS;
        l.startTime = uint64(T0);
        l.durationDays = DURATION_DAYS;
        l.borrowerTokenId = id * 2;
        l.lenderTokenId = id * 2 + 1;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(id, l);
        vm.mockCall(address(diamond), abi.encodeWithSelector(IERC721.ownerOf.selector, id * 2), abi.encode(borrower_));
        vm.mockCall(address(diamond), abi.encodeWithSelector(IERC721.ownerOf.selector, id * 2 + 1), abi.encode(lender_));
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower_);
        ERC20Mock(collateralAsset).mint(bVault, collateral);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower_, collateralAsset, collateral);
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector, id), abi.encode(9_000));
    }

    function _match(uint256 a, uint256 b, uint256 c) internal {
        vm.prank(matcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(a, b, c);
    }

    /// @dev Accrued interest on `principal` from `T0` to now, at `RATE_BPS`.
    function _interest(uint256 principal) internal view returns (uint256) {
        return (principal * RATE_BPS * (block.timestamp - T0)) / (365 days * 10_000);
    }

    struct Rec {
        uint256 principal;
        uint256 interest;
        uint256 lateFee;
        uint256 lenderProceeds;
        uint64 recordedAt;
        bool incomplete;
    }

    function _rec(uint256 loanId) internal view returns (Rec memory r) {
        (r.principal, r.interest, r.lateFee, r.lenderProceeds, r.recordedAt, r.incomplete) =
            ClaimFacet(address(diamond)).getOwedAtInternalMatch(loanId);
    }

    function _assertNone(uint256 loanId, string memory why) internal view {
        Rec memory r = _rec(loanId);
        assertEq(r.recordedAt, 0, why);
        assertEq(r.principal + r.interest + r.lateFee + r.lenderProceeds, 0, why);
        assertFalse(r.incomplete, why);
    }

    function _assertIncomplete(uint256 loanId, string memory why) internal view {
        Rec memory r = _rec(loanId);
        assertTrue(r.incomplete, why);
        assertEq(r.recordedAt, 0, why);
        assertEq(r.principal + r.interest + r.lateFee + r.lenderProceeds, 0, why);
    }

    // ── one-step close ───────────────────────────────────────────────────

    /// @notice A loan closed by one step records its principal, the interest
    ///         accrued on it (never charged), no late fee inside the term, and
    ///         the lender's proceeds net of the 1% matcher incentive.
    function test_oneStepClose_recordsDebtAndProceeds() public {
        _seed(LOAN_A, lender, borrower, mockERC20, 1_000e18, mockCollateralERC20, 1_000e18);
        _seed(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1_000e18, mockERC20, 1_000e18);
        vm.warp(T0 + 30 days);
        uint256 expInterest = _interest(1_000e18);
        assertGt(expInterest, 0);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibOwedAtInternalMatch.OwedAtInternalMatchRecorded(
            LOAN_A, mockERC20, 1_000e18, expInterest, 0, 990e18
        );
        _match(LOAN_A, LOAN_B, 0);

        Rec memory r = _rec(LOAN_A);
        assertEq(r.principal, 1_000e18, "principal cleared");
        assertEq(r.interest, expInterest, "interest on it, never charged");
        assertEq(r.lateFee, 0, "inside the term");
        assertEq(r.lenderProceeds, 990e18, "moved less 1% incentive");
        assertEq(r.recordedAt, uint64(block.timestamp), "stamped at the closing step");
        assertFalse(r.incomplete);
        // The counterparty closed in the same call gets its own record.
        assertEq(_rec(LOAN_B).principal, 1_000e18, "B recorded too");
        // The default record does not report an internally matched loan.
        (, , , uint64 defaultAt,) = ClaimFacet(address(diamond)).getOwedAtDefault(LOAN_A);
        assertEq(defaultAt, 0, "no default record");
    }

    /// @notice Past the term, the step's late fee on the cleared principal is
    ///         recorded: 1% + 0.5%/day past due, capped at 5%.
    function test_pastDue_recordsLateFee() public {
        _seed(LOAN_A, lender, borrower, mockERC20, 1_000e18, mockCollateralERC20, 1_000e18);
        _seed(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1_000e18, mockERC20, 1_000e18);
        vm.warp(T0 + DURATION_DAYS * 1 days + 3 days + 1);
        _match(LOAN_A, LOAN_B, 0);
        // 3 whole days late → 100 + 3 × 50 = 250 bps.
        assertEq(_rec(LOAN_A).lateFee, (1_000e18 * 250) / 10_000, "late fee on cleared principal");
    }

    /// @notice Interest already settled (a partial repayment) is netted, on
    ///         the same basis the default record uses.
    function test_settledInterest_isNetted() public {
        _seed(LOAN_A, lender, borrower, mockERC20, 1_000e18, mockCollateralERC20, 1_000e18);
        _seed(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1_000e18, mockERC20, 1_000e18);
        vm.warp(T0 + 60 days);
        uint256 gross = _interest(1_000e18);
        LibVaipakam.Loan memory l = _loanRaw(LOAN_A);
        l.interestSettled = gross / 4;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_A, l);
        _match(LOAN_A, LOAN_B, 0);
        assertEq(_rec(LOAN_A).interest, gross - gross / 4, "net of settled interest");
    }

    // ── several steps ────────────────────────────────────────────────────

    /// @notice A partial step leaves the loan Active and reports nothing; the
    ///         closing step reports the SUM of both steps — each priced at its
    ///         own timestamp on the principal it moved.
    function test_twoSteps_sumEachStepAtItsOwnTime() public {
        _seed(LOAN_A, lender, borrower, mockERC20, 1_000e18, mockCollateralERC20, 1_000e18);
        _seed(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 600e18, mockERC20, 600e18);

        vm.warp(T0 + 20 days);
        uint256 step1Interest = _interest(1_000e18) - _interest(400e18);
        _match(LOAN_A, LOAN_B, 0);
        assertEq(uint8(_loanRaw(LOAN_A).status), uint8(LibVaipakam.LoanStatus.Active), "A partial");
        _assertNone(LOAN_A, "partial step: still Active, not reported");

        address borrowerC = makeAddr("borrowerC");
        address lenderC = makeAddr("lenderC");
        _seed(LOAN_C, lenderC, borrowerC, mockCollateralERC20, 400e18, mockERC20, 400e18);
        vm.warp(T0 + DURATION_DAYS * 1 days + 1 days + 1); // 1 whole day late → 150 bps
        uint256 step2Interest = _interest(400e18);
        _match(LOAN_A, LOAN_C, 0);

        Rec memory r = _rec(LOAN_A);
        assertEq(r.principal, 1_000e18, "both steps' principal");
        assertEq(r.interest, step1Interest + step2Interest, "each step at its own time");
        assertEq(r.lateFee, (400e18 * 150) / 10_000, "late fee only on the step taken past due");
        assertEq(r.lenderProceeds, 594e18 + 396e18, "both steps' proceeds");
        assertEq(r.recordedAt, uint64(block.timestamp));
    }

    /// @notice A three-way cycle records each closed loan on its own leg.
    function test_threeWay_eachLoanRecorded() public {
        address mockY = address(new ERC20Mock("ChainY", "CY", 18));
        _seed(LOAN_A, lender, borrower, mockERC20, 1_000e18, mockY, 1_000e18);
        _seed(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 2_000e18, mockERC20, 2_000e18);
        _seed(LOAN_C, lender, borrowerB, mockY, 3_000e18, mockCollateralERC20, 3_000e18);
        vm.warp(T0 + 10 days);
        // Legs: X = min(A.p 1000, B.c 2000) = 1000; Y = min(B.p 2000, C.c 3000)
        // = 2000; Z = min(C.p 3000, A.c 1000) = 1000 → C stays open.
        _match(LOAN_A, LOAN_B, LOAN_C);
        assertEq(_rec(LOAN_A).principal, 1_000e18, "A");
        assertEq(_rec(LOAN_A).lenderProceeds, 990e18, "A proceeds");
        assertEq(_rec(LOAN_B).principal, 2_000e18, "B");
        assertEq(_rec(LOAN_B).interest, _interest(2_000e18), "B interest");
        _assertNone(LOAN_C, "C partially matched, still Active");
    }

    // ── not whole → incomplete ───────────────────────────────────────────

    /// @notice A loan matched out of the fallback reports `incomplete` with no
    ///         figures; its Active counterparty is recorded normally.
    function test_fallbackStep_reportsIncomplete() public {
        _seed(LOAN_A, lender, borrower, mockERC20, 1_000e18, mockCollateralERC20, 1_000e18);
        _seed(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1_000e18, mockERC20, 1_000e18);
        _toFallback(LOAN_A, borrower, mockCollateralERC20, 1_000e18);
        _match(LOAN_A, LOAN_B, 0);
        assertEq(uint8(_loanRaw(LOAN_A).status), uint8(LibVaipakam.LoanStatus.InternalMatched));
        _assertIncomplete(LOAN_A, "matched out of the fallback");
        assertEq(_rec(LOAN_B).principal, 1_000e18, "Active counterparty recorded");
    }

    /// @notice Lender proceeds already held when the first step runs (a step
    ///         before the record existed, or a preclose) make the sum partial:
    ///         reported `incomplete`. Proceeds held from this record's OWN
    ///         earlier step do not.
    function test_priorHeldProceeds_reportsIncomplete() public {
        _seed(LOAN_A, lender, borrower, mockERC20, 1_000e18, mockCollateralERC20, 1_000e18);
        _seed(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1_000e18, mockERC20, 1_000e18);
        TestMutatorFacet(address(diamond)).setHeldForLenderRaw(LOAN_A, 1);
        _match(LOAN_A, LOAN_B, 0);
        _assertIncomplete(LOAN_A, "lender paid in part before the record saw the loan");
        assertEq(_rec(LOAN_B).principal, 1_000e18, "B unaffected");
    }

    // ── reporting window ─────────────────────────────────────────────────

    /// @notice Once the lender claims, the loan leaves `InternalMatched` and
    ///         the record is no longer reported.
    function test_notReportedOutsideInternalMatched() public {
        _seed(LOAN_A, lender, borrower, mockERC20, 1_000e18, mockCollateralERC20, 1_000e18);
        _seed(LOAN_B, lenderB, borrowerB, mockCollateralERC20, 1_000e18, mockERC20, 1_000e18);
        _assertNone(LOAN_A, "Active, never matched");
        _match(LOAN_A, LOAN_B, 0);
        assertGt(_rec(LOAN_A).recordedAt, 0);
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            LOAN_A, LibVaipakam.LoanStatus.InternalMatched, LibVaipakam.LoanStatus.Settled
        );
        _assertNone(LOAN_A, "settled");
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _loanRaw(uint256 loanId) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId);
    }

    /// @dev Move an Active seeded loan into FallbackPending the way
    ///      `InternalMatchExecutionTest._moveToFallbackPending` does: the
    ///      collateral sits in the Diamond under an active snapshot.
    function _toFallback(uint256 loanId, address borrower_, address collateral, uint256 amt) internal {
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower_);
        vm.prank(bVault);
        ERC20Mock(collateral).transfer(address(diamond), amt);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower_, collateral, 0);
        LibVaipakam.FallbackSnapshot memory snap = LibVaipakam.FallbackSnapshot({
            lenderCollateral: (amt * 85) / 100,
            treasuryCollateral: (amt * 2) / 100,
            borrowerCollateral: amt - (amt * 85) / 100 - (amt * 2) / 100,
            lenderPrincipalDue: (amt * 85) / 100,
            treasuryPrincipalDue: (amt * 2) / 100,
            active: true,
            retryAttempted: false
        });
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(loanId, snap);
        TestMutatorFacet(address(diamond)).scaffoldLoanStatusChange(
            loanId, LibVaipakam.LoanStatus.Active, LibVaipakam.LoanStatus.FallbackPending
        );
    }
}
