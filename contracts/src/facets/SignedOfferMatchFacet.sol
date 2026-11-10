// src/facets/SignedOfferMatchFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {LibSignedOffer} from "../libraries/LibSignedOffer.sol";
import {LibOfferMatchExecute} from "../libraries/LibOfferMatchExecute.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";

/**
 * @title  SignedOfferMatchFacet
 * @author Vaipakam Developer Team
 * @notice #396 v0.6 — the keeper-matcher for signed off-chain offers:
 *         `matchSignedOffer` fills a vault-backed signed offer, in full or in
 *         a slice, against an on-chain counterparty offer.
 * @dev    #3443 — split out of `OfferMatchFacet`, which the offer-age rule
 *         took over EIP-170. The seam is the feature: this facet owns the
 *         signed-offer checks (signature, nonce, remaining, slice shape) and
 *         the slice it materializes; the match itself runs through the same
 *         `LibOfferMatchExecute.executeMatch` core `matchOffers` and
 *         `matchIntent` inline, so one source still decides every match.
 *         Same storage, same Diamond, same selector, event and errors for
 *         every caller; only the runtime bytecode moved.
 *
 *         The slice is materialized in the fill transaction, so it carries no
 *         terms age (`termsSetAt == 0`, see `LibTiming`); the on-chain
 *         counterparty's terms must have stood the minimum age, which
 *         `executeMatch` checks.
 */
