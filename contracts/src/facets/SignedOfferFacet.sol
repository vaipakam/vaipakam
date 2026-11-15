// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibSignedOffer} from "../libraries/LibSignedOffer.sol";
import {LibAcceptTerms} from "../libraries/LibAcceptTerms.sol";
import {LibPermit2, ISignatureTransfer} from "../libraries/LibPermit2.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";

/**
 * @title SignedOfferFacet
 * @author Vaipakam Developer Team
 * @notice #396 v0.5 — the gasless signed off-chain offer book. A creator
 *         signs the economically-binding offer terms ONCE off-chain (no tx,
 *         no gas); a counterparty fills it on-chain here. At the instant of
 *         fill the signed offer is materialized into a normal on-chain offer
 *         (`OfferCreateFacet`) and immediately accepted
 *         (`OfferAcceptFacet.acceptOfferInternal`), so every downstream
 *         lifecycle (loan init, NFTs, claims, VPFI, sanctions, range
 *         accounting) is the existing, audited path — unchanged.
 *
 * @dev    Two funding modes (see {SignedOfferBookV05Design}):
 *           - **vault-backed** ({acceptSignedOffer}) — the signer pre-funded
 *             their vault; the stake is moved from free vault balance. The
 *             signer's EIP-712 signature over the offer is verified here.
 *           - **wallet-backed** ({acceptSignedOfferWithPermit}) — the stake is
 *             pulled from the signer's wallet via Permit2 `permitWitnessTransfer
 *             From`, the offer hash bound as the witness, so ONE Permit2
 *             signature authorizes the pull AND the terms (AON-only).
 *
 *         **Acceptor injection.** Filling routes through the cross-facet
 *         `acceptOfferInternal`, where `msg.sender` is the diamond. The real
 *         counterparty is injected into `s.signedOfferAcceptor` immediately
 *         before that call and cleared immediately after, so `_acceptOffer`
 *         resolves the acceptor to the real caller (same mechanism the
 *         matcher's `matchOverride.counterparty` uses).
 *
 *         v0.5 is DIRECT counterparty accept = full consume (AON semantics);
 *         partial fills arrive with the matcher phase. `signedOfferFilled` is
 *         the order-hash-keyed replay/consume ledger (cumulative-shaped for
 *         that future phase).
 */
