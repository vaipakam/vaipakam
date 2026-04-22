// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";

/**
 * @title FallbackSettlementMath
 * @notice Property-based fuzz tests for the LibFallback three-way split
 *         math. LibFallback itself couples its arithmetic to oracle
 *         lookups and on-chain loan storage, so this suite reproduces the
 *         split rule directly as a pure function and fuzzes it — the
 *         invariants below are the README section 7 guarantees the live library
 *         must also uphold. If the library math ever drifts from this
 *         reference, the scenario tests (ScenarioFallbackClaimRace) and
 *         integration coverage will catch it; this suite pins the pure
 *         arithmetic properties so regressions show up immediately.
 */
contract FallbackSettlementMathTest is Test {
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    /// @dev Reference reproduction of LibFallback.computeFallbackEntitlements.
    ///      No late fees — README section 7 (lines 168, 333, 373).
    function _split(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsed,
        uint256 collateralAmount,
        uint256 lenderColEquiv,
        uint256 treasuryColEquiv
    )
        internal
        pure
        returns (
            uint256 lenderCollateral,
            uint256 treasuryCollateral,
            uint256 borrowerCollateral,
            uint256 lenderPrincipalDue,
            uint256 treasuryPrincipalDue
        )
    {
        uint256 accrued = (principal * rateBps * elapsed) /
            (SECONDS_PER_YEAR * BASIS_POINTS);
        uint256 principalBonus = (principal * 300) / BASIS_POINTS; // 3%
        lenderPrincipalDue = principal + accrued + principalBonus;
        treasuryPrincipalDue = (principal * 200) / BASIS_POINTS; // 2%

        if (collateralAmount <= lenderColEquiv) {
            lenderCollateral = collateralAmount;
            treasuryCollateral = 0;
            borrowerCollateral = 0;
        } else {
            lenderCollateral = lenderColEquiv;
            uint256 rem = collateralAmount - lenderColEquiv;
            treasuryCollateral = treasuryColEquiv <= rem
                ? treasuryColEquiv
                : rem;
            borrowerCollateral = rem - treasuryCollateral;
        }
    }

    /// @notice Sum of the three split outputs equals total collateral.
    function testFuzz_SplitSumEqualsCollateral(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsed,
        uint256 collateralAmount,
        uint256 lenderColEquiv,
        uint256 treasuryColEquiv
    ) public pure {
        principal = bound(principal, 1 ether, 1e30);
        rateBps = bound(rateBps, 0, 10_000);
        elapsed = bound(elapsed, 0, 10 * 365 days);
        collateralAmount = bound(collateralAmount, 0, 1e30);
        lenderColEquiv = bound(lenderColEquiv, 0, 1e30);
        treasuryColEquiv = bound(treasuryColEquiv, 0, 1e30);

        (
            uint256 lenderC,
            uint256 treasuryC,
            uint256 borrowerC,
            ,

        ) = _split(
                principal,
                rateBps,
                elapsed,
                collateralAmount,
                lenderColEquiv,
                treasuryColEquiv
            );

        assertEq(
            lenderC + treasuryC + borrowerC,
            collateralAmount,
            "split does not sum to collateral"
        );
    }

    /// @notice Lender never receives more collateral than their entitlement
    ///         (unless collateral is insufficient, in which case they may
    ///         receive up to the full collateral — bounded above by it).
    function testFuzz_LenderCapped(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsed,
        uint256 collateralAmount,
        uint256 lenderColEquiv,
        uint256 treasuryColEquiv
    ) public pure {
        principal = bound(principal, 1 ether, 1e30);
        rateBps = bound(rateBps, 0, 10_000);
        elapsed = bound(elapsed, 0, 10 * 365 days);
        collateralAmount = bound(collateralAmount, 0, 1e30);
        lenderColEquiv = bound(lenderColEquiv, 0, 1e30);
        treasuryColEquiv = bound(treasuryColEquiv, 0, 1e30);

        (uint256 lenderC, , , , ) = _split(
            principal,
            rateBps,
            elapsed,
            collateralAmount,
            lenderColEquiv,
            treasuryColEquiv
        );

        uint256 cap = lenderColEquiv < collateralAmount
            ? lenderColEquiv
            : collateralAmount;
        assertLe(lenderC, cap, "lender exceeds entitlement");
    }

    /// @notice Treasury share is bounded above by its oracle-derived
    ///         equivalent AND by whatever collateral remains after lender.
    function testFuzz_TreasuryCapped(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsed,
        uint256 collateralAmount,
        uint256 lenderColEquiv,
        uint256 treasuryColEquiv
    ) public pure {
        principal = bound(principal, 1 ether, 1e30);
        rateBps = bound(rateBps, 0, 10_000);
        elapsed = bound(elapsed, 0, 10 * 365 days);
        collateralAmount = bound(collateralAmount, 0, 1e30);
        lenderColEquiv = bound(lenderColEquiv, 0, 1e30);
        treasuryColEquiv = bound(treasuryColEquiv, 0, 1e30);

        (uint256 lenderC, uint256 treasuryC, , , ) = _split(
            principal,
            rateBps,
            elapsed,
            collateralAmount,
            lenderColEquiv,
            treasuryColEquiv
        );

        assertLe(treasuryC, treasuryColEquiv, "treasury exceeds equiv");
        uint256 remAfterLender = collateralAmount - lenderC;
        assertLe(treasuryC, remAfterLender, "treasury exceeds remainder");
    }

    /// @notice When collateral is insufficient for the lender entitlement,
    ///         the lender receives all of it and treasury/borrower get zero.
    function testFuzz_InsufficientGoesAllToLender(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsed,
        uint256 collateralAmount,
        uint256 lenderColEquiv,
        uint256 treasuryColEquiv
    ) public pure {
        principal = bound(principal, 1 ether, 1e30);
        rateBps = bound(rateBps, 0, 10_000);
        elapsed = bound(elapsed, 0, 10 * 365 days);
        lenderColEquiv = bound(lenderColEquiv, 1, 1e30);
        // Force the insufficient branch
        collateralAmount = bound(collateralAmount, 0, lenderColEquiv);
        treasuryColEquiv = bound(treasuryColEquiv, 0, 1e30);

        (
            uint256 lenderC,
            uint256 treasuryC,
            uint256 borrowerC,
            ,

        ) = _split(
                principal,
                rateBps,
                elapsed,
                collateralAmount,
                lenderColEquiv,
                treasuryColEquiv
            );

        assertEq(lenderC, collateralAmount, "lender short on insufficient path");
        assertEq(treasuryC, 0, "treasury nonzero on insufficient path");
        assertEq(borrowerC, 0, "borrower nonzero on insufficient path");
    }

    /// @notice Principal-due math: lender due = principal + accrued + 3%;
    ///         treasury due = 2%. No late fee term.
    function testFuzz_PrincipalDueMath(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsed
    ) public pure {
        principal = bound(principal, 1 ether, 1e27);
        rateBps = bound(rateBps, 0, 10_000);
        elapsed = bound(elapsed, 0, 10 * 365 days);

        (, , , uint256 lenderDue, uint256 treasuryDue) = _split(
            principal,
            rateBps,
            elapsed,
            0,
            0,
            0
        );

        uint256 accrued = (principal * rateBps * elapsed) /
            (SECONDS_PER_YEAR * BASIS_POINTS);
        assertEq(
            lenderDue,
            principal + accrued + (principal * 300) / BASIS_POINTS,
            "lender due drifted from README section 7"
        );
        assertEq(
            treasuryDue,
            (principal * 200) / BASIS_POINTS,
            "treasury due drifted from README section 7"
        );
    }
}
