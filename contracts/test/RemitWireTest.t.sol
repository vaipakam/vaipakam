// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {RemitWire} from "../src/crosschain/RemitWire.sol";

/// @title RemitWireTest — #2828: the d8 wire's codec.
contract RemitWireTest is Test {
    function test_D8_RoundTrip_CarriesTheDaySplitEraAndTheDaysWhole() public pure {
        bytes memory p = RemitWire.encodeD8(
            RemitWire.D8({
                dayId: 412,
                total: 9e18,
                remitId: 77,
                remitter: address(0xD1A),
                recycledShare: 4e18,
                intendedEra: 5,
                dayWholeFresh: 11e18,
                dayWholeRecycled: 6e18
            })
        );
        assertEq(p.length, 9 * 32, "nine static words");
        (uint256 tag, RemitWire.D8 memory w) = abi.decode(p, (uint256, RemitWire.D8));
        assertEq(tag, RemitWire.REMIT_WIRE_TAG_D8, "leads with the d8 tag");
        assertEq(w.dayId, 412, "the one funded day rides inline");
        assertEq(w.total, 9e18);
        assertEq(w.remitId, 77);
        assertEq(w.remitter, address(0xD1A));
        assertEq(w.recycledShare, 4e18);
        assertEq(w.intendedEra, 5);
        assertEq(w.dayWholeFresh, 11e18, "#918: the day's whole rides per component");
        assertEq(w.dayWholeRecycled, 6e18);
        // The era rides as a full word.
        (, , , , , , uint256 era) = abi.decode(p, (uint256, uint256, uint256, uint256, address, uint256, uint256));
        assertEq(era, 5, "the era rides as a full word");
    }

    /// @dev Day 0 is a real reward day: the wire carries it like any other,
    ///      and nothing about the shape treats a zero day as absent.
    function test_D8_DayZero_RidesAsAnyOtherDay() public pure {
        bytes memory p = RemitWire.encodeD8(
            RemitWire.D8({
                dayId: 0,
                total: 1,
                remitId: 1,
                remitter: address(1),
                recycledShare: 0,
                intendedEra: 0,
                dayWholeFresh: 1,
                dayWholeRecycled: 0
            })
        );
        (, RemitWire.D8 memory w) = abi.decode(p, (uint256, RemitWire.D8));
        assertEq(w.dayId, 0);
        assertEq(w.total, 1);
    }

    function test_D8_Tag_IsItsOwn() public pure {
        assertTrue(RemitWire.REMIT_WIRE_TAG_D8 != RemitWire.REMIT_WIRE_TAG_P2, "a tag per shape");
        assertTrue(
            RemitWire.REMIT_WIRE_TAG_D8 != uint256(keccak256("vaipakam.remit.wire.d7")), "d8 is not the retired d7 tag"
        );
        assertTrue(
            RemitWire.REMIT_WIRE_TAG_D8 != uint256(keccak256("vaipakam.remit.wire.d6")), "d8 is not the retired d6 tag"
        );
        assertEq(RemitWire.REMIT_WIRE_TAG_D8, uint256(keccak256("vaipakam.remit.wire.d8")));
    }
}
