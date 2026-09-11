// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {StorageSlotProbe, StorageSlotProbeTarget} from "./lib/StorageSlotProbe.sol";

/**
 * @title StorageSlotProbeScript
 * @notice Writes `deployments/storage-slots.json` — the slots the
 *         grandfathered-custody census reads where a Diamond routes no getter
 *         (#1566, design §7). No broadcast: every value comes from probing
 *         this script's own storage with the compiler's layout. Re-run after
 *         any change to `LibVaipakam.Storage`; `StorageSlotPinTest` fails
 *         until the file matches.
 *
 *           forge script script/StorageSlotProbe.s.sol
 */
contract StorageSlotProbeScript is Script {
    string internal constant OUT = "deployments/storage-slots.json";

    function run() external {
        StorageSlotProbe.Slots memory p = new StorageSlotProbeTarget().probe();
        string memory f = "fields";
        vm.serializeBytes32(f, "nextLoanId", p.nextLoanId);
        vm.serializeBytes32(f, "totalLoansEverCreated", p.totalLoansEverCreated);
        vm.serializeBytes32(f, "intentLiveCommitCount", p.intentLiveCommitCount);
        vm.serializeBytes32(f, "intentCommits", p.intentCommits);
        vm.serializeBytes32(f, "borrowerLifRebate", p.borrowerLifRebate);
        string memory fields = vm.serializeBytes32(f, "fallbackSnapshot", p.fallbackSnapshot);

        string memory e = "example";
        vm.serializeUint(e, "loanId", StorageSlotProbe.EXAMPLE_LOAN_ID);
        vm.serializeBytes32(e, "intentCommitsOrderHash", p.exampleIntentOrderHashSlot);
        vm.serializeBytes32(e, "borrowerLifRebateVpfiHeld", p.exampleRebateVpfiHeldSlot);
        vm.serializeBytes32(e, "borrowerLifRebateRebateAmount", p.exampleRebateRebateAmountSlot);
        string memory example = vm.serializeBytes32(e, "fallbackSnapshotActive", p.exampleFallbackActiveSlot);

        string memory r = "rowLayout";
        vm.serializeUint(r, "intentCommits.orderHash", 0);
        vm.serializeUint(r, "borrowerLifRebate.vpfiHeld", 0);
        vm.serializeUint(r, "borrowerLifRebate.rebateAmount", 1);
        vm.serializeUint(r, "fallbackSnapshot.lenderCollateral", 0);
        vm.serializeUint(r, "fallbackSnapshot.treasuryCollateral", 1);
        vm.serializeUint(r, "fallbackSnapshot.borrowerCollateral", 2);
        vm.serializeUint(r, "fallbackSnapshot.lenderPrincipalDue", 3);
        vm.serializeUint(r, "fallbackSnapshot.treasuryPrincipalDue", 4);
        string memory rowLayout = vm.serializeUint(r, "fallbackSnapshot.activeAndRetryAttempted", 5);

        string memory root = "root";
        vm.serializeString(root, "purpose", "Absolute storage slots the grandfathered-custody census reads where a Diamond routes no getter (#1566, design section 7). Written by forge script script/StorageSlotProbe.s.sol from the compiler's own loads; pinned by test/deploy/StorageSlotPinTest. Never hand-edit.");
        vm.serializeString(root, "derivedFrom", "vm.record/vm.accesses over LibVaipakam.storageSlot() reads, and storage-pointer .slot for mappings");
        vm.serializeBytes32(root, "storagePosition", p.storagePosition);
        vm.serializeString(root, "storagePositionDerivation", "keccak256(abi.encode(uint256(keccak256(\"vaipakam.storage\")) - 1)) & ~bytes32(uint256(0xff))  (ERC-7201)");
        vm.serializeString(root, "rowSlot", "keccak256(abi.encode(uint256 loanId, bytes32 mappingSlot)) + memberOffset");
        vm.serializeString(root, "fields", fields);
        vm.serializeString(root, "rowLayout", rowLayout);
        string memory json = vm.serializeString(root, "example", example);
        vm.writeJson(json, OUT);
    }
}
