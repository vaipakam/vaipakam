// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibFallbackGate} from "../../src/libraries/LibFallbackGate.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {Vm} from "forge-std/Vm.sol";

/// @title  LibTestFallbackGate
/// @notice #3538 — a terminal forced sale whose routes all fail enters the
///         in-kind fallback only when an earlier failed sale of the loan is
///         at least `LibFallbackGate.MIN_SPAN` old. A test whose subject is
///         what the fallback does, not how it opens, records that earlier
///         failure here, usually without moving the clock, the way
///         `LibTestTiming.backdateTerms` does for an offer's age. Needs the
///         test Diamond to route `TestMutatorFacet.setFallbackGate`.
///         A test whose clock is still inside the first {MIN_SPAN} after the
///         epoch (forge starts near 1) cannot hold a failure that old, so the
///         clock is moved to the span first; that is the only time it moves.
library LibTestFallbackGate {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Makes the next failed sale of `loanId` open the fallback.
    function open(address diamond, uint256 loanId) internal {
        if (block.timestamp < LibFallbackGate.MIN_SPAN) VM.warp(LibFallbackGate.MIN_SPAN);
        uint40 at = uint40(block.timestamp - LibFallbackGate.MIN_SPAN);
        TestMutatorFacet(diamond).setFallbackGate(loanId, LibVaipakam.FallbackGate(at, at, 1));
    }
}
