// src/seaport/IListingExecutorValidator.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IListingExecutorValidator
 * @author Vaipakam Developer Team
 * @notice T-086 step 7: the executor's vault-facing validation
 *         surface. The vault's ERC-1271 `isValidSignature` delegates
 *         here to decide whether a given Seaport `orderHash` was
 *         authorised by the diamond and is still fillable.
 *
 *         Kept as a separate interface (not folded into
 *         {IListingExecutorRecorder} which is the diamond-side
 *         orderHash management surface) so the vault depends only
 *         on the narrow validator API and isn't exposed to the
 *         conduit-allow-list / orderHash-record entries that aren't
 *         the vault's concern.
 */
interface IListingExecutorValidator {
    /// @notice True if the executor has the orderHash recorded with
    ///         an approved conduit AND the associated loan is still
    ///         Active. Equivalent to {isValidSignature}'s positive
    ///         path, in plain-bool shape.
    function isOrderValid(bytes32 hash) external view returns (bool);
}
