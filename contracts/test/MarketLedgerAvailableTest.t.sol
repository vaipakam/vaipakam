// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {MarketLedgerBase} from "./MarketLedgerTest.t.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {MarketLedgerFacet} from "../src/facets/MarketLedgerFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {defaultQuote} from "./helpers/ForcedSaleQuote.sol";

/**
 * @title  MarketLedgerAvailableTest
 * @notice #3714 (TermAverageAndLinkGuardsDesign §7) — Available, the sum of
 *         every Auto-lend slot's fillable amount (the lesser of its reserved
 *         capital and its unused exposure, zero below its smallest fill), and
 *         the live-principal invariant it rests on: a slot's live principal is
 *         exactly the outstanding principal of the open loans it holds, so
 *         "how full" = lent from slots / (lent from slots + available).
 */
contract MarketLedgerAvailableTest is MarketLedgerBase {
    // ─── helpers ────────────────────────────────────────────────────────────

    function _available() internal view returns (uint256 a) {
        (, a, , , ) = MarketLedgerFacet(address(diamond)).getMarketLedger(mockERC20);
    }

    function _pairAvailable() internal view returns (uint256 a) {
        (, a, , , ) = MarketLedgerFacet(address(diamond)).getPairLedger(mockERC20, mockCollateralERC20);
    }

    function _slot() internal view returns (uint256 declared, uint256 fillable, uint256 live, uint256 capital) {
        return MarketLedgerFacet(address(diamond)).getSlotLedger(lender, mockERC20, mockCollateralERC20, 0);
    }

    function _open(uint256 loanId) internal view returns (bool) {
        LibVaipakam.LoanStatus st = LoanFacet(address(diamond)).getLoanDetails(loanId).status;
        return st == LibVaipakam.LoanStatus.Active || st == LibVaipakam.LoanStatus.FallbackPending;
    }

    /// @dev The invariant: the slot's live principal equals the outstanding
    ///      principal of the open loans it still holds (`held`), the ledger's
    ///      lent-from-slots figure is that same sum, and how full is at most
    ///      100%.
    function _assertLive(uint256[] memory held, string memory step) internal view {
        uint256 sum;
        for (uint256 i; i < held.length; ++i) {
            if (_open(held[i])) sum += _principal(held[i]);
        }
        (, , uint256 live, ) = _slot();
        assertEq(live, sum, string.concat(step, ": live == outstanding principal of the slot's open loans"));
        assertEq(_fromSlots(), sum, string.concat(step, ": lent from slots == sum of live"));
        uint256 a = _available();
        if (sum + a != 0) assertLe((sum * 1e18) / (sum + a), 1e18, string.concat(step, ": how full <= 100%"));
    }

    function _one(uint256 loanId) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = loanId;
    }

    function _none() internal pure returns (uint256[] memory a) {
        a = new uint256[](0);
    }

    // ─── Available ──────────────────────────────────────────────────────────

    /// @dev Unfunded, funded, then partly lent: Available is the lesser of the
    ///      reserved capital and the unused exposure; Declared stays the limit.
    function test_availableIsCapitalCappedByUnusedExposure() public {
        _set(mockCollateralERC20, 0, 5000 ether, false);
        assertEq(_available(), 0, "no capital, nothing available");
        (uint256 d, ) = _asset();
        assertEq(d, 5000 ether, "declared is the limit lenders set");

        _fund(2000 ether);
        assertEq(_available(), 2000 ether, "capital below the unused exposure");
        assertEq(_pairAvailable(), 2000 ether, "and on the pair");

        uint256 loanId = _fill(_postBorrower(_newBorrower("b-a"), false));
        assertEq(_available(), 1000 ether, "the fill drew its capital");
        _assertLive(_one(loanId), "after fill");
        // how full = 1000 / (1000 + 1000)
        assertEq(_fromSlots() * 1e18 / (_fromSlots() + _available()), 0.5e18, "how full 50%");
    }

    /// @dev 100 declared and 100 lent counts 100: nothing left available, so
    ///      how full is exactly 100%.
    function test_fullyLentSlotCountsItsLentPrincipal() public {
        _set(mockCollateralERC20, 0, PRINCIPAL, false);
        _fund(PRINCIPAL);
        uint256 loanId = _fill(_postBorrower(_newBorrower("b-full"), false));
        (uint256 d, ) = _asset();
        assertEq(d, PRINCIPAL, "declared 100");
        assertEq(_fromSlots(), PRINCIPAL, "lent 100");
        assertEq(_available(), 0, "nothing available");
        assertEq(_fromSlots() * 1e18 / (_fromSlots() + _available()), 1e18, "how full 100%");
        _assertLive(_one(loanId), "fully lent");
    }

    /// @dev 100 declared, 40 lent and an empty vault counts 40: the unused
    ///      exposure has no capital behind it, so how full is 100%, never
    ///      more.
    function test_emptyVaultCountsOnlyTheLentPrincipal() public {
        _set(mockCollateralERC20, 0, 2500 ether, false); // declared 2500
        _fund(PRINCIPAL);
        uint256 loanId = _fill(_postBorrower(_newBorrower("b-empty"), false)); // lent 1000
        (, , , uint256 capital) = _slot();
        assertEq(capital, 0, "empty");
        assertEq(_available(), 0, "no capital, nothing available");
        assertEq(_fromSlots() + _available(), PRINCIPAL, "the slot counts its lent principal only");
        assertEq(_fromSlots() * 1e18 / (_fromSlots() + _available()), 1e18, "how full 100%");
        _assertLive(_one(loanId), "empty vault");
    }

    /// @dev A slot whose fillable remainder is below its smallest fill counts
    ///      zero: on the exposure side and on the capital side.
    function test_remainderBelowSmallestFillCountsZero() public {
        // Exposure side: 1050 limit, 1000 lent, 50 unused < MIN_FILL.
        _set(mockCollateralERC20, 0, 1050 ether, false);
        _fund(3000 ether);
        _fill(_postBorrower(_newBorrower("b-exp"), false));
        (, uint256 fillable, , uint256 capital) = _slot();
        assertEq(capital, 2000 ether, "capital left");
        assertEq(fillable, 0, "50 of room is below the smallest fill");
        assertEq(_available(), 0, "counts zero");
        // Re-set with room: the capital is usable again.
        _set(mockCollateralERC20, 0, 5000 ether, false);
        assertEq(_available(), 2000 ether, "room restored");
        // Capital side: withdraw to 50 of capital.
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            lender, mockERC20, mockCollateralERC20, 0, 1950 ether
        );
        assertEq(_available(), 0, "50 of capital is below the smallest fill");
        _fund(50 ether);
        assertEq(_available(), MIN_FILL, "exactly the smallest fill counts");
    }

    /// @dev A cancelled slot counts zero available while its loan still counts
    ///      as lent from slots.
    function test_cancelledSlotCountsZeroWhileItsLoanStaysLent() public {
        _set(mockCollateralERC20, 0, 5000 ether, false);
        _fund(3000 ether);
        uint256 loanId = _fill(_postBorrower(_newBorrower("b-c"), false));
        assertEq(_available(), 2000 ether);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(mockERC20, mockCollateralERC20, 0);
        assertEq(_available(), 0, "cancelled: nothing available");
        _assertLive(_one(loanId), "cancelled");
    }

    /// @dev A slot whose window closes leaves Available at the end of its
    ///      closing day with no transaction; its loan stays lent.
    function test_closedWindowLeavesAvailableWithoutATransaction() public {
        uint64 until = uint64(vm.getBlockTimestamp() + 40 days);
        _setUntil(0, 5000 ether, until);
        _fund(3000 ether);
        uint256 loanId = _fill(_postBorrower(_newBorrower("b-w"), false));
        assertEq(_available(), 2000 ether, "open window");
        uint256 closes = until - 1 days;
        vm.warp((closes / 1 days) * 1 days + 1 days - 1);
        assertEq(_available(), 2000 ether, "counts through its closing day");
        vm.warp((closes / 1 days) * 1 days + 1 days);
        assertEq(_available(), 0, "gone the next day, read with no write");
        assertEq(_pairAvailable(), 0, "and from the pair");
        _rollAll();
        assertEq(_available(), 0, "rolling agrees");
        assertEq(_fromSlots(), _open(loanId) ? _principal(loanId) : 0, "its loan still counts as lent");
    }

    // ─── The live-principal invariant ───────────────────────────────────────

    /// @dev Partial repay lowers live by exactly the cleared principal (and
    ///      frees that much exposure); the full repay takes the rest out at
    ///      once; the claim moves nothing more.
    function test_liveFollowsPartialAndFullRepayAndClaim() public {
        _set(mockCollateralERC20, 0, 1500 ether, true);
        _fund(2000 ether);
        address b = _newBorrower("b-p");
        uint256 loanId = _fill(_postBorrower(b, true));
        _assertLive(_one(loanId), "fill");
        assertEq(_available(), 500 ether, "room 500, capital 1000");

        vm.warp(block.timestamp + 1 days);
        vm.prank(b);
        RepayFacet(address(diamond)).repayPartial(loanId, 400 ether);
        _assertLive(_one(loanId), "partial repay");
        (, , uint256 live, ) = _slot();
        assertLt(live, PRINCIPAL, "live fell with the principal");
        assertEq(_available(), 1500 ether - live, "the freed exposure is available against the capital");

        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        _assertLive(_one(loanId), "full repay");
        (, , live, ) = _slot();
        assertEq(live, 0, "nothing outstanding");

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        _assertLive(_none(), "claim");
    }

    /// @dev A roll of a repaid loan releases nothing more (its principal left
    ///      live at repay) and its re-liened proceeds join Available.
    function test_liveAndAvailableThroughRoll() public {
        _set(mockCollateralERC20, 0, 5000 ether, false);
        _fund(PRINCIPAL);
        address b = _newBorrower("b-r");
        uint256 loanId = _fill(_postBorrower(b, false));
        assertEq(_available(), 0, "all capital lent");
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        _assertLive(_one(loanId), "repay");
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        _assertLive(_none(), "roll");
        (, uint256 fillable, , uint256 capital) = _slot();
        assertGt(capital, PRINCIPAL - 1, "proceeds re-liened");
        assertEq(fillable, capital, "the re-liened capital is available");
        assertEq(_available(), capital, "and in the total");
    }

    /// @dev A time-based default takes the loan out of live at once; the claim
    ///      releases nothing more.
    function test_liveThroughDefaultAndClaim() public {
        _set(mockCollateralERC20, 0, 5000 ether, false);
        _fund(2000 ether);
        uint256 loanId = _fill(_postBorrower(_newBorrower("b-d"), false));
        vm.warp(block.timestamp + uint256(MAX_DURATION) * 1 days + LibVaipakam.gracePeriod(MAX_DURATION) + 1);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, mockCollateralERC20),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        uint256 sellQuote = defaultQuote(address(diamond), loanId);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, sellQuote, defaultAdapterCalls());
        vm.clearMockedCalls();
        _assertLive(_one(loanId), "default");
        (, , uint256 live, ) = _slot();
        assertEq(live, 0, "a defaulted loan is not outstanding");
        assertEq(_available(), 1000 ether, "the freed exposure is available against the capital left");
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        _assertLive(_none(), "claim after default");
    }

    /// @dev A lender-position transfer and consolidation is a lender exit: the
    ///      loan leaves the slot's live principal and lent-from-slots, while it
    ///      stays lent.
    function test_liveThroughConsolidation() public {
        _set(mockCollateralERC20, 0, 5000 ether, false);
        _fund(2000 ether);
        uint256 loanId = _fill(_postBorrower(_newBorrower("b-x"), false));
        _assertLive(_one(loanId), "fill");
        address newHolder = makeAddr("newHolder");
        LibTestPositionNFT.move(address(diamond), LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId, newHolder);
        vm.prank(newHolder);
        ConsolidationFacet(address(diamond)).consolidatePrincipalToHolder(loanId);
        _assertLive(_none(), "consolidated");
        (, uint256 lent) = _asset();
        assertEq(lent, PRINCIPAL, "the loan is still lent");
        assertEq(_available(), 1000 ether, "the slot's room is back against its capital");
    }

    /// @dev Ledger bookkeeping never blocks a close-out. A slot-held loan whose
    ///      origin record is gone (written here with `vm.store`, since no
    ///      path deletes it) is treated as held by no slot: the partial repay,
    ///      the full repay and the claim all go through, and the slot's live
    ///      figure is simply left as it stood.
    function test_missingOriginNeverBlocksRepayOrClaim() public {
        _set(mockCollateralERC20, 0, 1500 ether, true);
        _fund(2000 ether);
        address b = _newBorrower("b-o");
        uint256 loanId = _fill(_postBorrower(b, true));
        (, , uint256 liveBefore, ) = _slot();
        assertEq(liveBefore, PRINCIPAL, "the slot holds the loan");

        // intentOrigin is field 259 of the namespaced Storage; its owner word
        // is the first slot of the mapping value (layout.golden.json).
        bytes32 base = keccak256(abi.encode(uint256(keccak256("vaipakam.storage")) - 1))
            & ~bytes32(uint256(0xff));
        bytes32 ownerSlot = keccak256(abi.encode(loanId, uint256(base) + 259));
        assertTrue(vm.load(address(diamond), ownerSlot) != bytes32(0), "origin recorded before");
        vm.store(address(diamond), ownerSlot, bytes32(0));

        vm.warp(block.timestamp + 1 days);
        vm.prank(b);
        RepayFacet(address(diamond)).repayPartial(loanId, 400 ether);
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "the loan repaid"
        );
        (, , uint256 liveAfter, ) = _slot();
        assertEq(liveAfter, liveBefore, "no slot was charged for a loan none holds");

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
    }
}
