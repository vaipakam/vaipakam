// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  TotalRead
 * @notice The one way the sanctions scripts read a no-argument view from a
 *         contract they found through a record rather than deployed in the
 *         same run: a read that ALWAYS returns, with `ok == false` for any
 *         answer that is not exactly one well-formed value.
 * @dev    #2443. A high-level call cannot be made total. A Solidity `try`
 *         does not catch a failure to DECODE the answer (an empty reply, a
 *         word too wide for the type), and a second call made inside a `try`
 *         body is not covered by its `catch` at all. A recorded address can
 *         name anything — a stale artifact, another contract sharing one
 *         selector — so a script deciding "reuse this, or not" from such a
 *         read would stop on the malformed case instead of answering "not
 *         reusable". Every read here is a low-level `staticcall` judged in
 *         one place: no code, a revert, any reply but one 32-byte word, or a
 *         word out of the type's range is `ok == false`, never a revert.
 *
 *         What a failed read MEANS stays with the caller: "not reusable",
 *         "does not serve", "not identified". The library only guarantees
 *         that the caller gets to decide.
 */
library TotalRead {
    /// @notice `target.<selector>()` as one 32-byte word.
    function wordOf(address target, bytes4 selector) internal view returns (bool ok, uint256 value) {
        if (target.code.length == 0) return (false, 0);
        (bool success, bytes memory ret) = target.staticcall(abi.encodeWithSelector(selector));
        if (!success || ret.length != 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    /// @notice `target.<selector>()` as an address: one word with no bits
    ///         above the low 160.
    function addressOf(address target, bytes4 selector) internal view returns (bool ok, address value) {
        (bool read, uint256 word) = wordOf(target, selector);
        if (!read || word > type(uint160).max) return (false, address(0));
        return (true, address(uint160(word)));
    }

    /// @notice `target.<selector>()` as a bool: one word that is 0 or 1.
    function boolOf(address target, bytes4 selector) internal view returns (bool ok, bool value) {
        (bool read, uint256 word) = wordOf(target, selector);
        if (!read || word > 1) return (false, false);
        return (true, word == 1);
    }
}
