// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibInterestLedger} from "../src/libraries/LibInterestLedger.sol";

/// @dev Runs the ledger's checkpoint and principal writer against its own
///      storage, so the accrual rule can be pinned without a Diamond.
contract LedgerHarness {
    function seed(uint256 loanId, uint256 principal, uint256 rateBps, uint64 startTime) external {
        LibVaipakam.Loan storage l = LibVaipakam.storageSlot().loans[loanId];
        l.id = loanId;
        l.principal = principal;
        l.interestRateBps = rateBps;
        l.startTime = startTime;
        l.status = LibVaipakam.LoanStatus.Active;
        l.assetType = LibVaipakam.AssetType.ERC20;
    }

    function setStatus(uint256 loanId, LibVaipakam.LoanStatus status) external {
        LibVaipakam.storageSlot().loans[loanId].status = status;
    }

    function touch(uint256 loanId) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibInterestLedger.touch(s, s.loans[loanId]);
    }

    function reducePrincipal(uint256 loanId, uint256 cleared, uint256 delivered) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibInterestLedger.reducePrincipal(s, s.loans[loanId], cleared, delivered);
    }

    function earned(uint256 loanId) external view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return LibInterestLedger.holderEarnedNow(s, s.loans[loanId]);
    }
}

/// @title InterestLedgerFallbackTest
/// @notice #1209 / #1808 (Codex #3068 r3) — a FallbackPending loan still
///         accrues to the lender side (a cure returns it to Active owing the
///         whole stretch), so a principal change during the fallback (a partial
///         internal match) checkpoints the stretch at the old principal first.
///         A terminal loan earns nothing more.
contract InterestLedgerFallbackTest is Test {
    uint256 internal constant LOAN_ID = 9;
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant RATE_BPS = 1000;
    LedgerHarness internal h;

    function setUp() public {
        vm.warp(1_000_000);
        h = new LedgerHarness();
        h.seed(LOAN_ID, PRINCIPAL, RATE_BPS, uint64(block.timestamp));
    }

    function _accrual(uint256 principal, uint256 secs) internal pure returns (uint256) {
        return (principal * RATE_BPS * secs) / (365 days * 10_000);
    }

    function test_fallbackPrincipalChange_pricesEachStretchAtItsOwnPrincipal() public {
        vm.warp(vm.getBlockTimestamp() + 10 days);
        h.setStatus(LOAN_ID, LibVaipakam.LoanStatus.FallbackPending);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        // A partial match halves the principal while the loan is in fallback.
        h.reducePrincipal(LOAN_ID, PRINCIPAL / 2, PRINCIPAL / 2);
        h.setStatus(LOAN_ID, LibVaipakam.LoanStatus.Active);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        assertEq(
            h.earned(LOAN_ID),
            _accrual(PRINCIPAL, 15 days) + _accrual(PRINCIPAL / 2, 5 days),
            "the 15 days before the match are priced at the full principal"
        );
    }

    function test_terminalLoan_earnsNothingMore() public {
        vm.warp(vm.getBlockTimestamp() + 10 days);
        h.touch(LOAN_ID);
        uint256 atTerminal = h.earned(LOAN_ID);
        h.setStatus(LOAN_ID, LibVaipakam.LoanStatus.Repaid);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        h.touch(LOAN_ID);
        assertEq(h.earned(LOAN_ID), atTerminal, "no accrual past the terminal");
    }
}
