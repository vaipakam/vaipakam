// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/**
 * @title InternalMatchLiquidationGates.t.sol
 * @notice PR4 of the internal-match work — covers every revert
 *         path on `RiskFacet.triggerInternalMatchLiquidation`'s
 *         validation surface. PR4 body is a no-op on success, so
 *         the assertions here are exclusively about gate behaviour:
 *           - kill-switch off,
 *           - loan-status not Active,
 *           - self-pair (A==B, C==A, C==B),
 *           - asset opposition fails (2-loan),
 *           - chain broken (3-loan),
 *           - LTV below the snapshotted liquidation floor,
 *           - sanctioned caller blocked at the Tier-1 gate.
 *
 *         Builds two opposing-direction synthetic loans via the
 *         `TestMutatorFacet.setLoan` scaffold so we control the
 *         loan struct precisely — initiateLoan's HF≥1.5 gate
 *         would otherwise block the at-or-above-liquidation
 *         scenarios these tests need.
 */
contract InternalMatchLiquidationGatesTest is SetupTest {
    uint256 internal constant LOAN_A = 1001;
    uint256 internal constant LOAN_B = 1002;
    uint256 internal constant LOAN_C = 1003;

    address internal otherAsset;

    function setUp() public {
        setupHelper();

        // Spin up a third liquid ERC20 to round out 3-way chain
        // tests (A's principal == B's collateral, B's principal ==
        // C's collateral, C's principal == A's collateral).
        otherAsset = address(0xCAFE);

        // Enable the internal-match kill-switch — gates we're
        // testing all assume it's on. The `_killSwitchOff` test
        // toggles it back manually.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);

        _writeLoan(LOAN_A, lender, borrower, mockERC20, mockCollateralERC20);
        _writeLoan(LOAN_B, lender, borrower, mockCollateralERC20, mockERC20);
        _writeLoan(LOAN_C, lender, borrower, otherAsset, mockERC20);
    }

    function _writeLoan(
        uint256 id,
        address lender_,
        address borrower_,
        address principal,
        address collateral
    ) internal {
        LibVaipakam.Loan memory l;
        l.id = id;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = principal;
        l.collateralAsset = collateral;
        l.principal = 1000;
        l.collateralAmount = 1500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        // Floor at 8500 BPS — matches the Tier-pin pattern used
        // across the rest of the suite, so HF math behaves
        // consistently with the existing scenarios.
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).setLoan(id, l);
    }

    function test_killSwitchOff_reverts() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(false);
        vm.expectRevert(RiskMatchLiquidationFacet.InternalMatchDisabled.selector);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);
    }

    function test_selfPair_AequalsB_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(RiskMatchLiquidationFacet.InternalMatchSelfPair.selector, LOAN_A)
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_A, 0);
    }

    function test_selfPair_CequalsA_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(RiskMatchLiquidationFacet.InternalMatchSelfPair.selector, LOAN_A)
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, LOAN_A);
    }

    function test_selfPair_CequalsB_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(RiskMatchLiquidationFacet.InternalMatchSelfPair.selector, LOAN_B)
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, LOAN_B);
    }

    function test_loanANotActive_reverts() public {
        // Flip A to Repaid.
        LibVaipakam.Loan memory l;
        l.id = LOAN_A;
        l.status = LibVaipakam.LoanStatus.Repaid;
        l.lender = lender;
        l.borrower = borrower;
        l.principalAsset = mockERC20;
        l.collateralAsset = mockCollateralERC20;
        l.principal = 1000;
        l.collateralAmount = 1500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_A, l);

        vm.expectRevert(
            abi.encodeWithSelector(RiskMatchLiquidationFacet.InternalMatchLoanNotMatchable.selector, LOAN_A)
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);
    }

    function test_loanBNotActive_reverts() public {
        LibVaipakam.Loan memory l;
        l.id = LOAN_B;
        l.status = LibVaipakam.LoanStatus.Settled;
        l.lender = lender;
        l.borrower = borrower;
        l.principalAsset = mockCollateralERC20;
        l.collateralAsset = mockERC20;
        l.principal = 1000;
        l.collateralAmount = 1500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_B, l);

        vm.expectRevert(
            abi.encodeWithSelector(RiskMatchLiquidationFacet.InternalMatchLoanNotMatchable.selector, LOAN_B)
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);
    }

    function test_loanCNotActive_reverts() public {
        LibVaipakam.Loan memory l;
        l.id = LOAN_C;
        l.status = LibVaipakam.LoanStatus.Defaulted;
        l.lender = lender;
        l.borrower = borrower;
        l.principalAsset = otherAsset;
        l.collateralAsset = mockERC20;
        l.principal = 1000;
        l.collateralAmount = 1500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_C, l);

        vm.expectRevert(
            abi.encodeWithSelector(RiskMatchLiquidationFacet.InternalMatchLoanNotMatchable.selector, LOAN_C)
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, LOAN_C);
    }

    function test_assetMismatch_reverts() public {
        // Rewrite B so its collateral isn't A's principal — breaks
        // the 2-loan symmetric opposition.
        LibVaipakam.Loan memory l;
        l.id = LOAN_B;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender;
        l.borrower = borrower;
        l.principalAsset = mockCollateralERC20;
        l.collateralAsset = otherAsset; // not mockERC20 — mismatch
        l.principal = 1000;
        l.collateralAmount = 1500;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_B, l);

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskMatchLiquidationFacet.InternalMatchAssetMismatch.selector, LOAN_A, LOAN_B
            )
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);
    }

    function test_chainBroken_reverts() public {
        // For a 3-way A→B→C→A cycle we need:
        //   A.principal == B.collateral
        //   B.principal == C.collateral
        //   C.principal == A.collateral
        // Default setUp has C.principal = otherAsset, C.collateral
        // = mockERC20. A.collateral = mockCollateralERC20 ≠
        // C.principal — so the cycle breaks at C→A.
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskMatchLiquidationFacet.InternalMatchChainBroken.selector,
                LOAN_A, LOAN_B, LOAN_C
            )
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, LOAN_C);
    }

    function test_ltvBelowFloor_reverts() public {
        // Bump A's snapshot to 9_500 (95%). The real LTV math
        // computes against the loan's principal/collateral
        // numerals — which produce far below 9_500 by default
        // (1000 principal / 1500 collateral × 1e4 ≈ 6666 BPS).
        // So LTV < floor → revert InternalMatchLtvBelowFloor.
        //
        // The collateral/principal here are mockERC20 + mockCollateralERC20
        // which are mocked Liquid + $1 price in setupHelper, so
        // calculateLTV returns a real value.
        TestMutatorFacet(address(diamond)).setLiquidationLtvBpsAtInitRaw(LOAN_A, 9_500);

        // Mock the oracle prices so calculateLTV computes 6666:
        // borrow 1000 USD / collateral 1500 USD = 0.6666 = 6666 bps.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, LOAN_A),
            abi.encode(uint256(6666))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                RiskMatchLiquidationFacet.InternalMatchLtvBelowFloor.selector,
                LOAN_A,
                uint256(6_666),
                uint256(9_500)
            )
        );
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(LOAN_A, LOAN_B, 0);
    }

    // Note: the `test_validPair_emitsPlaceholderEvent` test that
    //   ran on the PR4 body-less success path was retired in PR5
    //   — the execution body now fires with real notional /
    //   incentive numbers. End-to-end success path coverage
    //   (full match, partial match, atomicity, incentive math) is
    //   in `InternalMatchExecution.t.sol`.
}
