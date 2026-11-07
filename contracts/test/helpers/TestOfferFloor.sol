// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/**
 * @title TestOfferFloor
 * @notice #3242 — lowers a test Diamond's offer value floor to one raw unit
 *         (a wei of numeraire), below the setter's one-unit minimum. The
 *         production floor is $10, which refuses the wei-sized offers most
 *         suites post against the $1 mocks; lowering it lets them keep
 *         testing what they test. `OfferBookBoundsTest` restores the default
 *         through the real setter before it tests the floor.
 * @dev Finds the field's slot by writing it in the calling test contract's
 *      own copy of the namespaced storage under `vm.record`, so no slot
 *      number is hand-kept here; then clears that copy and writes the slot
 *      on the Diamond.
 */
library TestOfferFloor {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function lower(address diamond) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 before = s.minOfferValueNumeraire;
        VM.record();
        s.minOfferValueNumeraire = before + 1;
        (, bytes32[] memory writes) = VM.accesses(address(this));
        s.minOfferValueNumeraire = before;
        require(writes.length == 1, "TestOfferFloor: slot not found");
        VM.store(diamond, writes[0], bytes32(uint256(1)));
    }
}
