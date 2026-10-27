// src/libraries/LibJsonText.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title LibJsonText
 * @notice Makes a string that a third party controls safe to place inside a
 *         JSON string value of on-chain metadata (#2750).
 * @dev    A position NFT's `tokenURI` carries the loan's token symbols, which
 *         the token's own contract chooses. A symbol holding a quote, a
 *         backslash or a control character would end the JSON string early
 *         and let the token inject fields (a misleading name, value or link)
 *         that marketplaces render. Rather than escape, this keeps only
 *         printable ASCII other than `"` and `\`, replaces every other
 *         character with one `?` (a multi-byte UTF-8 character becomes one
 *         `?`, never a split byte sequence), and caps the length, so the
 *         result is always valid JSON string content of bounded size. A
 *         symbol is an identifier, not prose, and the token's address is
 *         shown beside it for anyone who needs the exact contract.
 */
library LibJsonText {
    /// @notice The longest symbol a position NFT's metadata renders.
    uint256 internal constant MAX_SYMBOL_BYTES = 32;

    /// @dev The mark that stands in for every character removed: `?`.
    bytes1 private constant MARK = 0x3f;

    /// @notice `raw` with every character that is not printable ASCII (or is
    ///         `"` or `\`) replaced by `?`, cut to at most `maxBytes` bytes.
    ///         Empty input stays empty.
    function safeText(string memory raw, uint256 maxBytes) internal pure returns (string memory) {
        bytes memory input = bytes(raw);
        uint256 cap = input.length < maxBytes ? input.length : maxBytes;
        bytes memory out = new bytes(cap);
        uint256 n;
        for (uint256 i; i < input.length && n < cap; ++i) {
            bytes1 c = input[i];
            // A UTF-8 continuation byte belongs to the character whose lead
            // byte already became `?`, so it adds nothing.
            if (c >= 0x80 && c < 0xC0) continue;
            bool printable = c >= 0x20 && c < 0x7F && c != '"' && c != "\\";
            out[n++] = printable ? c : MARK;
        }
        // Copy out what was written (the buffer was sized for the cap). A
        // second short copy rather than shrinking the length in assembly:
        // this runs only in metadata views.
        bytes memory trimmed = new bytes(n);
        for (uint256 j; j < n; ++j) trimmed[j] = out[j];
        return string(trimmed);
    }
}