contract SignedOfferFacet is DiamondReentrancyGuard, DiamondPausable {
    /// @notice A signed offer filled into a loan.
    event SignedOfferFilled(
        bytes32 indexed orderHash,
        address indexed signer,
        address indexed acceptor,
        uint256 offerId,
        uint256 loanId
    );

    // The fill refusals (consumed, expired, cancelled nonce or floor, fee
    // caps, taker, co-signature, bad signature) are LibSignedOffer's, shared
    // with the match route (#3327).

    /// @notice Wallet-backed (Permit2-witness) signed offers are AON-only — a
    ///         single transfer signature authorizes exactly one pull.
    error WalletBackedMustBeAon();
    /// @notice A cross-facet hop reverted with no return data.
    error SignedOfferCallFailed();

    // ─── Fill entry points ───────────────────────────────────────────────

    /// @notice Fill a **vault-backed** signed offer. `msg.sender` is the
    ///         counterparty providing the other leg.
    /// @param o         The signed offer terms.
    /// @param sig       The signer's EIP-712 signature (EOA or ERC-1271).
    /// @param terms     The acceptor's EIP-712-signed `AcceptTerms` (#662) —
    ///                  carries the acceptor's single fallback-terms consent +
    ///                  every loan-affecting field, bound against the
    ///                  materialized offer before any value moves.
    /// @param acceptSig ECDSA / ERC-1271 signature over `terms`.
    /// @param auth      The offer's co-signer's authorization of this fill
    ///                  (#3327); ignored when the offer names no co-signer.
    /// @return loanId   The initiated loan id.
    function acceptSignedOffer(
        LibSignedOffer.SignedOffer calldata o,
        bytes calldata sig,
        LibAcceptTerms.AcceptTerms calldata terms,
        bytes calldata acceptSig,
        LibSignedOffer.FillAuth calldata auth
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        bytes32 orderHash = _vetSignedOffer(o, auth);
        (bool ok, ) = LibSignedOffer.verify(o, sig);
        if (!ok) revert LibSignedOffer.SignedOfferBadSignature();
        // Consume BEFORE any external interaction (CEI).
        LibVaipakam.storageSlot().signedOfferFilled[orderHash] = LibSignedOffer.ceilingOf(o);
        uint256 offerId = _materializeVault(o);
        // #662 — bind the acceptor's signed terms against the materialized
        // offer. `offerKey` is the signed-offer order hash (no offerId existed
        // at sign time); the acceptor is `msg.sender`, the filling counterparty.
        OfferAcceptFacet(address(this)).verifyAndBindAccept(
            offerId, orderHash, terms, acceptSig, msg.sender
        );
        loanId = _routeAccept(offerId, terms.riskAndTermsConsent);
        emit SignedOfferFilled(orderHash, o.signer, msg.sender, offerId, loanId);
    }

    /// @notice Fill a **wallet-backed** signed offer — the stake is pulled
    ///         from the signer's wallet via Permit2, the offer hash bound as
    ///         the witness (one signature binds pull + terms). AON-only.
    /// @param o         The signed offer terms.
    /// @param permit    The Permit2 `PermitTransferFrom` the signer signed.
    /// @param permitSig The Permit2 witness signature.
    /// @param terms     The acceptor's EIP-712-signed `AcceptTerms` (#662) —
    ///                  acceptor consent + every loan-affecting field, bound
    ///                  against the materialized offer before any value moves.
    /// @param acceptSig ECDSA / ERC-1271 signature over `terms`.
    /// @param auth      The offer's co-signer's authorization of this fill
    ///                  (#3327); ignored when the offer names no co-signer.
    /// @return loanId   The initiated loan id.
    function acceptSignedOfferWithPermit(
        LibSignedOffer.SignedOffer calldata o,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata permitSig,
        LibAcceptTerms.AcceptTerms calldata terms,
        bytes calldata acceptSig,
        LibSignedOffer.FillAuth calldata auth
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        if (LibVaipakam.FillMode(o.fillMode) != LibVaipakam.FillMode.Aon) {
            revert WalletBackedMustBeAon();
        }
        // The witness IS the order hash — Permit2 verifies the signer signed
        // over it; that is the terms binding (no separate offer signature).
        bytes32 orderHash = _vetSignedOffer(o, auth);
        LibVaipakam.storageSlot().signedOfferFilled[orderHash] = LibSignedOffer.ceilingOf(o);
        uint256 offerId = _materializeWallet(o, permit, orderHash, permitSig);
        // #662 — bind the acceptor's signed terms against the materialized offer.
        OfferAcceptFacet(address(this)).verifyAndBindAccept(
            offerId, orderHash, terms, acceptSig, msg.sender
        );
        loanId = _routeAccept(offerId, terms.riskAndTermsConsent);
        emit SignedOfferFilled(orderHash, o.signer, msg.sender, offerId, loanId);
    }

    // ─── Cancellation + batch invalidation ───────────────────────────────

    /// @notice A signer cancelled one of their signed offers on-chain.
    event SignedOfferCancelled(bytes32 indexed orderHash, address indexed signer);
    /// @notice A signer batch-invalidated a signed-offer nonce.
    event SignedOfferNonceBurned(address indexed signer, uint256 nonce);
    /// @notice #3327 — a signer raised their cancel floor: every signed offer
    ///         of theirs whose nonce is below `floor` is cancelled.
    event SignedOfferCancelFloorRaised(address indexed signer, uint256 floor);
    /// @notice #3327 — the cancel floor only rises.
    error SignedOfferCancelFloorNotRaised(uint256 floor, uint256 current);
    /// @notice Only the offer's signer may cancel it.
    error NotSignedOfferSigner();

    /// @notice Cancel a signed offer on-chain (the secure cancellation — a
    ///         free off-chain delete only hides it). Marks the order hash
    ///         consumed so no fill can bind it. Signer-only.
    function cancelSignedOffer(LibSignedOffer.SignedOffer calldata o)
        external
        whenNotPaused
    {
        if (msg.sender != o.signer) revert NotSignedOfferSigner();
        bytes32 orderHash = LibSignedOffer.hashStruct(o);
        LibVaipakam.storageSlot().signedOfferFilled[orderHash] = LibSignedOffer.ceilingOf(o);
        emit SignedOfferCancelled(orderHash, o.signer);
    }

    /// @notice Batch-invalidate a signed-offer nonce — cancels EVERY live
    ///         signed offer the caller signed carrying this nonce at once.
    function invalidateSignedOfferNonce(uint256 nonce) external whenNotPaused {
        LibVaipakam.storageSlot().signedOfferNonceUsed[msg.sender][nonce] = true;
        emit SignedOfferNonceBurned(msg.sender, nonce);
    }

    /// @notice #3327 — cancel EVERY signed offer the caller signed with a
    ///         nonce below `floor`, in one transaction (the response to a key
    ///         scare or a sharp market move). The floor only rises, so a
    ///         cancelled offer never comes back.
    function cancelSignedOffersBelow(uint256 floor) external whenNotPaused {
        uint256 current = LibVaipakam.storageSlot().signedOfferNonceFloor[msg.sender];
        if (floor <= current) revert SignedOfferCancelFloorNotRaised(floor, current);
        LibVaipakam.storageSlot().signedOfferNonceFloor[msg.sender] = floor;
        emit SignedOfferCancelFloorRaised(msg.sender, floor);
    }

    // ─── Views ───────────────────────────────────────────────────────────

    /// @notice #3327 — the signer's cancel floor: their signed offers with a
    ///         nonce below it are cancelled (0 = none raised).
    function signedOfferCancelFloor(address signer) external view returns (uint256) {
        return LibVaipakam.storageSlot().signedOfferNonceFloor[signer];
    }

    /// @notice The full EIP-712 digest the signer signs off-chain for `o`.
    function hashSignedOffer(LibSignedOffer.SignedOffer calldata o)
        external
        view
        returns (bytes32)
    {
        return LibSignedOffer.digest(o);
    }

    /// @notice #3327 — the EIP-712 digest an offer's co-signer signs for one
    ///         fill: the order, the taker, the fill amount and the latest
    ///         time the co-signature may be used (at most 15 minutes ahead).
    function hashSignedOfferFill(bytes32 orderHash, address taker, uint256 fillAmount, uint64 validUntil)
        external
        view
        returns (bytes32)
    {
        return LibSignedOffer.fillDigest(orderHash, taker, fillAmount, validUntil);
    }

    /// @notice The order hash (struct hash) — the on-chain ledger key.
    function signedOfferOrderHash(LibSignedOffer.SignedOffer calldata o)
        external
        pure
        returns (bytes32)
    {
        return LibSignedOffer.hashStruct(o);
    }

    /// @notice Cumulative amount filled against an order hash (non-zero ⇒
    ///         consumed / cancelled in v0.5).
    function signedOfferFilledAmount(bytes32 orderHash)
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().signedOfferFilled[orderHash];
    }

    /// @notice Whether a signer's batch-cancel nonce has been invalidated.
    function isSignedOfferNonceUsed(address signer, uint256 nonce)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().signedOfferNonceUsed[signer][nonce];
    }

    // ─── Internals ───────────────────────────────────────────────────────

    /// @dev The whole-order fill's checks, stated once in
    ///      {LibSignedOffer.vetFailure} so the accept preview reports exactly
    ///      what this refuses (#3552, #3327). The taker is the caller. Returns
    ///      the order hash.
    function _vetSignedOffer(LibSignedOffer.SignedOffer calldata o, LibSignedOffer.FillAuth calldata auth)
        private
        view
        returns (bytes32 orderHash)
    {
        orderHash = LibSignedOffer.hashStruct(o);
        LibSignedOffer.revertFor(o, orderHash, msg.sender, LibSignedOffer.vetFailure(o, orderHash, msg.sender, auth));
    }


    /// @dev Materialize the vault-backed offer via `OfferCreateFacet`. Built
    ///      params + low-level `abi.encodeWithSelector` + `.call` (the typed
    ///      cross-facet call's ABI encode of the 26-field struct trips viaIR's
    ///      stack ceiling — see `reference_viair_stack_too_deep_lever`).
    function _materializeVault(LibSignedOffer.SignedOffer calldata o)
        private
        returns (uint256 offerId)
    {
        LibVaipakam.CreateOfferParams memory params = _paramsFromSigned(o);
        bytes memory res = _selfCall(
            abi.encodeWithSelector(
                OfferCreateFacet.createSignedOfferVault.selector,
                o.signer,
                params,
                LibSignedOffer.makerFullFor(o, 0, LibSignedOffer.ceilingOf(o)) // #1949 — the whole order
            )
        );
        offerId = abi.decode(res, (uint256));
    }

    /// @dev Materialize the wallet-backed offer (Permit2-witness) via
    ///      `OfferCreateFacet`.
    function _materializeWallet(
        LibSignedOffer.SignedOffer calldata o,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes32 witness,
        bytes calldata permitSig
    ) private returns (uint256 offerId) {
        LibVaipakam.CreateOfferParams memory params = _paramsFromSigned(o);
        bytes memory res = _selfCall(
            abi.encodeWithSelector(
                OfferCreateFacet.createSignedOfferWallet.selector,
                o.signer,
                params,
                permit,
                witness,
                permitSig,
                LibSignedOffer.makerFullFor(o, 0, LibSignedOffer.ceilingOf(o)) // #1949 — the whole order
            )
        );
        offerId = abi.decode(res, (uint256));
    }

    /// @dev Inject the real acceptor, route the fill through the shared
    ///      `acceptOfferInternal` plumbing, then ALWAYS clear the injection.
    ///      `acceptOfferInternal` is gated `msg.sender == address(this)`; the
    ///      self-call satisfies it. `_acceptOffer` reads `signedOfferAcceptor`
    ///      and resolves the acceptor to `msg.sender` (the original caller).
    function _routeAccept(uint256 offerId, bool acceptorConsent)
        private
        returns (uint256 loanId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.signedOfferAcceptor = msg.sender;
        bytes memory res = _selfCall(
            abi.encodeWithSelector(
                OfferAcceptFacet.acceptOfferInternal.selector,
                offerId,
                acceptorConsent
            )
        );
        s.signedOfferAcceptor = address(0);
        loanId = abi.decode(res, (uint256));
    }

    /// @dev Cross-facet self-call that bubbles the inner revert reason (so the
    ///      caller sees the specific materialize / accept error), or a generic
    ///      fallback if the call returned no data.
    function _selfCall(bytes memory cd) private returns (bytes memory) {
        // slither-disable-next-line low-level-calls
        (bool ok, bytes memory res) = address(this).call(cd);
        if (!ok) {
            if (res.length > 0) {
                assembly {
                    revert(add(res, 0x20), mload(res))
                }
            }
            revert SignedOfferCallFailed();
        }
        return res;
    }

    /// @dev Build the on-chain `CreateOfferParams` from a signed offer.
    ///      Delegates to `LibSignedOffer.toCreateOfferParams` — the single
    ///      source of the mapping, shared with the v0.6 matcher.
    function _paramsFromSigned(LibSignedOffer.SignedOffer calldata o)
        private
        pure
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibSignedOffer.toCreateOfferParams(o);
    }
}
