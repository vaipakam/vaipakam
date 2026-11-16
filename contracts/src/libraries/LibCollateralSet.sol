// src/libraries/LibCollateralSet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title  LibCollateralSet
 * @author Vaipakam Developer Team
 * @notice The one membership rule of a collection offer's collateral set
 *         (#3328): which NFT token ids a lender's collection offer takes.
 *         Every path that asks "would this offer take this token" (the
 *         borrower's fill, a matcher's pairing, and the views) reads it
 *         here; there is no second copy.
 * @dev    Kinds: `Collection` (any id), `Range` (`low`..`high`, inclusive),
 *         `Listed` (any id under a Merkle root). An exclusion wins over
 *         inclusion. A `Listed` leaf is the OpenZeppelin standard-tree leaf
 *         of one `uint256` id, `keccak256(bytes.concat(keccak256(abi.encode(id))))`,
 *         with pairs hashed in sorted order, so a list built with the
 *         standard tree tooling proves here as it is. The list's count,
 *         hash and label are recorded as the lender gave them and are not
 *         checked on-chain; the published list is checked off-chain.
 */
library LibCollateralSet {
    /// @notice The most ids a Collection or Range offer may exclude.
    uint256 internal constant MAX_EXCLUSIONS = 32;
    /// @notice The most steps a Listed proof may take (enough for about a
    ///         million ids).
    uint256 internal constant MAX_PROOF_DEPTH = 20;
    /// @notice The longest label, in bytes.
    uint256 internal constant MAX_LABEL_BYTES = 64;

    /// @notice A collection offer's set as its lender states it.
    struct SetInput {
        LibVaipakam.CollateralSetKind kind;
        uint256 low;
        uint256 high;
        bytes32 root;
        uint32 listCount;
        bytes32 listHash;
        string label;
        uint256[] exclusions;
    }

    /// @notice The set names no kind.
    error CollateralSetKindMissing();
    /// @notice A range whose low bound is above its high bound.
    error CollateralRangeInverted(uint256 low, uint256 high);
    /// @notice A listed set with no root or no ids.
    error CollateralListEmpty();
    /// @notice More exclusions than allowed.
    error CollateralExclusionsTooMany(uint256 count, uint256 max);
    /// @notice A listed set carries exclusions; leave the ids out of the list.
    error CollateralExclusionsOnList();
    /// @notice The label is longer than allowed.
    error CollateralLabelTooLong(uint256 length, uint256 max);
    /// @notice The membership proof is longer than allowed.
    error CollateralProofTooDeep(uint256 depth, uint256 max);
    /// @notice #3328 — the excluded ids a signed fill presented do not hash
    ///         to the signed `exclusionsHash`.
    error CollateralExclusionsMismatch();

    /// @notice Reverts with the first problem in `input`; returns when the
    ///         set is well formed.
    function validate(SetInput calldata input) internal pure {
        LibVaipakam.CollateralSetKind kind = input.kind;
        if (kind == LibVaipakam.CollateralSetKind.None) revert CollateralSetKindMissing();
        if (kind == LibVaipakam.CollateralSetKind.Range && input.low > input.high) {
            revert CollateralRangeInverted(input.low, input.high);
        }
        if (kind == LibVaipakam.CollateralSetKind.Listed) {
            if (input.root == bytes32(0) || input.listCount == 0) revert CollateralListEmpty();
            if (input.exclusions.length != 0) revert CollateralExclusionsOnList();
        }
        if (input.exclusions.length > MAX_EXCLUSIONS) {
            revert CollateralExclusionsTooMany(input.exclusions.length, MAX_EXCLUSIONS);
        }
        if (bytes(input.label).length > MAX_LABEL_BYTES) {
            revert CollateralLabelTooLong(bytes(input.label).length, MAX_LABEL_BYTES);
        }
    }

    /// @notice Store a validated `input` as `set`. Only the fields the kind
    ///         uses are written.
    function write(LibVaipakam.CollateralSet storage set, SetInput calldata input) internal {
        set.kind = input.kind;
        if (input.kind == LibVaipakam.CollateralSetKind.Range) {
            set.low = input.low;
            set.high = input.high;
        } else if (input.kind == LibVaipakam.CollateralSetKind.Listed) {
            set.root = input.root;
            set.listCount = input.listCount;
            set.listHash = input.listHash;
        }
        set.label = input.label;
        uint256 n = input.exclusions.length;
        for (uint256 i; i < n; ++i) set.exclusions.push(input.exclusions[i]);
    }

    /// @notice Whether `set` takes `tokenId`. A Listed set needs `proof`;
    ///         the other kinds ignore it.
    /// @dev Reverts {CollateralProofTooDeep} for a proof longer than
    ///      {MAX_PROOF_DEPTH}, so the bound is a stated refusal, not a quiet
    ///      "not in the set".
    function contains(LibVaipakam.CollateralSet storage set, uint256 tokenId, bytes32[] calldata proof)
        internal
        view
        returns (bool)
    {
        uint256[] storage ex = set.exclusions;
        uint256 n = ex.length;
        for (uint256 i; i < n; ++i) {
            if (ex[i] == tokenId) return false;
        }
        return _inKind(set.kind, set.low, set.high, set.root, tokenId, proof);
    }

    /// @notice #3328 — {contains} for a SIGNED collection offer, whose set
    ///         lives in the signed terms rather than in storage. The fill
    ///         presents the excluded ids; they must hash to the signed
    ///         `exclusionsHash` (zero when none), or the set is refused.
    function containsSigned(
        LibVaipakam.CollateralSetKind kind,
        uint256 low,
        uint256 high,
        bytes32 root,
        bytes32 exclusionsHash,
        uint256[] calldata exclusions,
        uint256 tokenId,
        bytes32[] calldata proof
    ) internal pure returns (bool) {
        if (exclusionsHashOf(exclusions) != exclusionsHash) revert CollateralExclusionsMismatch();
        uint256 n = exclusions.length;
        for (uint256 i; i < n; ++i) {
            if (exclusions[i] == tokenId) return false;
        }
        return _inKind(kind, low, high, root, tokenId, proof);
    }

    /// @notice The hash a signed offer carries for its excluded ids:
    ///         zero for none, else keccak256 of the ids packed in order.
    function exclusionsHashOf(uint256[] calldata exclusions) internal pure returns (bytes32) {
        return exclusions.length == 0 ? bytes32(0) : keccak256(abi.encodePacked(exclusions));
    }

    /// @notice #3328 — reverts with the first problem in a signed set's
    ///         terms, the checks {validate} makes of an on-chain one (a
    ///         signed set carries no label; its exclusions are checked by
    ///         count when presented, and a Listed set must name none).
    function validateSigned(
        LibVaipakam.CollateralSetKind kind,
        uint256 low,
        uint256 high,
        bytes32 root,
        uint32 listCount,
        bytes32 exclusionsHash,
        uint256 exclusionCount
    ) internal pure {
        if (kind == LibVaipakam.CollateralSetKind.None) revert CollateralSetKindMissing();
        if (kind == LibVaipakam.CollateralSetKind.Range && low > high) revert CollateralRangeInverted(low, high);
        if (kind == LibVaipakam.CollateralSetKind.Listed) {
            if (root == bytes32(0) || listCount == 0) revert CollateralListEmpty();
            if (exclusionsHash != bytes32(0)) revert CollateralExclusionsOnList();
        }
        if (exclusionCount > MAX_EXCLUSIONS) revert CollateralExclusionsTooMany(exclusionCount, MAX_EXCLUSIONS);
    }

    /// @dev The kind's own rule, after exclusions: any id, the inclusive
    ///      range, or a bounded Merkle proof under the root.
    function _inKind(
        LibVaipakam.CollateralSetKind kind,
        uint256 low,
        uint256 high,
        bytes32 root,
        uint256 tokenId,
        bytes32[] calldata proof
    ) private pure returns (bool) {
        if (kind == LibVaipakam.CollateralSetKind.None) return false;
        if (kind == LibVaipakam.CollateralSetKind.Collection) return true;
        if (kind == LibVaipakam.CollateralSetKind.Range) return tokenId >= low && tokenId <= high;
        if (proof.length > MAX_PROOF_DEPTH) revert CollateralProofTooDeep(proof.length, MAX_PROOF_DEPTH);
        return MerkleProof.verifyCalldata(proof, root, leaf(tokenId));
    }

    /// @notice The Listed-set leaf of `tokenId` (OpenZeppelin standard tree).
    function leaf(uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(tokenId))));
    }
}
