// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {StorageSlotProbe} from "../../script/lib/StorageSlotProbe.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/**
 * @title StorageSlotPinTest
 * @notice #1566 — pins `deployments/storage-slots.json`, the slots the
 *         grandfathered-custody census reads directly, to a FRESH probe of
 *         the compiler's layout (design §7). A reordered `Storage` struct, a
 *         retyped field or a changed ERC-7201 position fails here before the
 *         census can read a slot that no longer means what the file says.
 *         Also pins the row arithmetic every consumer uses against loads the
 *         compiler emitted. Runs in the `cifast` lane (`test/deploy/**`).
 */
contract StorageSlotPinTest is Test {
    string constant FILE = "deployments/storage-slots.json";

    function _b32(string memory json, string memory key) internal pure returns (bytes32) {
        return vm.parseJsonBytes32(json, key);
    }

    function test_PinnedSlotsMatchTheCompiler() public {
        string memory json = vm.readFile(FILE);
        StorageSlotProbe.Slots memory p = StorageSlotProbe.probe();
        assertEq(_b32(json, ".storagePosition"), p.storagePosition, "storagePosition");
        assertEq(_b32(json, ".fields.nextLoanId"), p.nextLoanId, "nextLoanId");
        assertEq(_b32(json, ".fields.totalLoansEverCreated"), p.totalLoansEverCreated, "totalLoansEverCreated");
        assertEq(_b32(json, ".fields.intentLiveCommitCount"), p.intentLiveCommitCount, "intentLiveCommitCount");
        assertEq(_b32(json, ".fields.intentCommits"), p.intentCommits, "intentCommits");
        assertEq(_b32(json, ".fields.borrowerLifRebate"), p.borrowerLifRebate, "borrowerLifRebate");
        assertEq(_b32(json, ".fields.fallbackSnapshot"), p.fallbackSnapshot, "fallbackSnapshot");
        assertEq(_b32(json, ".example.intentCommitsOrderHash"), p.exampleIntentOrderHashSlot, "example intent row");
        assertEq(_b32(json, ".example.borrowerLifRebateVpfiHeld"), p.exampleRebateVpfiHeldSlot, "example rebate row +0");
        assertEq(_b32(json, ".example.borrowerLifRebateRebateAmount"), p.exampleRebateRebateAmountSlot, "example rebate row +1");
        assertEq(_b32(json, ".example.fallbackSnapshotActive"), p.exampleFallbackActiveSlot, "example fallback row +5");
    }

    /// @dev The storage position is the ERC-7201 derivation the library documents,
    ///      not the plain hash an older guidance note claimed.
    function test_StoragePositionIsTheErc7201Derivation() public pure {
        assertEq(StorageSlotProbe.erc7201("vaipakam.storage"), LibVaipakam.VANGKI_STORAGE_POSITION);
        assertTrue(keccak256("vaipakam.storage") != LibVaipakam.VANGKI_STORAGE_POSITION, "the plain hash is NOT the position");
    }

    /// @dev The row arithmetic consumers use reproduces the loads the compiler emitted.
    function test_RowArithmeticReproducesTheCompilersLoads() public {
        StorageSlotProbe.Slots memory p = StorageSlotProbe.probe();
        uint256 id = StorageSlotProbe.EXAMPLE_LOAN_ID;
        assertEq(StorageSlotProbe.rowSlot(id, p.intentCommits), p.exampleIntentOrderHashSlot, "intent orderHash at row+0");
        assertEq(StorageSlotProbe.rowSlot(id, p.borrowerLifRebate), p.exampleRebateVpfiHeldSlot, "rebate vpfiHeld at row+0");
        assertEq(bytes32(uint256(StorageSlotProbe.rowSlot(id, p.borrowerLifRebate)) + 1), p.exampleRebateRebateAmountSlot, "rebate rebateAmount at row+1");
        assertEq(bytes32(uint256(StorageSlotProbe.rowSlot(id, p.fallbackSnapshot)) + 5), p.exampleFallbackActiveSlot, "fallback active at row+5");
        // value fields are plain slots, distinct from each other and from every mapping head
        assertTrue(p.nextLoanId != p.totalLoansEverCreated && p.nextLoanId != p.intentLiveCommitCount, "distinct value slots");
        // the layout under probe is empty, so every value read is zero
        assertEq(p.nextLoanIdValue, 0);
        assertEq(p.totalLoansEverCreatedValue, 0);
        assertEq(p.intentLiveCommitCountValue, 0);
    }
}
