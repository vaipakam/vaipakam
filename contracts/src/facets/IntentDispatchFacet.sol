// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibSwapToRepayIntentSettlement} from
    "../libraries/LibSwapToRepayIntentSettlement.sol";
import {LibTreasuryBuyback} from "../libraries/LibTreasuryBuyback.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibFillLock} from "../libraries/LibFillLock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IPreInteraction} from
    "@1inch/limit-order-protocol/contracts/interfaces/IPreInteraction.sol";
import {IPostInteraction} from
    "@1inch/limit-order-protocol/contracts/interfaces/IPostInteraction.sol";
import {IOrderMixin} from
    "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";

/**
 * @title IntentDispatchFacet — T-087 Sub 3.B
 *
 * Owns the three 1inch LOP v4 hooks the diamond exposes to Fusion:
 * `preInteraction`, `postInteraction`, and `isValidSignature`. Each
 * arm reads the per-order discriminator
 * `s.orderHashKind[orderHash]` stamped at commit time and dispatches
 * to the matching library:
 *
 *   ORDER_KIND_SWAP_TO_REPAY → LibSwapToRepayIntentSettlement
 *                              (the T-090 v1.1 GA path,
 *                              extracted from
 *                              SwapToRepayIntentFacet in this PR)
 *   ORDER_KIND_BUYBACK       → LibTreasuryBuyback
 *                              (the new buyback fill path)
 *
 * Pre-Sub-3.B the three hooks lived on `SwapToRepayIntentFacet`
 * directly; they're now owned exclusively by this dispatcher so the
 * same Fusion callback signature can route to either intent kind
 * without the facets fighting for the selectors.
 *
 * #1566 slice 3 -- the fill-state lock ({LibFillLock}). The pre-hook
 * opens it FIRST, for both order kinds (owner decision O3), before
 * any dispatch and so before the swap arm pulls its lot out of the
 * borrower's vault; the post-hook closes it FIRST, then takes the
 * Diamond's reentrancy guard for the settlement. Between the two the
 * Diamond refuses every entry but its own self-calls and the
 * post-hook ({VaipakamDiamond}'s fallback). The pre-hook is
 * pause-gated (O6): a pause stops fills, and an order stays live
 * until its deadline. The swap arm's `makingAmount` and
 * `takingAmount` are now passed through: the pre-hook pulls exactly
 * the committed lot, the post-hook settles exactly what the taker
 * delivered.
 *
 * Refresh together with `SwapToRepayIntentFacet` (one behaviour
 * across the commit and the hooks).
 */
