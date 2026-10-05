// src/facets/OfferMatchFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
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
 * @title OfferMatchFacet
 * @author Vaipakam Developer Team
 * @notice Range Orders Phase 1 — bot-driven offer matching surface.
 *         Hosts the two entry points the keeper-bot consumes:
 *           - `previewMatch(L, B, matcher, initiator)` — pure preview that runs the
 *             validity matrix + computes the midpoint match terms
 *             so bots filter candidate pairs without paying for
 *             reverting txs.
 *           - `matchOffers(L, B)` — permissionless write that
 *             executes the match: pulls vaulted assets, mints the
 *             position NFTs, initiates the loan, refunds excess
 *             collateral, dust-closes the lender offer when its
 *             remaining range capacity drops below the per-match
 *             minimum, and pays the matcher kickback.
 *
 * @dev Carved out of `OfferFacet` to bring `OfferFacet`'s runtime
 *      bytecode under the EIP-170 24576-byte ceiling — the Range
 *      Orders Phase 1 work pushed it ~4KB over. Conceptually this
 *      is the right cut anyway: matching is bot-facing and
 *      semantically distinct from create / accept / cancel.
 *
 *      Cross-facet reuse: `matchOffers` reuses the heavy LIF +
 *      vault + NFT-mint + loan-init plumbing already in
 *      `OfferFacet._acceptOffer` by calling
 *      `OfferFacet.acceptOfferInternal(...)` through the diamond
 *      fallback. The internal entry point gates on
 *      `msg.sender == address(this)` so EOAs can never call it
 *      directly. Reentrancy: the outer `matchOffers` here holds the
 *      shared `nonReentrant` lock on diamond storage, so the
 *      internal entry point on OfferFacet must NOT also try to
 *      acquire it (double-acquire would deadlock); it relies on
 *      the outer lock for safety, which is the standard pattern
 *      across the codebase.
 *
 *      #1219 (S-4) — HOST SPLIT. `matchIntent` (the standing-intent fill the
 *      solver / backstop / adapter routes enter) lives in
 *      `OfferMatchIntentFacet` since the capacity gates landed: this facet
 *      sat 293 B under EIP-170, less than one cross-facet call, so the three
 *      fill gates could not inline here. The match-execution core both hosts
 *      share — `LibOfferMatchExecute.executeMatch`, with the events and
 *      errors it owns — is ONE library inlined by both: one source, two
 *      hosts. Same storage, same Diamond, same selectors for every caller;
 *      only the runtime bytecode is split.
 */
