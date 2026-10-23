// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Deployments} from "./lib/Deployments.sol";
import {StorageLayoutRecord} from "./lib/StorageLayoutRecord.sol";

/**
 * @title  AnchorStorageLayoutRecord
 * @notice Binds the active chain's storage-layout record to its Diamond as it
 *         runs now, by writing `deployments/<slug>/storage-layout.anchor.json`
 *         (#2092 item 1). Sends no transaction.
 *
 * @dev    Every deploy and in-place change writes the record and its anchor
 *         together, so this exists for two cases only: the one-time seed of a
 *         chain deployed before #2092, and the recovery after a change reached
 *         a chain without recording (a run outside the guarded scripts, or a
 *         broadcast that failed part-way). Writing an anchor ASSERTS that the
 *         record beside it describes the code the chain runs, and every later
 *         in-place change trusts that assertion. So the run refuses unless the
 *         operator states it, with `ANCHOR_RECORD_DESCRIBES_CHAIN=true`, after
 *         establishing it: a record at least as large as the layout the
 *         chain's code was built with is safe (the checks are set inclusion),
 *         a smaller one is not.
 *
 *         Usage (from contracts/):
 *           ANCHOR_RECORD_DESCRIBES_CHAIN=true \
 *             forge script script/AnchorStorageLayoutRecord.s.sol --rpc-url $RPC
 */
contract AnchorStorageLayoutRecord is Script {
    function run() external {
        require(
            vm.envOr("ANCHOR_RECORD_DESCRIBES_CHAIN", false),
            "AnchorStorageLayoutRecord: set ANCHOR_RECORD_DESCRIBES_CHAIN=true once you have established that the record describes the code this chain runs"
        );
        address diamond = Deployments.readDiamond();
        StorageLayoutRecord.writeAnchor(diamond);
        console.log("Diamond:", diamond);
        console.log(string.concat("anchored ", StorageLayoutRecord.recordPath(), " -> ", StorageLayoutRecord.anchorPath()));
    }
}