contract IntentDispatchFacet is
    DiamondPausable,
    IPreInteraction,
    IPostInteraction,
    IERC1271
{
    // ─── Errors ──────────────────────────────────────────────────────

    /// @notice The orderHash was never committed (or has already
    ///         been settled / expired and its kind cleared) — the
    ///         dispatcher has no library to route to. Distinct from
    ///         each library's own "unknown order" error so the
    ///         caller can tell whether the dispatcher rejected
    ///         outright or a library rejected after dispatch.
    error UnknownOrderKind(bytes32 orderHash);

    // ─── 1inch hooks — dispatched by orderHashKind ───────────────────

    /// @inheritdoc IPreInteraction
    /// @dev The fill lock opens before anything else, so a re-entry from inside the swap arm's own
    ///      vault withdraw is already refused (design: "set before the pull"). Every library arm
    ///      checks that the caller is the order's pinned LOP; a stray caller reverts there, and the
    ///      revert undoes the lock with it.
    function preInteraction(
        IOrderMixin.Order calldata /* order */,
        bytes calldata /* extension */,
        bytes32 orderHash,
        address /* taker */,
        uint256 makingAmount,
        uint256 /* takingAmount */,
        uint256 /* remainingMakingAmount */,
        bytes calldata /* extraData */
    ) external override whenNotPaused {
        LibFillLock.acquire(orderHash);
        bytes32 kind = LibVaipakam.storageSlot().orderHashKind[orderHash];
        if (kind == LibVaipakam.ORDER_KIND_SWAP_TO_REPAY) {
            LibSwapToRepayIntentSettlement.preInteractionImpl(orderHash, makingAmount);
        } else if (kind == LibVaipakam.ORDER_KIND_BUYBACK) {
            // Codex Sub 3.B round-1 P1 #2 — VPFI received needs a
            // pre-fill balance baseline so postInteraction can
            // measure the delta. The library applies the LOP auth
            // check inside (round-1 P1 #1).
            LibTreasuryBuyback.preInteractionImpl(orderHash);
        } else {
            revert UnknownOrderKind(orderHash);
        }
    }

    /// @inheritdoc IPostInteraction
    /// @dev Closes the fill lock its own pre-hook opened (any other hash, or no lock, reverts), then
    ///      holds the Diamond's reentrancy guard for the settlement -- the guard `nonReentrant` took
    ///      before slice 3, now taken after the close because the Diamond's entry point admits this
    ///      selector mid-fill.
    function postInteraction(
        IOrderMixin.Order calldata /* order */,
        bytes calldata /* extension */,
        bytes32 orderHash,
        address /* taker */,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 /* remainingMakingAmount */,
        bytes calldata /* extraData */
    ) external override {
        LibFillLock.release(orderHash);
        LibReentrancyGuard._enter();
        bytes32 kind = LibVaipakam.storageSlot().orderHashKind[orderHash];
        if (kind == LibVaipakam.ORDER_KIND_SWAP_TO_REPAY) {
            LibSwapToRepayIntentSettlement.postInteractionImpl(
                orderHash, makingAmount, takingAmount
            );
        } else if (kind == LibVaipakam.ORDER_KIND_BUYBACK) {
            // Codex Sub 3.B round-1 P1 #1 + P1 #2 + P2 #1 — the
            // library applies LOP auth, expiry check, and reads
            // delivered VPFI via balance-delta against the
            // preInteraction baseline. `makingAmount` is the maker-
            // side (source-token sold) and is intentionally
            // unused here.
            LibTreasuryBuyback.postInteractionImpl(orderHash, makingAmount);
        } else {
            revert UnknownOrderKind(orderHash);
        }
        LibReentrancyGuard._exit();
    }

    /// @inheritdoc IERC1271
    /// @dev STATICCALL-safe — both arms are pure read-only. Returns
    ///      0xffffffff (invalid) when the orderHash has no stamped
    ///      kind, so Fusion treats it as a non-matching signature.
    function isValidSignature(bytes32 orderHash, bytes calldata /* signature */)
        external
        view
        override
        returns (bytes4)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 kind = s.orderHashKind[orderHash];
        if (kind == LibVaipakam.ORDER_KIND_SWAP_TO_REPAY) {
            return LibSwapToRepayIntentSettlement.isValidSignatureImpl(orderHash);
        }
        // T-087 Sub 3.C — BUYBACK signature validation is ON only
        // for orderHashes whose Fusion order template was validated
        // through `commitBuybackIntentValidated` (Sub 3.B round-4 P1
        // fold). The discriminator alone is not sufficient; the
        // operator must have submitted the full order template and
        // had it recomputed + matched on-chain. Validated + still-
        // Pending + within deadline → magic value; otherwise
        // 0xffffffff so the Fusion solver rejects the order.
        if (kind == LibVaipakam.ORDER_KIND_BUYBACK
                && s.buybackValidated[orderHash]) {
            LibVaipakam.BuybackOrderInfo memory info = s.buybackOrders[orderHash];
            if (info.status == LibVaipakam.BUYBACK_ORDER_STATUS_PENDING
                    && block.timestamp < info.expiresAt) {
                return IERC1271.isValidSignature.selector;
            }
        }
        return bytes4(0xffffffff);
    }
}
