// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {RewardIngressFacet} from "../../src/facets/RewardIngressFacet.sol";
import {RewardRemittanceLensFacet} from "../../src/facets/RewardRemittanceLensFacet.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {RewardCustodyFacet} from "../../src/facets/RewardCustodyFacet.sol";

/// @title  LibD8Delivery — the one test-side way to land a budget delivery.
/// @notice The d8 wire is the only budget shape the remittance receiver
///         accepts (#2828 retired d7's rooted, chunked day list): the ONE
///         funded day travels inline, so every suite that needs a budget
///         delivery on a mirror lands it here, exactly as the registered
///         receiver would — the day, the split, the era and the day's part and
///         whole, through `onRewardBudgetReceivedD8`. The mirror stamps the
///         day, counts the part toward it and, on an activated custody, admits
///         and indexes the epoch in that one call, so there is no follow-up
///         index or proof step for a suite to drive.
/// @dev    Internal library calls are inlined, so the ingress sees the TEST
///         CONTRACT as `msg.sender`. A suite therefore registers itself as the
///         remittance receiver (or pranks the receiver) before calling
///         {deliver}.
library LibD8Delivery {
    /// @notice A delivery's inputs. `fresh` is the fresh component the wire
    ///         states; the two shares must add up to `amount` (the ingress
    ///         refuses a split that is not whole).
    struct Delivery {
        address token;
        uint256 amount;
        uint256 dayId;
        uint256 sourceChainId;
        uint256 remitId;
        address remitter;
        uint256 recycled;
        uint256 fresh;
        bytes32 messageId;
        uint64 era;
    }

    /// @notice #918 — what a delivery declares about its day: the part it
    ///         carries (unscaled, as Base sent it) and the day's whole slice,
    ///         per component.
    struct Part {
        uint256 declaredTotal;
        uint256 declaredRecycled;
        uint256 wholeFresh;
        uint256 wholeRecycled;
    }

    /// @notice The part a whole-day, one-part delivery declares: everything
    ///         it carries, which is the day's whole.
    function wholeDay(Delivery memory d) internal pure returns (Part memory) {
        return Part({
            declaredTotal: d.fresh + d.recycled,
            declaredRecycled: d.recycled,
            wholeFresh: d.fresh,
            wholeRecycled: d.recycled
        });
    }

    /// @notice The packet stamp the ingress records for a delivery.
    function packetHash(uint256 sourceChainId, bytes32 messageId) internal pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, messageId));
    }

    /// @notice Land `d` as its day's ONE part. Returns the packet stamp.
    function deliver(address diamond, Delivery memory d) internal returns (bytes32 h) {
        return deliverPart(diamond, d, wholeDay(d));
    }

    /// @notice #918 — land `d` as part `part` of its day.
    function deliverPart(address diamond, Delivery memory d, Part memory part) internal returns (bytes32 h) {
        _ingress(diamond, d, part);
        h = packetHash(d.sourceChainId, d.messageId);
    }

    /// @dev The fourteen-argument ingress call, encoded in two halves: every
    ///      argument is a static type, so the halves concatenate to exactly the
    ///      calldata a high-level call would build, while neither encoder holds
    ///      all fourteen values on the stack. A revert is re-thrown verbatim,
    ///      so `vm.expectRevert` reads it as it would a high-level call's.
    function _ingress(address diamond, Delivery memory d, Part memory part) private {
        bytes memory data = abi.encodePacked(
            RewardIngressFacet.onRewardBudgetReceivedD8.selector,
            abi.encode(d.token, d.amount, d.dayId, d.sourceChainId, d.remitId, d.remitter, d.recycled),
            abi.encode(
                d.fresh,
                d.messageId,
                uint256(d.era),
                part.declaredTotal,
                part.declaredRecycled,
                part.wholeFresh,
                part.wholeRecycled
            )
        );
        (bool ok, bytes memory ret) = diamond.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    /// @notice A whole-fresh delivery in the live era, the shape most suites need.
    function deliverFresh(
        address diamond,
        address token,
        uint256 amount,
        uint256 dayId,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        bytes32 messageId
    ) internal returns (bytes32 h) {
        return deliver(
            diamond,
            Delivery({
                token: token,
                amount: amount,
                dayId: dayId,
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

    /// @notice A whole-fresh delivery whose split is then taken away, standing
    ///         in an epoch that is NOT attested. The ingress attests every
    ///         epoch from its own wire at landing, so no production path
    ///         reaches this state; suites that pin what the planner or staging
    ///         does with an unattested epoch stand it in here, and {attest}
    ///         later writes the split the way an attestation would.
    function deliverUnattested(
        address diamond,
        address token,
        uint256 amount,
        uint256 dayId,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        bytes32 messageId
    ) internal returns (bytes32 h) {
        h = deliverFresh(diamond, token, amount, dayId, sourceChainId, remitId, remitter, messageId);
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
        uint256 dayId,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        bytes32 messageId
    ) internal {
        if (RewardCustodyFacet(diamond).rewardCustodyActivated()) {
            TestMutatorFacet(diamond).relocateFreshIngressRaw(amount);
        } else {
            deliverFresh(diamond, token, amount, dayId, sourceChainId, remitId, remitter, messageId);
        }
    }
}
