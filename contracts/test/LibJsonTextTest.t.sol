// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibJsonText} from "../src/libraries/LibJsonText.sol";

/// @notice #2750 — a token symbol placed in position-NFT metadata can never
///         break out of its JSON string.
contract LibJsonTextTest is Test {
    function _safe(string memory raw) internal pure returns (string memory) {
        return LibJsonText.safeText(raw, LibJsonText.MAX_SYMBOL_BYTES);
    }

    function test_plainSymbol_isUnchanged() public pure {
        assertEq(_safe("USDC"), "USDC");
        assertEq(_safe("wstETH-2"), "wstETH-2");
        assertEq(_safe(""), "");
    }

    function test_quoteAndBackslash_areReplaced() public pure {
        // The injection shape: close the string, add a field.
        assertEq(_safe('X","image":"evil'), "X?,?image?:?evil");
        assertEq(_safe("a\\b"), "a?b");
    }

    function test_controlCharacters_areReplaced() public pure {
        assertEq(_safe(string(abi.encodePacked("a", bytes1(0x0a), "b", bytes1(0x00), "c", bytes1(0x7f)))), "a?b?c?");
    }

    function test_multiByteCharacter_becomesOneMark() public pure {
        // "€" is E2 82 AC; "🙂" is F0 9F 99 82.
        assertEq(_safe(unicode"€5"), "?5");
        assertEq(_safe(unicode"a🙂b"), "a?b");
    }

    function test_length_isCapped() public pure {
        string memory long = "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOP"; // 42 bytes
        assertEq(_safe(long), "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");
        assertEq(bytes(LibJsonText.safeText(long, 4)).length, 4);
    }

    /// @dev Whatever goes in, what comes out is printable ASCII without a
    ///      quote or backslash, and no longer than the cap.
    function testFuzz_outputIsAlwaysSafe(bytes memory raw, uint8 cap) public pure {
        bytes memory out = bytes(LibJsonText.safeText(string(raw), cap));
        assertLe(out.length, cap);
        for (uint256 i; i < out.length; ++i) {
            bytes1 c = out[i];
            assertTrue(c >= 0x20 && c < 0x7F && c != '"' && c != "\\");
        }
    }
}
