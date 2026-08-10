// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ICrossChainMessenger} from "../crosschain/ICrossChainMessenger.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LibRewardRemitDispatch — the remit-dispatch helpers BOTH remit
 *        facets share.
 *
 * @notice #1434 P2-w4 — hoisted out of {RewardRemittanceFacet} when the w4
 *         compensation surface pushed it past EIP-170 and the manual +
 *         supplemental dispatchers moved to
 *         {RewardCompensationDispatchFacet}: the token-bearing dispatch
 *         tail, the NET fresh-headroom figure, and the R6 gate pair are
 *         needed on both sides of that split, and a private copy in each
 *         facet is exactly the divergence the one-implementation rule
 *         forbids. Internal-library inlining duplicates BYTECODE per
 *         calling facet (fine — EIP-170 is per facet) while keeping ONE
 *         source of truth.
 */
library LibRewardRemitDispatch {
    /// @dev Same signatures as the facet-declared originals — the error
    ///      SELECTOR derives from the signature alone, so consumers decode
    ///      identically wherever the revert originates.
    error InsufficientRemittanceFee(uint256 provided, uint256 required);
    error RemittanceRefundFailed();

    using SafeERC20 for IERC20;

    /// @dev Mirrors the facets' remit dest-gas budget — one constant, both
    ///      dispatch paths.
    uint256 internal constant REWARD_BUDGET_DEST_GAS_LIMIT = 300_000;

    /**
     * @dev #1222 M3 B2-d2 (Codex #1426 r6) — NET fresh headroom for a remit
     *      that will retire `retires` of the outstanding armed-fresh
     *      commitments: `CAP − remitted − paid − (outstandingFresh −
     *      retires)`, floored at zero. The gross `CAP − remitted − paid`
     *      figure ignores commitments other days (and Base-side claims)
     *      still hold against the pool — after an operator RELEASE (which
     *      keeps the sent amount counted while restoring the obligation),
     *      the gross check would let a re-remit push total issuance past
     *      the 69M cap by exactly the stranded amount, terminally
     *      truncating later claims. Healthy-path no-op: finalize reserves
     *      commitments within remaining headroom.
     */
    function freshHeadroomNet(
        LibVaipakam.Storage storage s,
        uint256 retires
    ) internal view returns (uint256 remaining) {
        uint256 used = s.rewardBudgetRemittedGlobal + s.interactionPoolPaidOut;
        remaining = used >= LibVaipakam.VPFI_INTERACTION_POOL_CAP
            ? 0
            : LibVaipakam.VPFI_INTERACTION_POOL_CAP - used;
        uint256 outFresh = s.outstandingCommitFresh;
        uint256 encumbered = outFresh > retires ? outFresh - retires : 0;
        remaining = remaining > encumbered ? remaining - encumbered : 0;
    }

    /**
     * @dev The ONE token-bearing remit dispatch tail (d5 batch/manual + P2
     *      compensation): approve exactly `total`, quote + send over the
     *      CCIP token path, annotate the reservation with the returned
     *      message id, refund the fee surplus. Shared so the two wire
     *      generations can never diverge on fee handling or the messageId
     *      binding.
     */
    function dispatchRemitTail(
        LibVaipakam.Storage storage s,
        address vpfi,
        address messenger,
        uint32 dstChainId,
        bytes memory payload,
        uint256 total,
        uint256 remitId
    ) internal returns (bytes32 messageId) {
        IERC20(vpfi).forceApprove(messenger, total);
        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] =
            ICrossChainMessenger.TokenAmount({token: vpfi, amount: total});

        uint256 fee = ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId,
            payload,
            tokens,
            REWARD_BUDGET_DEST_GAS_LIMIT
        );
        if (msg.value < fee) revert InsufficientRemittanceFee(msg.value, fee);

        messageId = ICrossChainMessenger(messenger).sendMessage{value: fee}(
            dstChainId,
            payload,
            tokens,
            REWARD_BUDGET_DEST_GAS_LIMIT
        );

        // slither-disable-start reentrancy-no-eth,reentrancy-benign
        // Deliberate write-after-call: records the send's OWN returned id
        // (unknowable earlier); messenger is the admin-wired CCIP adapter and
        // every caller is nonReentrant.
        s.remitReservations[remitId].ccipMessageId = messageId;
        s.remitIdByCcipMessageId[messageId] = remitId;
        // slither-disable-end reentrancy-no-eth,reentrancy-benign

        // Refund any fee overpayment to the caller (operator/keeper EOA).
        if (msg.value > fee) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - fee}("");
            if (!ok) revert RemittanceRefundFailed();
        }
    }

    /// @dev #1434 P2-w4 (§5.1/§5.4) — set the R6 gate + the enumerable
    ///      outstanding-chain index (pushed here, swap-removed on clear;
    ///      the gate being 0 before every set keeps the index
    ///      duplicate-free).
    function setCompensationGate(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 remitId
    ) internal {
        s.compensationOutstanding[dstChainId] = remitId;
        s.compensationOutstandingChains.push(dstChainId);
    }

    /// @dev #1434 P2-w4 — clear the gate + swap-remove the chain from the
    ///      enumerable index.
    function clearCompensationGate(
        LibVaipakam.Storage storage s,
        uint32 dstChainId
    ) internal {
        s.compensationOutstanding[dstChainId] = 0;
        uint32[] storage chains = s.compensationOutstandingChains;
        uint256 n = chains.length;
        for (uint256 i; i < n; ) {
            if (chains[i] == dstChainId) {
                chains[i] = chains[n - 1];
                chains.pop();
                break;
            }
            unchecked { ++i; }
        }
    }
}
