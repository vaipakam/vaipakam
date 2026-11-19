// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test, console2} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {AuthorityHandler} from "./AuthorityHandler.sol";

/**
 * @title AuthorityChainInvariant
 * @notice #3568: the authority chain across ordinary loan activity. The
 *         handler interleaves loans (offers, accepts, repayments, defaults,
 *         claims) with account replacement, operator approvals, recovery of
 *         retired positions and each side's own per-loan settings, and checks
 *         after every step that:
 *
 *         1. a retired key never receives value, directly or through a
 *            position it used to hold;
 *         2. a position held by an account when it was retired is only ever
 *            held by that account's replacement (or still by the retired
 *            account, waiting for recovery) — never moved by the old key,
 *            an operator it approved, or anyone it approves afterwards;
 *         3. a side's per-loan extend and refinance caps change only when
 *            that side's current manager writes them.
 *
 *         The per-loan keeper setting is tracked too ({keeperViolation}), but
 *         reported rather than asserted: today it is one value both sides
 *         write, the gap the #3353 mandate work closes. The assertion moves
 *         into this suite when that lands.
 */
contract AuthorityChainInvariant is Test {
    InvariantBase internal base;
    AuthorityHandler internal handler;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new AuthorityHandler(base);
        targetContract(address(handler));
    }

    /// @notice A retired key's wallet never gains USDC or WETH.
    function invariant_RetiredKeyReceivesNothing() public view {
        assertEq(handler.valueViolation(), "", handler.valueViolation());
    }

    /// @notice A retired account's positions stay with it or its replacement.
    function invariant_RetiredPositionsStayInTheAccount() public view {
        assertEq(handler.positionViolation(), "", handler.positionViolation());
    }

    /// @notice Only a side's own manager changes that side's per-loan caps.
    function invariant_PerLoanCapsBelongToTheirSide() public view {
        assertEq(handler.capViolation(), "", handler.capViolation());
    }

    /// @notice Coverage and the known #3353 gap, logged once per run.
    function afterInvariant() public view {
        console2.log("retired keys", handler.retiredKeysLength());
        console2.log("retire calls", handler.callCount("retire"));
        console2.log("old-key moves", handler.callCount("oldKeyMovesPosition"));
        console2.log("recoveries", handler.callCount("recover"));
        console2.log("cap writes", handler.callCount("sideSetsExtendCaps") + handler.callCount("borrowerSetsRefinanceCaps"));
        console2.log("counterparty cap attempts", handler.callCount("counterpartySetsCaps"));
        if (bytes(handler.keeperViolation()).length != 0) {
            console2.log("KNOWN GAP (#3353):", handler.keeperViolation());
        }
    }
}
