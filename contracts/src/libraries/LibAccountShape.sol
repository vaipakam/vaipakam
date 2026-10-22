// src/libraries/LibAccountShape.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibAccountShape
 * @author Vaipakam Developer Team
 * @notice #2617 — the one rule for whether an address is a PERSON'S OWN
 *         ACCOUNT (an externally owned account), as opposed to a contract.
 *
 * @dev    An EOA that has signed an EIP-7702 authorization carries code: the
 *         23-byte delegation designator `0xef0100 ‖ <delegate address>`. It is
 *         still the same person's account, controlled by the same private key,
 *         so a rule written as `code.length == 0` misreads it as a contract.
 *         The designator cannot be mistaken for a deployed contract: EIP-3541
 *         refuses new code starting with `0xef`, and EIP-7702 installs only a
 *         well-formed designator, so a 23-byte account whose code starts
 *         `0xef0100` is a delegated EOA and nothing else.
 *
 *         Use this wherever a decision depends on "is this a person's own
 *         account" (the RL-1 reward-delivery default is the case today).
 *         It is NOT a substitute for "does this address have code a call can
 *         reach": a delegated EOA executes its delegate's code, so a check that
 *         an admin-set address is a contract keeps reading `code.length`.
 *
 *         `internal`, so it inlines into each caller. The code is copied only
 *         when its length is exactly the designator's, so a large contract
 *         costs one EXTCODESIZE and nothing more.
 */
library LibAccountShape {
    /// @dev The EIP-7702 delegation designator's prefix and full length.
    bytes3 internal constant DELEGATION_PREFIX = 0xef0100;
    uint256 internal constant DELEGATION_LENGTH = 23;

    /// @notice True when `account` is an EOA: no code at all, or exactly an
    ///         EIP-7702 delegation designator.
    function isEoaStyle(address account) internal view returns (bool) {
        uint256 len = account.code.length;
        if (len == 0) return true;
        if (len != DELEGATION_LENGTH) return false;
        return bytes3(account.code) == DELEGATION_PREFIX;
    }
}