contract SignedOfferMatchFacet is DiamondReentrancyGuard, DiamondPausable {
    // ─── #396 v0.6 — keeper-matcher for signed offers ────────────────────

    /// @notice A signed offer filled by a keeper against an on-chain counterparty.
    event SignedOfferMatched(
        bytes32 indexed orderHash,
        address indexed signer,
        address indexed matcher,
        uint256 sliceOfferId,
        uint256 counterpartyOfferId,
        uint256 loanId,
        uint256 fillAmount
    );

    /// @notice The signed offer is fully filled or cancelled.
    error SignedOfferConsumed(bytes32 orderHash);
    /// @notice The signer batch-invalidated this offer's nonce.
    error SignedOfferNonceBurned(uint256 nonce);
    /// @notice The signature did not recover to / 1271-validate against `o.signer`.
    error SignedOfferBadSignature();
    /// @notice The signed offer's GTT window has passed.
    error SignedOfferGttExpired(uint64 expiresAt);
    /// @notice `fillAmount` is zero, exceeds the remaining, or violates the
    ///         signer's AON intent (an AON offer must be filled in full).
    error SignedOfferFillInvalid(uint256 fillAmount, uint256 remaining);
    /// @notice A matched signed offer's collateral:principal ratio is not
    ///         constant across its range (collMin:amount != collMax:amountMax).
    ///         A non-constant ratio is not sliceable; use separate offers or AON.
    error SignedOfferRatioNotConstant();

    /// @notice Keeper-matcher fill of a **vault-backed** signed offer against
    ///         an on-chain counterparty offer — full or partial. The keeper
    ///         (`msg.sender`) earns the 1% LIF. Each call materializes EXACTLY
    ///         the slice it fills (single-value → fully consumed, no dangling
    ///         on-chain offer) and decrements the OFF-chain `signedOfferFilled`
    ///         ledger; successive calls partial-fill the off-chain offer. The
    ///         match's collateral/HF safety is enforced by
    ///         `LibOfferMatch.previewMatch` inside `executeMatch`.
    /// @param o                   The signed offer terms.
    /// @param sig                 The signer's EIP-712 signature (EOA / 1271).
    /// @param counterpartyOfferId The on-chain offer on the OTHER side.
    /// @param fillAmount          The principal this match fills (≤ remaining).
    /// @return loanId             The initiated loan.
    function matchSignedOffer(
        LibSignedOffer.SignedOffer calldata o,
        bytes calldata sig,
        uint256 counterpartyOfferId,
        uint256 fillAmount
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        LibVaipakam._assertNotSanctioned(msg.sender); // matcher = LIF recipient
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.partialFillEnabled) {
            revert LibOfferMatchExecute.FunctionDisabled(3);
        }
        bytes32 orderHash = _vetSignedOfferForMatch(o, fillAmount);
        (bool ok, ) = LibSignedOffer.verify(o, sig);
        if (!ok) revert SignedOfferBadSignature();

        // CEI: record the slice consumed BEFORE the materialize + match
        // external calls (bounded by the ceiling in the vet above). Capture the
        // PRE-fill cumulative so the slice collateral is priced as the
        // cumulative difference (rounding-exact across slices — see
        // LibSignedOffer.toCreateOfferParams).
        uint256 filledBefore = s.signedOfferFilled[orderHash];
        s.signedOfferFilled[orderHash] = filledBefore + fillAmount;

        uint256 sliceOfferId = _materializeSlice(o, filledBefore, fillAmount);
        // Route the slice into the correct side-slot. executeMatch processes
        // the BORROWER offer via acceptOfferInternal and injects the LENDER as
        // the counterparty, so the slice goes in whichever slot matches its
        // own offerType. `msg.sender` (the keeper) is preserved as the matcher
        // because executeMatch is an INTERNAL call.
        bool signedIsLender =
            LibVaipakam.OfferType(o.offerType) == LibVaipakam.OfferType.Lender;
        // Signed-BORROWER slice: pin the loan collateral to the signer's
        // interpolated floor for this fill (the slice's own `collateralAmount`,
        // == its `collateralAmountMax`). See `executeMatch`'s borrowerCollFloor
        // doc + the #616 P1 rationale. Signed-LENDER: 0 (the on-chain borrower
        // counterparty governs its own collateral).
        loanId = signedIsLender
            ? LibOfferMatchExecute.executeMatch(sliceOfferId, counterpartyOfferId, 0)
            : LibOfferMatchExecute.executeMatch(
                counterpartyOfferId,
                sliceOfferId,
                s.offers[sliceOfferId].collateralAmount
            );
        // #1219 — one fill, charged after the match (a refused charge reverts the
        // fill whole) to the actor the route names for the matcher.
        LibServiceCapacity.chargeSolver();

        // Transient-slice cleanup for the LENDER direction. The lender slice is
        // the match ACCEPTOR, so LoanFacet mints a FRESH loan lender-position
        // NFT (acceptorTokenId) and `onLoanInitiated` clears only the carried-
        // over BORROWER token — leaving the slice's OWN OfferCreated position
        // NFT + its `offerIdByPositionTokenId` reverse-map entry orphaned, and
        // the lender dust-close fires no metrics hook. Untouched, the fully
        // consumed one-tx slice would surface as a phantom OPEN offer in both
        // `getUserPositionOffers` (active index + reverse map) and tokenURI
        // (live NFT). Mirror OfferCancelFacet's terminal cleanup: drop the
        // active index, clear the reverse map, retire the orphan NFT. (Since
        // #3205 the matcher's `retireTerminalOfferTokens` also retires a
        // terminal slice's own token on either side, so this is idempotent
        // there; a BORROWER slice's token no longer carries over to the loan,
        // which takes its own.)
        if (signedIsLender) {
            LibMetricsHooks.onOfferAccepted(sliceOfferId);
            uint256 slicePosToken = s.offers[sliceOfferId].positionTokenId;
            delete s.offerIdByPositionTokenId[slicePosToken];
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.retirePosition.selector, slicePosToken
                ),
                LibOfferMatchExecute.NFTBurnFailed.selector
            );
        }

        emit SignedOfferMatched(
            orderHash, o.signer, msg.sender, sliceOfferId, counterpartyOfferId, loanId, fillAmount
        );
    }

    /// @dev Pre-fill checks for a signed-offer match: deadline / GTT / nonce /
    ///      remaining + the AON-full-fill guard. Returns the order hash.
    function _vetSignedOfferForMatch(
        LibSignedOffer.SignedOffer calldata o,
        uint256 fillAmount
    ) private view returns (bytes32 orderHash) {
        LibSignedOffer.requireFullWellFormed(o); // #1949 — a Full opt-in needs a ceiling
        // #3412 — the signature's own deadline, through the one timing rule
        // (optional: 0 = the signer set none).
        LibTiming.checkDeadline(o.deadline);
        // #1195 B3 (Pass-2, §1075) — the GTT rule is "expired AT and after the
        // deadline", so use `>=` (matching `LibVaipakam.isOfferExpired` /
        // `LibOfferMatch`), not `>` which left the exact `expiresAt` second
        // fillable.
        if (o.expiresAt != 0 && block.timestamp >= o.expiresAt) {
            revert SignedOfferGttExpired(o.expiresAt);
        }
        orderHash = LibSignedOffer.hashStruct(o);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.signedOfferNonceUsed[o.signer][o.nonce]) {
            revert SignedOfferNonceBurned(o.nonce);
        }
        uint256 ceiling = o.amountMax == 0 ? o.amount : o.amountMax;
        uint256 filled = s.signedOfferFilled[orderHash];
        if (filled >= ceiling) revert SignedOfferConsumed(orderHash);
        uint256 remaining = ceiling - filled;
        if (fillAmount == 0 || fillAmount > remaining) {
            revert SignedOfferFillInvalid(fillAmount, remaining);
        }
        // #616 round-3 (Codex P2) — reject a zero signed minimum. With
        // `amount == 0`, any dust `fillAmount` clears the min-slice +
        // dust-remainder guards below, and once `_materializeSlice` rewrites
        // the slice to `amount = amountMax = fillAmount` the create-time
        // positive-amount invariant never sees the malformed zero — a keeper
        // could drain the signed max in arbitrarily tiny vault-backed loans.
        if (o.amount == 0) revert SignedOfferFillInvalid(fillAmount, remaining);
        // #616 round-3 (Codex P1) — a matched signed offer must carry a CONSTANT
        // collateral:principal ratio (collMin:amount == collMax:amountMax),
        // cross-multiplied to avoid division. Each slice then prices collateral
        // as collMin*fill/amount, which is ADDITIVE: the per-slice locks sum to
        // exactly collMax at full fill, so a keeper cannot split a non-constant
        // range into slices that lock more aggregate collateral than the signer
        // signed (the round-3 over-collection vector). A varying ratio across
        // the fill is not a sliceable order — express it as separate signed
        // offers, or a single AON offer (one ratio, one fill). For AON
        // (amount == ceiling) this same check forces collMin == collMax,
        // matching its single principal value. This mirrors how 0x / Seaport /
        // CoW carry one price per order and partial-fill pro-rata.
        {
            uint256 effCollMax = o.collateralAmountMax == 0
                ? o.collateralAmount
                : o.collateralAmountMax;
            if (o.collateralAmount * ceiling != effCollMax * o.amount) {
                revert SignedOfferRatioNotConstant();
            }
        }
        if (LibVaipakam.FillMode(o.fillMode) == LibVaipakam.FillMode.Aon) {
            // AON structural invariant (mirrors createOffer): an all-or-nothing
            // offer must be a single fixed size — `amount == amountMax`. A
            // ranged AON signature is malformed; reject it before slicing
            // (otherwise `_materializeSlice` would rewrite it to a single value
            // and the invariant the direct path enforces would be bypassed).
            if (o.amount != ceiling) revert SignedOfferFillInvalid(fillAmount, remaining);
            // AON intent: filled in full, in a single un-pre-filled match.
            if (filled != 0 || fillAmount != ceiling) {
                revert SignedOfferFillInvalid(fillAmount, remaining);
            }
        } else {
            // Partial-fillable: honour the signer's MINIMUM slice size (`amount`)
            // and never strand sub-minimum dust. A keeper may not fill below
            // `amount`, nor leave a remainder that is non-zero but < `amount`
            // (it would be an unfillable off-chain dust remainder). `_materialize
            // Slice` rewrites the slice to a single value, so `previewMatch` can
            // no longer see the signed minimum — it must be enforced HERE.
            if (fillAmount < o.amount) {
                revert SignedOfferFillInvalid(fillAmount, remaining);
            }
            uint256 postRemainder = remaining - fillAmount;
            if (postRemainder != 0 && postRemainder < o.amount) {
                revert SignedOfferFillInvalid(fillAmount, remaining);
            }
        }
    }

    /// @dev Materialize the signed-offer SLICE (size `fillAmount`) as an
    ///      on-chain offer via the self-gated `OfferCreateFacet.createSigned
    ///      OfferVault` (vault-backed). Built params + low-level
    ///      `abi.encodeWithSelector` + `.call` keep the 26-field struct encode
    ///      under viaIR's stack ceiling (the v0.5 pattern). Bubbles the inner
    ///      revert (e.g. SignedOfferUnsupportedShape / InsufficientFreeBalance).
    function _materializeSlice(
        LibSignedOffer.SignedOffer calldata o,
        uint256 filledBefore,
        uint256 fillAmount
    ) private returns (uint256 sliceOfferId) {
        LibVaipakam.CreateOfferParams memory params =
            LibSignedOffer.toCreateOfferParams(o, filledBefore, fillAmount);
        // slither-disable-next-line low-level-calls
        (bool ok, bytes memory res) = address(this).call(
            abi.encodeWithSelector(
                OfferCreateFacet.createSignedOfferVault.selector, o.signer, params,
                LibSignedOffer.makerFullFor(o, filledBefore, fillAmount) // #1949 — the slice's cumulative share
            )
        );
        if (!ok) {
            if (res.length > 0) {
                assembly {
                    revert(add(res, 0x20), mload(res))
                }
            }
            revert LibOfferMatchExecute.SignedOfferMaterializeFailed();
        }
        sliceOfferId = abi.decode(res, (uint256));
    }
}
