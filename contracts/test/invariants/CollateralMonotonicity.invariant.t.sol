// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title CollateralMonotonicityInvariant
 * @notice While a loan is Active, its `collateralAmount` can only grow —
 *         `addCollateral` tops it up, and nothing else mutates it until
 *         the loan transitions out of Active (where repay / default /
 *         settlement flows redirect the collateral and may zero the
 *         field as accounting cleanup).
 *
 *         A silent decrease while Active would mean the protocol shaved
 *         collateral off an open position — either the book said "less
 *         locked up" than actually was (accounting desync) or actually
 *         released collateral to someone without marking the loan
 *         resolved (a straight drain). Either is an audit-grade bug.
 *
 *         We cache the first observed collateralAmount per loan and
 *         assert current >= cached as long as the loan remains Active.
 *         Once it leaves Active, we stop tracking that loan — terminal
 *         transitions are allowed to zero the field.
 */
contract CollateralMonotonicityInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    // First-observed collateral for each loan. Locked on first Active
    // observation; we then require every subsequent Active observation to
    // be at least this much.
    mapping(uint256 => uint256) internal firstActiveCollateral;
    mapping(uint256 => bool) internal latched;
    // Once a loan exits Active, we freeze tracking (further decreases are
    // legal — they represent collateral being paid out).
    mapping(uint256 => bool) internal released;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    function invariant_ActiveCollateralNonDecreasing() public {
        uint256 n = handler.loanIdsLength();
        LoanFacet loans = LoanFacet(address(base.diamond()));

        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = loans.getLoanDetails(loanId);

            if (released[loanId]) continue;

            if (L.status != LibVaipakam.LoanStatus.Active) {
                // Exited Active — stop tracking. Collateral may now legally
                // zero out through settlement/default/repay flows.
                released[loanId] = true;
                continue;
            }

            if (!latched[loanId]) {
                firstActiveCollateral[loanId] = L.collateralAmount;
                latched[loanId] = true;
                continue;
            }

            assertGe(
                L.collateralAmount,
                firstActiveCollateral[loanId],
                "collateralAmount decreased while loan Active"
            );
        }
    }
}
