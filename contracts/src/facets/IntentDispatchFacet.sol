// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibSwapToRepayIntentSettlement} from
    "../libraries/LibSwapToRepayIntentSettlement.sol";
import {LibTreasuryBuyback} from "../libraries/LibTreasuryBuyback.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
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
 */
contract IntentDispatchFacet is
    DiamondReentrancyGuard,
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
    function preInteraction(
        IOrderMixin.Order calldata /* order */,
        bytes calldata /* extension */,
        bytes32 orderHash,
        address /* taker */,
        uint256 /* makingAmount */,
        uint256 /* takingAmount */,
        uint256 /* remainingMakingAmount */,
        bytes calldata /* extraData */
    ) external override {
        bytes32 kind = LibVaipakam.storageSlot().orderHashKind[orderHash];
        if (kind == LibVaipakam.ORDER_KIND_SWAP_TO_REPAY) {
            LibSwapToRepayIntentSettlement.preInteractionImpl(orderHash);
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
    function postInteraction(
        IOrderMixin.Order calldata /* order */,
        bytes calldata /* extension */,
        bytes32 orderHash,
        address /* taker */,
        uint256 makingAmount,
        uint256 /* takingAmount */,
        uint256 /* remainingMakingAmount */,
        bytes calldata /* extraData */
    ) external override nonReentrant {
        bytes32 kind = LibVaipakam.storageSlot().orderHashKind[orderHash];
        if (kind == LibVaipakam.ORDER_KIND_SWAP_TO_REPAY) {
            LibSwapToRepayIntentSettlement.postInteractionImpl(
                orderHash, makingAmount
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
        bytes32 kind = LibVaipakam.storageSlot().orderHashKind[orderHash];
        if (kind == LibVaipakam.ORDER_KIND_SWAP_TO_REPAY) {
            return LibSwapToRepayIntentSettlement.isValidSignatureImpl(orderHash);
        }
        // Codex Sub 3.B round-4 P1 — BUYBACK signature validation
        // is intentionally OFF in Sub 3.B. Returning the ERC-1271
        // magic value purely on a stamped `orderHashKind` would let
        // an operator-typo'd orderHash (one whose underlying Fusion
        // order routes proceeds to a non-diamond receiver, or omits
        // the pre/postInteraction hooks) settle successfully. The
        // full Fusion-order-template validation ships in Sub 3.C
        // alongside the agent-side submission; until then the on-
        // chain ledger surface (commit / expire / ABI) exists but
        // no Fusion fill against a BUYBACK orderHash is signable
        // through the diamond. Consequence in Sub 3.B: BUYBACK
        // postInteractionImpl can still be exercised via direct
        // tests but the Fusion solver rejects the order at signature
        // check, so the production path is a no-op until 3.C.
        // (UnknownOrderKind branch / 0xffffffff fall-through covers
        // both stamped-but-not-validated AND unstamped.)
        return bytes4(0xffffffff);
    }
}
