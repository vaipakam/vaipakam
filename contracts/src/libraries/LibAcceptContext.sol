// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibAcceptContext
 * @author Vaipakam Developer Team
 * @notice The acceptor of an accept in flight, held in transient storage for
 *         the rest of that transaction (#3205 part 2). The vault outflow
 *         policy reads it to derive a new loan's borrower when it delivers
 *         the net principal, so the delivery names no recipient of its own.
 * @dev    Keyed by offer id: one transaction may run several accepts (a
 *         match, an auto-linked sale), each writing its own key before its
 *         delivery. Transient storage clears itself when the transaction ends.
 */
library LibAcceptContext {
    bytes32 private constant BASE = keccak256("vaipakam.accept.acceptor");

    function setAcceptor(uint256 offerId, address acceptor) internal {
        bytes32 key = keccak256(abi.encode(BASE, offerId));
        assembly ("memory-safe") {
            tstore(key, acceptor)
        }
    }

    function acceptor(uint256 offerId) internal view returns (address a) {
        bytes32 key = keccak256(abi.encode(BASE, offerId));
        assembly ("memory-safe") {
            a := tload(key)
        }
    }
}
