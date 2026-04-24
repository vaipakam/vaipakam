// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title LibPermit2
 * @author Vaipakam Developer Team
 * @notice Phase 8b.1 — thin wrapper around Uniswap's canonical Permit2
 *         signature-transfer interface. Lets Vaipakam accept a signed
 *         permit from the user and pull tokens in a single transaction
 *         instead of requiring a separate `approve` call.
 *
 * @dev Canonical address `0x000000000022D473030F116dDEE9F6B43aC78BA3` is
 *      deployed on every EVM via Nick's factory; same address on
 *      Ethereum, Base, Arbitrum, Optimism, Polygon zkEVM, BNB Chain, and
 *      every testnet. Verified at <https://docs.uniswap.org/contracts/permit2/overview>.
 *
 *      Frontend flow:
 *        1. User signs EIP-712 `PermitTransferFrom` typed data.
 *        2. Frontend submits the signature with the Vaipakam action
 *           (createOffer / acceptOffer / depositVPFI) calldata.
 *        3. This helper forwards the signature to Permit2, which pulls
 *           the token from the user's wallet and delivers it to the
 *           `to` address specified in `transferDetails` (the user's
 *           per-user Vaipakam escrow proxy for offer-create and
 *           VPFI-deposit paths; the Diamond itself for fee/LIF paths).
 *
 *      Signature semantics (Permit2 enforces, not this wrapper):
 *        - `permit.deadline` — timestamp past which the signature is
 *          rejected. Frontend default is +30 min.
 *        - `permit.nonce` — per-user unordered nonce slot; Permit2
 *          burns the slot on first use to prevent replay. Frontend
 *          generates via `getNextNonce` helper (random 248-bit prefix
 *          + sequential word).
 *        - `permit.permitted.token` + `amount` — MUST match the token
 *          and max amount the user signed over. Passing a different
 *          token or a higher amount reverts inside Permit2.
 *        - `transferDetails.requestedAmount` — must be ≤ `permit.amount`.
 *          Caller chooses the actual amount to pull, bounded by what
 *          the user signed.
 *
 *      On any signature / nonce / deadline / amount mismatch, Permit2
 *      reverts with its own typed errors. We don't catch — the whole
 *      tx reverts and the user sees the signature failure clearly.
 */

interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;

    function nonceBitmap(address owner, uint256 wordPos)
        external
        view
        returns (uint256);
}

library LibPermit2 {
    /// @notice Canonical Permit2 address — identical on every EVM chain
    ///         via deterministic CREATE2 deploy by Nick's factory.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /**
     * @notice Pull `amount` of `permit.permitted.token` from `owner`
     *         to `to` via Permit2 using the signed `permit` + `signature`.
     *
     * @dev Thin wrapper around `ISignatureTransfer.permitTransferFrom`.
     *      Reverts via Permit2 on any signature / nonce / deadline /
     *      amount issue. Caller must ensure:
     *        - `amount <= permit.permitted.amount` (Permit2 enforces)
     *        - `permit.permitted.token` matches the expected asset
     *        - `permit.deadline > block.timestamp`
     *
     * @param owner     Signer of the permit (asset source).
     * @param to        Destination address (escrow proxy or Diamond).
     * @param amount    Amount to pull — must be ≤ signed amount.
     * @param permit    `PermitTransferFrom` struct the user signed.
     * @param signature 65-byte ECDSA signature over the EIP-712 digest.
     */
    function pull(
        address owner,
        address to,
        uint256 amount,
        ISignatureTransfer.PermitTransferFrom memory permit,
        bytes memory signature
    ) internal {
        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: to,
                requestedAmount: amount
            }),
            owner,
            signature
        );
    }
}
