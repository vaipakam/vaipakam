// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {TotalRead} from "../../script/lib/TotalRead.sol";

/// @dev Answers every call with `answer`, verbatim.
contract FixedReply {
    bytes internal answer;
    bool internal reverts;

    constructor(bytes memory answer_, bool reverts_) {
        answer = answer_;
        reverts = reverts_;
    }

    fallback() external {
        bytes memory a = answer;
        if (reverts) {
            assembly {
                revert(add(a, 32), mload(a))
            }
        }
        assembly {
            return(add(a, 32), mload(a))
        }
    }
}

/// @dev Exposes the library.
contract TotalReadHarness {
    function wordOf(address t) external view returns (bool, uint256) {
        return TotalRead.wordOf(t, bytes4(0x12345678));
    }

    function addressOf(address t) external view returns (bool, address) {
        return TotalRead.addressOf(t, bytes4(0x12345678));
    }

    function boolOf(address t) external view returns (bool, bool) {
        return TotalRead.boolOf(t, bytes4(0x12345678));
    }
}

/**
 * @title  TotalReadTest
 * @notice #2443 — the one read the sanctions scripts make of a recorded
 *         contract always returns: exactly one in-range word is a value,
 *         anything else is `ok == false`, never a revert.
 */
contract TotalReadTest is Test {
    TotalReadHarness internal h;

    function setUp() public {
        h = new TotalReadHarness();
    }

    function _reply(bytes memory answer) internal returns (address) {
        return address(new FixedReply(answer, false));
    }

    function test_OneWordInRangeIsAValue_AnythingElseIsNotOk() public {
        address a = makeAddr("a");
        bool ok;
        uint256 w;
        address v;
        bool b;

        (ok, v) = h.addressOf(_reply(abi.encode(a)));
        assertTrue(ok);
        assertEq(v, a);
        (ok, b) = h.boolOf(_reply(abi.encode(true)));
        assertTrue(ok && b);
        (ok, b) = h.boolOf(_reply(abi.encode(false)));
        assertTrue(ok && !b);
        (ok, w) = h.wordOf(_reply(abi.encode(type(uint256).max)));
        assertTrue(ok);
        assertEq(w, type(uint256).max);

        // Out of the type's range.
        (ok,) = h.addressOf(_reply(abi.encode(uint256(type(uint160).max) + 1)));
        assertFalse(ok, "a word too wide for an address");
        (ok,) = h.boolOf(_reply(abi.encode(uint256(2))));
        assertFalse(ok, "a word that is not a bool");
        // Not one word.
        (ok,) = h.wordOf(_reply(""));
        assertFalse(ok, "an empty answer");
        (ok,) = h.wordOf(_reply(abi.encode(a, a)));
        assertFalse(ok, "two words");
        (ok,) = h.wordOf(_reply(hex"01"));
        assertFalse(ok, "a short answer");
        // No answer at all.
        (ok,) = h.wordOf(address(new FixedReply(abi.encode(a), true)));
        assertFalse(ok, "a revert, even one carrying a word");
        (ok,) = h.wordOf(makeAddr("no code"));
        assertFalse(ok, "no code");
        (ok,) = h.wordOf(address(this));
        assertFalse(ok, "no such function");
    }
}
