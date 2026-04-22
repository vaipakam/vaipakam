// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title SelfDealingPreventionInvariant
 * @notice No wallet is ever simultaneously the lender and borrower on the
 *         same loan. A self-deal collapses the risk transfer the protocol
 *         is built to provide: the "lender" and "borrower" sides of the
 *         same ledger entry cancel out, the collateral round-trips through
 *         their own escrow, and protocol fees become a tax the caller pays
 *         on nothing. Worse, a self-deal combined with a time-based
 *         default path lets the caller extract a liquidation bonus funded
 *         by the treasury without ever taking real price risk.
 *
 *         The flow layer blocks this at offer-accept time (each facet
 *         enforces caller != creator before minting a loan), so this
 *         invariant is a regression guard: if a future refactor removed
 *         the check, the fuzzer's three-lender / three-borrower actor set
 *         won't naturally produce a self-deal on its own, but any loan
 *         that appears with lender == borrower is a direct flow-layer bug.
 */
contract SelfDealingPreventionInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    function invariant_LenderNotBorrower() public view {
        uint256 n = handler.loanIdsLength();
        LoanFacet loans = LoanFacet(address(base.diamond()));
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = loans.getLoanDetails(loanId);
            assertTrue(
                L.lender != L.borrower,
                "self-deal: lender and borrower are the same address"
            );
            assertTrue(L.lender != address(0), "loan has a zero lender");
            assertTrue(L.borrower != address(0), "loan has a zero borrower");
        }
    }
}
