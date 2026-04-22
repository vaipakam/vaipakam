// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {Handler} from "./Handler.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/**
 * @title InterestMonotonicityInvariant
 * @notice For every Active loan, `calculateRepaymentAmount` must be a
 *         non-decreasing function of `block.timestamp` — advancing the
 *         clock without any intervening state change should never reduce
 *         what the borrower owes.
 *
 *         This catches regressions in:
 *           - pro-rata interest accrual (elapsedDays arithmetic)
 *           - full-term interest gating
 *           - late-fee schedule (grace-period tier transitions)
 *           - NFT rental late-fee path (lateFee add only)
 *
 *         The probe is purely additive: we snapshot block.timestamp, query
 *         the amount-due, warp forward by a day, query again, and restore.
 *         Protocol state is unchanged across the observation so any drop
 *         in the second reading points at a math bug, not a legitimate
 *         write (e.g. partial repayment, claim).
 *
 *         NFT loans have `totalDue = 0 + lateFee` pre-maturity, so this
 *         invariant is strongest on ERC-20 principal — which matches the
 *         Handler's fuzz surface (ERC-20 only).
 */
contract InterestMonotonicityInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    uint256 internal constant WARP_PROBE = 1 days;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    function invariant_AmountDueNeverDecreasesWithTime() public {
        RepayFacet repay = RepayFacet(address(base.diamond()));
        LoanFacet loanView = LoanFacet(address(base.diamond()));
        uint256 n = handler.loanIdsLength();
        uint256 savedTs = block.timestamp;

        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = loanView.getLoanDetails(loanId);
            if (L.status != LibVaipakam.LoanStatus.Active) continue;

            uint256 dueNow = repay.calculateRepaymentAmount(loanId);
            vm.warp(savedTs + WARP_PROBE);
            uint256 dueLater = repay.calculateRepaymentAmount(loanId);
            vm.warp(savedTs); // restore so subsequent iterations + fuzz runs are unaffected

            assertGe(
                dueLater,
                dueNow,
                "amount due decreased as time advanced"
            );
        }
    }
}
