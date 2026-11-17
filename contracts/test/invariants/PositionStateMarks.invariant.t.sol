// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title PositionStateMarksInvariant
 * @notice #3710 (`PositionSaleStateGuardDesign.md` §3.2): whenever a figure a
 *         loan's position tokens render got worse for a holder, both tokens'
 *         state numbers went up in the same call. Worse means the loan's
 *         collateral fell (worse for the borrower token's buyer) or its rate
 *         changed (worse for one side whichever way it moved).
 *
 *         It does not depend on anyone listing the routes: the handler drives
 *         whatever entries it drives, and every call is checked after it runs.
 *         State numbers only rise, so the last observation is enough.
 */
contract PositionStateMarksInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    struct Seen {
        bool latched;
        uint256 collateral;
        uint256 rateBps;
        uint256 lenderState;
        uint256 borrowerState;
    }

    mapping(uint256 => Seen) internal seen;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    function invariant_WorseRenderedFigureMovesTheStateNumber() public {
        uint256 n = handler.loanIdsLength();
        address d = address(base.diamond());
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = LoanFacet(d).getLoanDetails(loanId);
            (uint256 ls,,) = VaipakamNFTFacet(d).positionState(L.lenderTokenId);
            (uint256 bs,,) = VaipakamNFTFacet(d).positionState(L.borrowerTokenId);
            Seen storage s = seen[loanId];
            if (s.latched) {
                assertGe(ls, s.lenderState, "a lender token's state number fell");
                assertGe(bs, s.borrowerState, "a borrower token's state number fell");
                bool worse = L.collateralAmount < s.collateral || L.interestRateBps != s.rateBps;
                if (worse) {
                    assertGt(ls, s.lenderState, "a worse figure without a lender-token mark");
                    assertGt(bs, s.borrowerState, "a worse figure without a borrower-token mark");
                }
            }
            s.latched = true;
            s.collateral = L.collateralAmount;
            s.rateBps = L.interestRateBps;
            s.lenderState = ls;
            s.borrowerState = bs;
        }
    }
}