contract OfferMatchFacet is DiamondReentrancyGuard, DiamondPausable {

    /// @notice Range Orders Phase 1 — bot-facing preview of a candidate
    ///         (lender, borrower) match. Pure view; runs the validity
    ///         matrix (§4.1) + computes midpoint terms (§4.2) + the
    ///         synthetic HF check via `LibRiskMath`. Bots filter
    ///         candidate pairs against this before submitting
    ///         `matchOffers` to avoid paying for reverting txs.
    /// @return result Structured outcome — see `LibOfferMatch.MatchResult`.
    ///         `errorCode == Ok` means `matchOffers(lenderOfferId,
    ///         borrowerOfferId)` would succeed at this block; the
    ///         struct also carries the concrete (matchAmount,
    ///         matchRateBps, reqCollateral, lenderRemainingPostMatch)
    ///         values so the bot can estimate gain pre-submission.
    /// @param  matcher The account that would call `matchOffers`. Named, never
    ///         read from `msg.sender` (#2459 r2): an off-chain `eth_call` carries no
    ///         sender unless set, and the zero address's never-seen bucket always
    ///         reads covered, so a sender-keyed preview told an exhausted keeper
    ///         (and the app's matcher) that a doomed match would succeed.
    /// @param  initiator The transaction's originator — the account the charge
    ///         falls to when `matcher` is an aggregator adapter with no bound
    ///         operator (#2459 r4: the route's other input, named for the same
    ///         reason). For a matcher that sends its own transaction, the matcher.
    function previewMatch(uint256 lenderOfferId, uint256 borrowerOfferId, address matcher, address initiator)
        external
        view
        returns (LibOfferMatch.MatchResult memory result)
    {
        result = LibOfferMatch.previewMatch(lenderOfferId, borrowerOfferId);
        // #1219 review — the match's capacity charge is its last step, so it is
        // this preview's last check, for the actor `matchOffers` would charge.
        if (
            result.errorCode == LibOfferMatch.MatchError.Ok
                && !LibServiceCapacity.fillCovered(LibVaipakam.storageSlot(), matcher, initiator)
        ) result.errorCode = LibOfferMatch.MatchError.CapacityExhausted;
    }

    /// @notice Range Orders Phase 1 — match a lender offer against a
    ///         borrower offer. Permissionless; `msg.sender` is recorded
    ///         on the resulting loan as the matcher and receives the
    ///         LIF kickback (see `cfgLifMatcherFeeBps`) at terminal
    ///         (lender-asset path: at match via `_acceptOffer` LIF
    ///         split; VPFI path: at proper close / default via
    ///         `LibVPFIDiscount`).
    /// @dev    Gated on the `partialFillEnabled` master flag (default
    ///         off on a fresh deploy). When active, validates via
    ///         `LibOfferMatch.previewMatch`, sets the per-tx
    ///         `matchOverride` slot with midpoint terms + counterparty
    ///         + matcher addresses, calls into
    ///         `OfferFacet.acceptOfferInternal` (cross-facet) reusing
    ///         the existing vault + LIF + NFT + LoanFacet plumbing,
    ///         then increments the lender offer's `amountFilled` and
    ///         auto-closes on dust.
    ///         The borrower offer is single-fill in Phase 1 (per
    ///         design §10.1), so `_acceptOffer` flips its `accepted`
    ///         to true; the lender offer is preserved (storage stays)
    ///         when partial-filled, deleted when fully filled or
    ///         dust-closed.
    /// @return loanId  The newly initiated loan.
    function matchOffers(uint256 lenderOfferId, uint256 borrowerOfferId)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 loanId)
    {
        // #494 Card A — Tier-1 sanctions gate on the matcher.
        // matchOffers pays the matcher a 1% LIF kickback (per the
        // range-orders design); paying a sanctioned matcher is the
        // exact thing the OFAC screen exists to prevent. The two
        // offer creators were already sanctions-checked at offer-
        // create time, so this single check covers the matcher.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.partialFillEnabled) {
            // Master kill-switch: matching infra dormant until governance
            // enables it post-bake.
            revert LibOfferMatchExecute.FunctionDisabled(3);
        }

        // No borrower collateral floor: two on-chain offers each accepted
        // their own single-value / ranged collateral semantics at create time.
        loanId = LibOfferMatchExecute.executeMatch(lenderOfferId, borrowerOfferId, 0);
        // #1219 — one fill, charged LAST (a refused charge reverts the match whole)
        // to the actor the route names for the matcher (`LibServiceCapacity.routeActor`
        // — the same rule {previewMatch} checks, #2459 r4), so the preview reports it
        // as its last check.
        LibServiceCapacity.chargeSolver();
    }

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
    /// @notice The signed offer's signature deadline has passed.
    error SignedOfferSigExpired(uint256 deadline);
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
        // active index, clear the reverse map, burn the orphan NFT. (A BORROWER
        // slice needs none of this: its token carries over to
        // `loan.borrowerTokenId` and onLoanInitiated owns the cleanup.)
        if (signedIsLender) {
            LibMetricsHooks.onOfferAccepted(sliceOfferId);
            uint256 slicePosToken = s.offers[sliceOfferId].positionTokenId;
            delete s.offerIdByPositionTokenId[slicePosToken];
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.burnNFT.selector, slicePosToken
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
        if (o.deadline != 0 && block.timestamp > o.deadline) {
            revert SignedOfferSigExpired(o.deadline);
        }
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
                LibSignedOffer.makerFullFor(o, fillAmount) // #1949 — the slice's pro-rata share
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
