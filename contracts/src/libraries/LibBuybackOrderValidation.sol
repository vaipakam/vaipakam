// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibBuybackOrderValidation — T-087 Sub 3.C
 *
 * Validates a Fusion LOP v4 order template against the canonical
 * buyback shape. `IntentDispatchFacet.isValidSignature` returns the
 * ERC-1271 magic value only for orderHashes whose underlying template
 * was validated through this surface (`s.buybackValidated[orderHash]
 * == true`), closing the Sub 3.B round-4 P1 finding.
 *
 * Mirrors `SwapToRepayIntentFacet`'s commit-time validation but with
 * the TWAP-specific twist: `allowPartialFills = true` +
 * `allowMultipleFills = true` (the swap-to-repay path requires the
 * OPPOSITE so its single-shot reservation cannot be double-spent).
 * The buyback ledger's per-fill `consumedSoFar` accumulator handles
 * the partials safely.
 */
library LibBuybackOrderValidation {
    // ─── 1inch LOP v4 makerTraits bit constants ─────────────────────

    uint256 internal constant NO_PARTIAL_FILLS_FLAG    = 1 << 255;
    uint256 internal constant ALLOW_MULTIPLE_FILLS_FLAG = 1 << 254;
    uint256 internal constant PRE_INTERACTION_CALL_FLAG  = 1 << 252;
    uint256 internal constant POST_INTERACTION_CALL_FLAG = 1 << 251;
    uint256 internal constant NEED_CHECK_EPOCH_MANAGER_FLAG = 1 << 250;
    uint256 internal constant HAS_EXTENSION_FLAG = 1 << 249;
    uint256 internal constant USE_PERMIT2_FLAG   = 1 << 248;
    uint256 internal constant UNWRAP_WETH_FLAG   = 1 << 247;
    uint256 internal constant EXPIRATION_OFFSET = 80;
    uint256 internal constant UINT40_MASK = (1 << 40) - 1;

    // ─── EIP-712 type-hash for LOP v4 Order struct ──────────────────

    bytes32 internal constant LIMIT_ORDER_TYPEHASH = keccak256(
        "Order("
            "uint256 salt,"
            "address maker,"
            "address receiver,"
            "address makerAsset,"
            "address takerAsset,"
            "uint256 makingAmount,"
            "uint256 takingAmount,"
            "uint256 makerTraits"
        ")"
    );

    // ─── Reason discriminators ──────────────────────────────────────

    bytes32 internal constant FIELD_MAKER = keccak256("maker");
    bytes32 internal constant FIELD_RECEIVER = keccak256("receiver");
    bytes32 internal constant FIELD_MAKER_ASSET = keccak256("makerAsset");
    bytes32 internal constant FIELD_TAKER_ASSET = keccak256("takerAsset");
    bytes32 internal constant FIELD_MAKING_AMOUNT = keccak256("makingAmount");
    bytes32 internal constant FIELD_TAKING_AMOUNT = keccak256("takingAmount");
    bytes32 internal constant FIELD_SALT_EXTENSION = keccak256("salt-extension-binding");
    bytes32 internal constant FIELD_EXTENSION_LAYOUT = keccak256("extension-layout");
    bytes32 internal constant FIELD_ORDER_HASH = keccak256("orderHash-recomputed");
    bytes32 internal constant REASON_HAS_EXTENSION = keccak256("hasExtension");
    bytes32 internal constant REASON_PRE_INTERACTION = keccak256("needPreInteractionCall");
    bytes32 internal constant REASON_POST_INTERACTION = keccak256("needPostInteractionCall");
    bytes32 internal constant REASON_PARTIAL_FILLS_REQUIRED = keccak256("partialFillsRequired");
    bytes32 internal constant REASON_MULTIPLE_FILLS_REQUIRED = keccak256("multipleFillsRequired");
    bytes32 internal constant REASON_USE_PERMIT2 = keccak256("usePermit2");
    bytes32 internal constant REASON_NEED_CHECK_EPOCH_MANAGER = keccak256("needCheckEpochManager");
    bytes32 internal constant REASON_UNWRAP_WETH = keccak256("unwrapWeth");
    bytes32 internal constant REASON_EXPIRATION_MISMATCH = keccak256("expiration-mismatch");

    // ─── Errors ──────────────────────────────────────────────────────

    error BuybackOrderFieldsMismatch(bytes32 fieldHash);
    error BuybackOrderMakerTraitsMismatch(bytes32 reasonHash);

    // ─── Public structs ──────────────────────────────────────────────

    /// @dev Inputs for `commitBuybackIntentValidated` — the 8 LOP v4
    ///      order fields the diamond must validate plus the extension
    ///      bytes. The operator computes these off-chain from the
    ///      same Fusion template the apps/agent will post.
    struct BuybackOrderTemplate {
        uint256 salt;
        address maker;
        address receiver;
        address makerAsset;
        address takerAsset;
        uint256 makingAmount;
        uint256 takingAmount;
        uint256 makerTraits;
        bytes extension;
    }

    // ─── Canonical extension ─────────────────────────────────────────

    /// @notice The canonical extension bytes layout — preInteraction +
    ///         postInteraction both target the Diamond (so Fusion's
    ///         LOP v4 calls into our dispatcher). Layout decoded the
    ///         same way the swap-to-repay path's `canonicalExtension`
    ///         is: a 32-byte offsets-word header plus two 20-byte
    ///         address fields. Total length = 72 bytes.
    function canonicalBuybackExtension(address diamond)
        internal
        pure
        returns (bytes memory)
    {
        uint256 offsets =
            (uint256(20) << (6 * 32)) |
            (uint256(40) << (7 * 32)) |
            (uint256(40) << (8 * 32));
        return abi.encodePacked(offsets, diamond, diamond);
    }

    // ─── Validation surface ──────────────────────────────────────────

    /// @notice Validate the Fusion order template against the
    ///         canonical buyback shape. Re-computes the LOP v4
    ///         orderHash on-chain (EIP-712) and verifies it matches
    ///         the operator-supplied `orderHash`.
    /// @dev    Reverts with `BuybackOrderFieldsMismatch` /
    ///         `BuybackOrderMakerTraitsMismatch` on every disagreement.
    function validateBuybackOrder(
        bytes32 orderHash,
        BuybackOrderTemplate calldata tpl,
        address diamond,
        address expectedMakerAsset,
        address expectedTakerAsset,
        uint256 expectedMakingAmount,
        uint256 expectedTakingAmount,
        uint64 expectedExpiresAt,
        bytes32 lopDomainSeparator
    ) internal pure {
        // ── Field-by-field structural binding ────────────────────────
        if (tpl.maker != diamond) revert BuybackOrderFieldsMismatch(FIELD_MAKER);
        if (tpl.receiver != diamond) revert BuybackOrderFieldsMismatch(FIELD_RECEIVER);
        if (tpl.makerAsset != expectedMakerAsset) {
            revert BuybackOrderFieldsMismatch(FIELD_MAKER_ASSET);
        }
        if (tpl.takerAsset != expectedTakerAsset) {
            revert BuybackOrderFieldsMismatch(FIELD_TAKER_ASSET);
        }
        if (tpl.makingAmount != expectedMakingAmount) {
            revert BuybackOrderFieldsMismatch(FIELD_MAKING_AMOUNT);
        }
        if (tpl.takingAmount != expectedTakingAmount) {
            revert BuybackOrderFieldsMismatch(FIELD_TAKING_AMOUNT);
        }

        // ── makerTraits bits ─────────────────────────────────────────
        uint256 mt = tpl.makerTraits;
        if ((mt & HAS_EXTENSION_FLAG) == 0) {
            revert BuybackOrderMakerTraitsMismatch(REASON_HAS_EXTENSION);
        }
        if ((mt & PRE_INTERACTION_CALL_FLAG) == 0) {
            revert BuybackOrderMakerTraitsMismatch(REASON_PRE_INTERACTION);
        }
        if ((mt & POST_INTERACTION_CALL_FLAG) == 0) {
            revert BuybackOrderMakerTraitsMismatch(REASON_POST_INTERACTION);
        }
        // For TWAP buyback orders, partial fills MUST be allowed
        // (the swap-to-repay path requires the OPPOSITE):
        //   `allowPartialFills()` is TRUE when the NO_PARTIAL bit is
        //   CLEAR — we require NO_PARTIAL = 0 (cleared).
        if ((mt & NO_PARTIAL_FILLS_FLAG) != 0) {
            revert BuybackOrderMakerTraitsMismatch(REASON_PARTIAL_FILLS_REQUIRED);
        }
        // And multiple fills MUST be allowed.
        if ((mt & ALLOW_MULTIPLE_FILLS_FLAG) == 0) {
            revert BuybackOrderMakerTraitsMismatch(REASON_MULTIPLE_FILLS_REQUIRED);
        }
        if ((mt & USE_PERMIT2_FLAG) != 0) {
            revert BuybackOrderMakerTraitsMismatch(REASON_USE_PERMIT2);
        }
        if ((mt & NEED_CHECK_EPOCH_MANAGER_FLAG) != 0) {
            revert BuybackOrderMakerTraitsMismatch(REASON_NEED_CHECK_EPOCH_MANAGER);
        }
        if ((mt & UNWRAP_WETH_FLAG) != 0) {
            revert BuybackOrderMakerTraitsMismatch(REASON_UNWRAP_WETH);
        }
        // Expiration sub-field must match the operator's expiresAt.
        if (((mt >> EXPIRATION_OFFSET) & UINT40_MASK) != uint256(expectedExpiresAt)) {
            revert BuybackOrderMakerTraitsMismatch(REASON_EXPIRATION_MISMATCH);
        }

        // ── Salt ↔ extension binding (LOP v4 rule) ───────────────────
        bytes32 extensionHash = keccak256(tpl.extension);
        if (
            (tpl.salt & ((1 << 160) - 1))
                != uint256(uint160(uint256(extensionHash)))
        ) {
            revert BuybackOrderFieldsMismatch(FIELD_SALT_EXTENSION);
        }
        // Extension bytes match canonical layout exactly.
        if (extensionHash != keccak256(canonicalBuybackExtension(diamond))) {
            revert BuybackOrderFieldsMismatch(FIELD_EXTENSION_LAYOUT);
        }

        // ── Recompute orderHash on-chain ─────────────────────────────
        bytes32 structHash = keccak256(abi.encode(
            LIMIT_ORDER_TYPEHASH,
            tpl.salt,
            uint256(uint160(tpl.maker)),
            uint256(uint160(tpl.receiver)),
            uint256(uint160(tpl.makerAsset)),
            uint256(uint160(tpl.takerAsset)),
            tpl.makingAmount,
            tpl.takingAmount,
            tpl.makerTraits
        ));
        bytes32 computed = keccak256(
            abi.encodePacked(bytes2(0x1901), lopDomainSeparator, structHash)
        );
        if (computed != orderHash) {
            revert BuybackOrderFieldsMismatch(FIELD_ORDER_HASH);
        }
    }
}
