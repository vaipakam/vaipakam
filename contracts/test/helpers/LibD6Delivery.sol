// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {RemitWire} from "../../src/crosschain/RemitWire.sol";
import {RewardIngressFacet} from "../../src/facets/RewardIngressFacet.sol";
import {RewardEpochFacet} from "../../src/facets/RewardEpochFacet.sol";
import {MerkleFixture} from "../mocks/MerkleFixture.sol";
import {RewardRemittanceLensFacet} from "../../src/facets/RewardRemittanceLensFacet.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {RewardCustodyFacet} from "../../src/facets/RewardCustodyFacet.sol";

/// @title  LibD6Delivery — the one test-side way to land a budget delivery.
/// @notice The d6 (rooted) wire is the only budget shape the remittance
///         receiver accepts, so every suite that needs a budget delivery on a
///         mirror lands it here, exactly as the registered receiver would:
///         the root over the list's chunks, the extent, the split and the era,
///         through `onRewardBudgetReceivedD6`. Before the pre-d6 retirement
///         each suite carried its own call into the flat-list ingress; those
///         copies are what this library replaces.
/// @dev    Internal library calls are inlined, so the ingress sees the TEST
///         CONTRACT as `msg.sender`. A suite therefore registers itself as the
///         remittance receiver (or pranks the receiver) before calling
///         {deliver}, as it did for the retired ingress.
library LibD6Delivery {
    /// @notice A d6 delivery's inputs. `fresh` is the fresh component the wire
    ///         states; on an activated custody the two shares must add up to
    ///         `amount` (the ingress refuses a split that is not whole).
    struct Delivery {
        address token;
        uint256 amount;
        uint256[] dayIds;
        uint256 sourceChainId;
        uint256 remitId;
        address remitter;
        uint256 recycled;
        uint256 fresh;
        bytes32 messageId;
        uint64 era;
    }

    /// @notice The packet stamp the ingress records for a delivery.
    function packetHash(uint256 sourceChainId, bytes32 messageId) internal pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, messageId));
    }

    /// @notice Land `d` on the rooted ingress. Returns the packet stamp and
    ///         the chunk leaves, which {indexChunk} / {indexAll} prove against.
    function deliver(address diamond, Delivery memory d) internal returns (bytes32 h, bytes32[] memory leaves) {
        leaves = RemitWire.d6Chunks(d.dayIds);
        RewardIngressFacet(diamond).onRewardBudgetReceivedD6(
            d.token,
            d.amount,
            RemitWire.d6Root(leaves),
            d.dayIds.length,
            leaves.length,
            d.sourceChainId,
            d.remitId,
            d.remitter,
            d.recycled,
            d.fresh,
            d.messageId,
            d.era
        );
        h = packetHash(d.sourceChainId, d.messageId);
    }

    /// @notice A whole-fresh delivery in the live era, the shape most suites need.
    function deliverFresh(
        address diamond,
        address token,
        uint256 amount,
        uint256[] memory dayIds,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        bytes32 messageId
    ) internal returns (bytes32 h, bytes32[] memory leaves) {
        return deliver(
            diamond,
            Delivery({
                token: token,
                amount: amount,
                dayIds: dayIds,
                sourceChainId: sourceChainId,
                remitId: remitId,
                remitter: remitter,
                recycled: 0,
                fresh: amount,
                messageId: messageId,
                era: 0
            })
        );
    }

    /// @notice Index chunk `c` of a delivered epoch (no hints). Permissionless.
    function indexChunk(address diamond, bytes32 h, uint256[] memory dayIds, bytes32[] memory leaves, uint256 c)
        internal
        returns (uint32 indexedTotal)
    {
        return RewardEpochFacet(diamond).materializeTransportBatchChunk(
            h,
            c,
            MerkleFixture.chunk(dayIds, c, RemitWire.D6_CHUNK_DAYS),
            MerkleFixture.proof(leaves, c),
            new bytes32[](0),
            new bytes32[](0)
        );
    }

    /// @notice Index every chunk of a delivered epoch, in order.
    function indexAll(address diamond, bytes32 h, uint256[] memory dayIds, bytes32[] memory leaves) internal {
        for (uint256 c; c < leaves.length; ++c) indexChunk(diamond, h, dayIds, leaves, c);
    }

    /// @notice Prove chunk `c` of a delivery that holds NO epoch (it landed
    ///         before custody activation) to the day-delivery gate.
    function proveChunk(address diamond, bytes32 h, uint256[] memory dayIds, bytes32[] memory leaves, uint256 c)
        internal
    {
        RewardEpochFacet(diamond).proveDeliveryDayChunk(
            h, c, MerkleFixture.chunk(dayIds, c, RemitWire.D6_CHUNK_DAYS), MerkleFixture.proof(leaves, c)
        );
    }

    /// @notice Prove every chunk of a no-epoch delivery, in order.
    function proveAll(address diamond, bytes32 h, uint256[] memory dayIds, bytes32[] memory leaves) internal {
        for (uint256 c; c < leaves.length; ++c) proveChunk(diamond, h, dayIds, leaves, c);
    }

    /// @notice A whole-fresh delivery whose split is then taken away, standing
    ///         in an epoch that is NOT attested. The d6 ingress attests every
    ///         epoch from its own wire at landing, so no production path
    ///         reaches this state; suites that pin what the planner or staging
    ///         does with an unattested epoch stand it in here, and {attest}
    ///         later writes the split the way an attestation would.
    function deliverUnattested(
        address diamond,
        address token,
        uint256 amount,
        uint256[] memory dayIds,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        bytes32 messageId
    ) internal returns (bytes32 h, bytes32[] memory leaves) {
        (h, leaves) = deliverFresh(diamond, token, amount, dayIds, sourceChainId, remitId, remitter, messageId);
        TestMutatorFacet(diamond).clearPacketAttestedRaw(h);
    }

    /// @notice Attest the split of receipt (`remitter`, `remitId`)'s packet,
    ///         scaled to what landed and floored, as a wire attestation records
    ///         it. Test-only: writes the caps through the mutator.
    function attest(address diamond, address remitter, uint256 remitId, uint256 fresh, uint256 recycled) internal {
        RewardRemittanceLensFacet lens = RewardRemittanceLensFacet(diamond);
        bytes32 h = lens.getReceivedRemit(remitter, remitId).packetHash;
        uint256 landed = lens.getIngressPacket(h).actualReceived;
        uint256 whole = fresh + recycled;
        TestMutatorFacet(diamond).setPacketAttestedCapsRaw(h, (landed * fresh) / whole, (landed * recycled) / whole);
    }

    /// @notice Index every chunk of a delivered epoch, from its day list alone.
    function indexAllDays(address diamond, bytes32 h, uint256[] memory dayIds) internal {
        indexAll(diamond, h, dayIds, RemitWire.d6Chunks(dayIds));
    }

    /// @notice Counted LIVE fresh funding of `amount`, the tokens already at
    ///         the Diamond. Before custody activation a whole-fresh delivery
    ///         is exactly that (the typed-ledger path counts it). On an
    ///         activated custody a budget delivery opens a transport epoch and
    ///         credits no live row, so the funding is stood in through the same
    ///         library write a live-era compensation lands through: the tokens
    ///         move into the holder under the deficit split.
    function liveFresh(
        address diamond,
        address token,
        uint256 amount,
        uint256[] memory dayIds,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        bytes32 messageId
    ) internal {
        if (RewardCustodyFacet(diamond).rewardCustodyActivated()) {
            TestMutatorFacet(diamond).relocateFreshIngressRaw(amount);
        } else {
            deliverFresh(diamond, token, amount, dayIds, sourceChainId, remitId, remitter, messageId);
        }
    }
}
