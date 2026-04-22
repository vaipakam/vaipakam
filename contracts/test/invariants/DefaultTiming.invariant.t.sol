// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {Handler} from "./Handler.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/**
 * @title DefaultTimingInvariant
 * @notice Every loan that ended up in the `Defaulted` state must have been
 *         driven there AFTER its duration + grace-period window elapsed.
 *         DefaultedFacet.triggerDefault is the only path to that status, and
 *         it gates on `startTime + duration*1d + grace <= block.timestamp`.
 *         If an invariant fuzz sequence ever surfaces a Defaulted loan that
 *         skipped that gate, the gate is broken — a major audit finding
 *         (protocol could seize collateral from borrowers still in grace).
 *
 *         Complements LoanStatusMonotonicity (direction-only) with a timing
 *         constraint on the specific forward transition to Defaulted.
 */
contract DefaultTimingInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    /// @notice For every loan the handler has ever opened, if status is
    ///         Defaulted then now >= startTime + duration + grace.
    function invariant_DefaultRespectsGracePeriod() public view {
        uint256 n = handler.loanIdsLength();
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L =
                LoanFacet(address(base.diamond())).getLoanDetails(loanId);

            if (L.status != LibVaipakam.LoanStatus.Defaulted) continue;

            uint256 grace = LibVaipakam.gracePeriod(L.durationDays);
            uint256 earliest = L.startTime + L.durationDays * 1 days + grace;
            assertGe(
                block.timestamp,
                earliest,
                "loan defaulted before grace period end"
            );
        }
    }
}
