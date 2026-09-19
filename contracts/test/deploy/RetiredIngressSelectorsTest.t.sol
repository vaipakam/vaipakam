// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {RefreshAllFacetsInPlace} from "../../script/RefreshAllFacetsInPlace.s.sol";
import {RewardIngressFacet} from "../../src/facets/RewardIngressFacet.sol";
import {REMIT_RECEIVER_WIRE_GENERATION} from "../../src/crosschain/RewardRemittanceReceiver.sol";

/**
 * @title RetiredIngressSelectorsTest
 * @notice #1566 transport epochs PR 3b (Codex #2232 r1) — the mirror ingress
 *         has been widened four times, and each widening RETIRES a selector
 *         that must be Removed from every live Diamond.
 *
 *         Leaving one routed is silent and severe rather than merely stale: the
 *         retired selector still points at the PREVIOUS facet bytecode, so a
 *         receiver that has not been upgraded keeps calling it and its
 *         deliveries SUCCEED against stale code — skipping whatever the new
 *         ingress added, with nothing reporting an error. The transport-epoch
 *         widening would have been bypassed on every existing mirror exactly
 *         this way.
 *
 *         The refresh script has carried that removal list since the first
 *         widening and NO test has ever covered it, which is how the fourth
 *         omitted itself. This file is the guard for the CLASS: it pins the
 *         current ingress selectors against the retired list, so the next
 *         author to widen a signature fails here and is told which predecessor
 *         to retire.
 */
contract RetiredIngressSelectorsTest is Test {
    RefreshAllFacetsInPlace internal script;

    function setUp() public {
        script = new RefreshAllFacetsInPlace();
    }

    /// @dev The list is what the refresh Removes; these are the exact
    ///      signatures, so a silent truncation or reorder is loud.
    function test_RetiredList_HoldsEveryPastIngressSignature() public view {
        string[] memory sigs = script.retiredIngressSignatures();
        assertEq(sigs.length, 5, "one entry per retirement; add yours rather than replacing one");
        assertEq(
            sigs[3],
            "onRewardBudgetReceived(address,uint256,uint256[],uint256,uint256,address,uint256,uint256,bytes32)",
            "the 9-arg ingress the transport epochs retired"
        );
        assertEq(
            sigs[4],
            "onCompensationBudgetReceived(address,uint256,uint256,uint256,uint256,address,uint256,uint256,uint64,uint32,uint64,uint64)",
            "the 12-arg compensation ingress"
        );
    }

    /// @dev THE assertion this file exists for. Every retired signature must
    ///      hash to something OTHER than a currently-routed ingress selector —
    ///      a retired entry colliding with a live one would have the refresh
    ///      Remove a selector it needs.
    ///
    ///      And the current selectors are PINNED. If you changed an ingress
    ///      signature, this fails: add the signature you just retired to
    ///      `RefreshAllFacetsInPlace.retiredIngressSignatures()`, then update
    ///      the pin below. That sequence is the whole point — the pin is what
    ///      makes the omission impossible to ship quietly.
    function test_CurrentIngressSelectors_ArePinned_AndNotInTheRetiredList() public view {
        bytes4 currentBudget = RewardIngressFacet.onRewardBudgetReceived.selector;
        bytes4 currentComp = RewardIngressFacet.onCompensationBudgetReceived.selector;

        assertEq(
            currentBudget,
            bytes4(
                keccak256(
                    "onRewardBudgetReceived(address,uint256,uint256[],uint256,uint256,address,uint256,uint256,bytes32,bool)"
                )
            ),
            "budget ingress signature moved - retire the previous one first"
        );
        assertEq(
            currentComp,
            bytes4(
                keccak256(
                    "onCompensationBudgetReceived(address,uint256,uint256,uint256,uint256,address,uint256,uint256,uint64,uint32,uint64,uint64,bytes32)"
                )
            ),
            "compensation ingress signature moved - retire the previous one first"
        );

        string[] memory sigs = script.retiredIngressSignatures();
        for (uint256 i; i < sigs.length; ++i) {
            bytes4 retired = bytes4(keccak256(bytes(sigs[i])));
            assertTrue(retired != currentBudget, "a retired entry collides with the live budget ingress");
            assertTrue(retired != currentComp, "a retired entry collides with the live compensation ingress");
        }
    }

    /// @dev The receiver's generation must advance with the ingress, or the
    ///      refresh's standalone upgrade probe reads a current-looking proxy
    ///      and leaves it on the old implementation. That probe is the second
    ///      layer behind the selector removal, and it is gated on this figure
    ///      alone — a bump is not optional bookkeeping.
    function test_ReceiverGeneration_AdvancedWithTheWidenedIngress() public pure {
        assertEq(
            REMIT_RECEIVER_WIRE_GENERATION,
            5,
            "the receiver changed, so its generation advances or the refresh skips the upgrade"
        );
    }
}
