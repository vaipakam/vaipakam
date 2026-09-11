// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {SwapToRepayIntentHarness} from "./SwapToRepayIntentFacetTest.t.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title StorageSlotCalibrationTest
 * @notice #1566, design §7 question 3 — the CALIBRATION of the storage slots the
 *         custody census reads where a Diamond routes no getter. The pinned
 *         file `deployments/storage-slots.json` (the very file the census
 *         reads) is checked against rows written by the PRODUCTION paths and
 *         read back through the ROUTED getters, on rows that are non-zero:
 *
 *           - an intent-commit row, a rebate row and a fallback snapshot
 *             written through the test mutator — compiled against the same
 *             library layout, so the compiler chooses the very slot the
 *             production writers use — and read back through the ROUTED
 *             getters `getIntentCommit` / `getBorrowerLifRebate` /
 *             `getFallbackSnapshot`, the production read paths. (The intent
 *             suite has no successful-commit test: a valid commit needs
 *             Fusion's canonical extension and a priced loan for the HF
 *             gate, which this harness does not provide.)
 *
 *         Every assertion pairs `vm.load` at the derived slot with the getter's
 *         value. A slot that is merely computed fails silently as zero; one
 *         that agrees with the code's own view on a non-zero row does not.
 */
contract StorageSlotCalibrationTest is SwapToRepayIntentHarness {
    string constant FILE = "deployments/storage-slots.json";

    function _slot(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(vm.readFile(FILE), key);
    }

    function _row(uint256 loanId, bytes32 mappingSlot) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(loanId, mappingSlot)));
    }

    function _load(uint256 slot) internal view returns (uint256) {
        return uint256(vm.load(address(diamond), bytes32(slot)));
    }

    /// @dev The production commit path cannot complete in this harness (the
    ///      intent suite has only revert tests: a valid commit needs Fusion's
    ///      canonical extension and a priced loan for the HF gate), so the row
    ///      is written through the test mutator — compiled against the same
    ///      library, so the compiler chooses the same slot — and read back
    ///      through the ROUTED `getIntentCommit`, the production read path.
    ///      The calibration triangle is the same as for the other two rows:
    ///      library-layout write → routed getter → raw storage at the derived
    ///      slot, on a non-zero row.
    function test_LiveIntentCommit_RowAtDerivedSlotsMatchesTheRoutedGetter() public {
        LibVaipakam.SwapToRepayIntentCommit memory c;
        c.orderHash = keccak256("calibration order");
        c.deadline = uint64(block.timestamp + 300);
        c.makerAmount = 2_000 ether;
        c.takerAmount = 1_200 ether;
        c.salt = 0xC0FFEE;
        c.makerTraits = (1 << 249) | (1 << 252) | (1 << 251) | (1 << 255);
        c.extensionHash = keccak256("ext");
        c.custodialCollateral = 2_000 ether;
        TestMutatorFacet(address(diamond)).setIntentCommitRaw(LOAN_ID, c);
        // routed read path sees the row
        SwapToRepayIntentFacet.FusionOrderRead memory o = SwapToRepayIntentFacet(address(diamond)).getIntentCommit(LOAN_ID);
        assertEq(o.makerAmount, c.makerAmount);
        assertEq(o.takerAmount, c.takerAmount);
        assertEq(o.deadline, c.deadline);
        assertEq(o.salt, c.salt);
        assertEq(o.makerTraits, c.makerTraits);
        // derived slots agree with both
        uint256 row = _row(LOAN_ID, _slot(".fields.intentCommits"));
        assertEq(bytes32(_load(row + 0)), c.orderHash, "orderHash at row+0");
        assertEq(uint64(_load(row + 1)), o.deadline, "deadline at row+1");
        assertEq(_load(row + 2), o.makerAmount, "makerAmount at row+2");
        assertEq(_load(row + 3), o.takerAmount, "takerAmount at row+3");
        assertEq(_load(row + 4), o.salt, "salt at row+4");
        assertEq(_load(row + 5), o.makerTraits, "makerTraits at row+5");
        assertEq(_load(uint256(_slot(".fields.intentLiveCommitCount"))), 1, "intentLiveCommitCount == 1 at its slot");
        // an id with no commit reads zero at ITS row, and the routed getter reverts IntentNoCommit for it
        assertEq(_load(_row(LOAN_ID + 7, _slot(".fields.intentCommits"))), 0);
        vm.expectRevert(abi.encodeWithSelector(SwapToRepayIntentFacet.IntentNoCommit.selector, LOAN_ID + 7));
        SwapToRepayIntentFacet(address(diamond)).getIntentCommit(LOAN_ID + 7);
    }

    function test_LoanCounters_AtDerivedSlotsMatchTheScaffold() public {
        // _scaffoldLoan set nextLoanId to LOAN_ID through the mutator (production ids are ++nextLoanId)
        TestMutatorFacet(address(diamond)).setNextLoanId(41);
        assertEq(_load(uint256(_slot(".fields.nextLoanId"))), 41, "nextLoanId at its slot");
        assertEq(uint256(_slot(".fields.nextLoanId")) - uint256(_slot(".storagePosition")), 1, "nextLoanId is base + 1");
    }

    function test_RebateRow_AtDerivedSlotsMatchesTheRoutedGetter() public {
        TestMutatorFacet(address(diamond)).setBorrowerLifRebateRaw(LOAN_ID, 123e18, 45e18);
        (uint256 rebateAmount, uint256 vpfiHeld) = ClaimFacet(address(diamond)).getBorrowerLifRebate(LOAN_ID);
        assertEq(vpfiHeld, 123e18);
        assertEq(rebateAmount, 45e18);
        uint256 row = _row(LOAN_ID, _slot(".fields.borrowerLifRebate"));
        assertEq(_load(row + 0), vpfiHeld, "vpfiHeld at row+0");
        assertEq(_load(row + 1), rebateAmount, "rebateAmount at row+1");
        assertEq(_load(_row(LOAN_ID + 1, _slot(".fields.borrowerLifRebate"))), 0, "another id reads zero");
    }

    function test_FallbackSnapshot_AtDerivedSlotsMatchesTheRoutedGetter() public {
        LibVaipakam.FallbackSnapshot memory snap;
        snap.lenderCollateral = 11;
        snap.treasuryCollateral = 22;
        snap.borrowerCollateral = 33;
        snap.lenderPrincipalDue = 44;
        snap.treasuryPrincipalDue = 55;
        snap.active = true;
        snap.retryAttempted = true;
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(LOAN_ID, snap);
        (uint256 lc, uint256 tc, uint256 bc, uint256 lp, uint256 tp, bool active, bool retry) = ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN_ID);
        assertTrue(active && retry && lc == 11 && tc == 22 && bc == 33 && lp == 44 && tp == 55, "getter sees the row");
        uint256 row = _row(LOAN_ID, _slot(".fields.fallbackSnapshot"));
        assertEq(_load(row + 0), 11);
        assertEq(_load(row + 1), 22);
        assertEq(_load(row + 2), 33);
        assertEq(_load(row + 3), 44);
        assertEq(_load(row + 4), 55);
        // the two booleans pack into row+5: active at byte 0, retryAttempted at byte 1
        uint256 packed = _load(row + 5);
        assertEq(packed & 0xff, 1, "active at row+5 byte 0");
        assertEq((packed >> 8) & 0xff, 1, "retryAttempted at row+5 byte 1");
    }
}
