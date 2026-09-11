// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/**
 * @title StorageSlotProbe
 * @notice #1566 — the ABSOLUTE storage slots of the fields the
 *         grandfathered-custody census reads directly where a Diamond routes
 *         no getter, obtained from the COMPILER rather than by counting the
 *         `Storage` struct's fields by hand. A slot that is merely computed
 *         fails silently as zero, which is the one answer the census must
 *         never manufacture; a slot the compiler used for a real SLOAD cannot.
 *
 *         Two techniques, both of which make the compiler answer:
 *           - value fields: read the field under `vm.record()` and take the
 *             slot `vm.accesses()` reports — the value is returned in the
 *             probe so the load cannot be optimised away;
 *           - mappings: a local storage pointer's `.slot` in assembly.
 *         The example rows (loan id 1) are recorded the same way, so the row
 *         arithmetic every consumer uses — `keccak256(abi.encode(loanId, slot))`
 *         plus the member offset — is pinned against a load the compiler
 *         emitted, not against a formula copied from a book.
 *
 *         ONE implementation, two consumers: `StorageSlotProbe.s.sol` writes
 *         `deployments/storage-slots.json` and `StorageSlotPinTest` asserts
 *         that file against a fresh probe, so the pin IS the check.
 *         Design: Vpfi1566CanonicalDeliveredBoundDesign.md §7.
 */
library StorageSlotProbe {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Slots {
        bytes32 storagePosition;         // ERC-7201 base of LibVaipakam.Storage
        bytes32 nextLoanId;              // uint256 — ids are assigned as ++nextLoanId
        bytes32 totalLoansEverCreated;   // uint256 — monotonic
        bytes32 intentLiveCommitCount;   // uint256 — live intent commits
        bytes32 intentCommits;           // mapping(uint256 => SwapToRepayIntentCommit)
        bytes32 borrowerLifRebate;       // mapping(uint256 => BorrowerLifRebate)
        bytes32 fallbackSnapshot;        // mapping(uint256 => FallbackSnapshot)
        // example rows for loan id 1, recorded from real loads
        bytes32 exampleIntentOrderHashSlot;    // intentCommits[1].orderHash      = row + 0
        bytes32 exampleRebateVpfiHeldSlot;     // borrowerLifRebate[1].vpfiHeld    = row + 0
        bytes32 exampleRebateRebateAmountSlot; // borrowerLifRebate[1].rebateAmount = row + 1
        bytes32 exampleFallbackActiveSlot;     // fallbackSnapshot[1].active        = row + 5 (packed)
        // the values read (returned so the loads survive the optimiser)
        uint256 nextLoanIdValue;
        uint256 totalLoansEverCreatedValue;
        uint256 intentLiveCommitCountValue;
    }

    uint256 internal constant EXAMPLE_LOAN_ID = 1;

    /// @notice Probe the executing contract's storage for every slot the census reads.
    /// @dev Split into small steps: viaIR ran out of stack when every read shared one frame.
    function probe() internal returns (Slots memory p) {
        p.storagePosition = LibVaipakam.VANGKI_STORAGE_POSITION;
        _probeCounters(p);
        _probeMappingHeads(p);
        _probeExampleRows(p);
    }

    function _probeCounters(Slots memory p) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        VM.record();
        p.nextLoanIdValue = s.nextLoanId;
        p.nextLoanId = _onlyRead();
        VM.record();
        p.totalLoansEverCreatedValue = s.totalLoansEverCreated;
        p.totalLoansEverCreated = _onlyRead();
        VM.record();
        p.intentLiveCommitCountValue = s.intentLiveCommitCount;
        p.intentLiveCommitCount = _onlyRead();
    }

    function _probeMappingHeads(Slots memory p) private view {
        p.intentCommits = _intentCommitsSlot();
        p.borrowerLifRebate = _borrowerLifRebateSlot();
        p.fallbackSnapshot = _fallbackSnapshotSlot();
    }

    function _intentCommitsSlot() private view returns (bytes32 slot) {
        mapping(uint256 => LibVaipakam.SwapToRepayIntentCommit) storage m = LibVaipakam.storageSlot().intentCommits;
        assembly {
            slot := m.slot
        }
    }

    function _borrowerLifRebateSlot() private view returns (bytes32 slot) {
        mapping(uint256 => LibVaipakam.BorrowerLifRebate) storage m = LibVaipakam.storageSlot().borrowerLifRebate;
        assembly {
            slot := m.slot
        }
    }

    function _fallbackSnapshotSlot() private view returns (bytes32 slot) {
        mapping(uint256 => LibVaipakam.FallbackSnapshot) storage m = LibVaipakam.storageSlot().fallbackSnapshot;
        assembly {
            slot := m.slot
        }
    }

    function _probeExampleRows(Slots memory p) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 nonZero;
        VM.record();
        nonZero += s.intentCommits[EXAMPLE_LOAN_ID].orderHash == bytes32(0) ? 0 : 1;
        p.exampleIntentOrderHashSlot = _onlyRead();
        VM.record();
        nonZero += s.borrowerLifRebate[EXAMPLE_LOAN_ID].vpfiHeld == 0 ? 0 : 1;
        p.exampleRebateVpfiHeldSlot = _onlyRead();
        VM.record();
        nonZero += s.borrowerLifRebate[EXAMPLE_LOAN_ID].rebateAmount == 0 ? 0 : 1;
        p.exampleRebateRebateAmountSlot = _onlyRead();
        VM.record();
        nonZero += s.fallbackSnapshot[EXAMPLE_LOAN_ID].active ? 1 : 0;
        p.exampleFallbackActiveSlot = _onlyRead();
        // fold the example values into a returned field so none of the loads is dead
        p.intentLiveCommitCountValue += nonZero;
    }

    /// @dev Exactly ONE storage read since the last `record()` — the slot the compiler chose.
    function _onlyRead() private returns (bytes32 slot) {
        (bytes32[] memory reads, ) = VM.accesses(address(this));
        require(reads.length == 1, "StorageSlotProbe: expected exactly one storage read");
        slot = reads[0];
    }

    /// @notice The row slot of a loan-keyed mapping, as every consumer computes it.
    function rowSlot(uint256 loanId, bytes32 mappingSlot) internal pure returns (bytes32) {
        return keccak256(abi.encode(loanId, mappingSlot));
    }

    /// @notice The ERC-7201 derivation LibVaipakam documents for its position.
    function erc7201(string memory ns) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(keccak256(bytes(ns))) - 1)) & ~bytes32(uint256(0xff));
    }
}

/**
 * @notice A deployable host for {StorageSlotProbe.probe}: forge refuses
 *         `address(this)` inside a SCRIPT contract (scripts are ephemeral and
 *         their addresses must not be relied upon), and `vm.accesses` needs
 *         the address whose storage was read. The script deploys this and
 *         probes its storage; the test may call the library directly.
 */
contract StorageSlotProbeTarget {
    function probe() external returns (StorageSlotProbe.Slots memory) {
        return StorageSlotProbe.probe();
    }
}

