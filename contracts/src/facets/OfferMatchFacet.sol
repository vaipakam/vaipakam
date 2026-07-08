// src/facets/OfferMatchFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibAutoRefinanceCheck} from "../libraries/LibAutoRefinanceCheck.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {RefinanceFacet} from "./RefinanceFacet.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {LibSignedOffer} from "../libraries/LibSignedOffer.sol";
import {RiskPreviewFacet} from "./RiskPreviewFacet.sol";

/**
 * @title OfferMatchFacet
 * @author Vaipakam Developer Team
 * @notice Range Orders Phase 1 — bot-driven offer matching surface.
 *         Hosts the two entry points the keeper-bot consumes:
 *           - `previewMatch(L, B)` — pure preview that runs the
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
 */
contract OfferMatchFacet is DiamondReentrancyGuard, DiamondPausable {
    /// @dev Re-declared from OfferFacet so the same topic0 lands on
    ///      every match regardless of which facet emits — indexers
    ///      filter by signature, so this stays compatible with
    ///      whatever was indexing OfferFacet.OfferMatched before
    ///      the split.
    /// @notice Phase 1 Day 3 — extended (per EventSourcingAudit §3.4)
    ///         with the borrower-side post-match state so consumers no
    ///         longer need a parallel `getOffer(borrowerOfferId)` read.
    /// @param borrowerAmountFilled Post-match `s.offers[borrowerOfferId]
    ///        .amountFilled`. Phase 1 borrower offers are single-fill,
    ///        so this is `borrowerOffer.amount` once accepted; the
    ///        field becomes load-bearing in Phase 2 (borrower partials).
    /// @param borrowerAccepted Post-match `s.offers[borrowerOfferId]
    ///        .accepted` boolean — true once the borrower offer is
    ///        fully consumed.
    /// @custom:event-category state-change/offer-mutation
    event OfferMatched(
        uint256 indexed lenderOfferId,
        uint256 indexed borrowerOfferId,
        uint256 indexed loanId,
        address matcher,
        uint256 matchAmount,
        uint256 matchRateBps,
        uint256 lenderRemainingPostMatch,
        uint256 lifMatcherFee,
        uint256 borrowerAmountFilled,
        bool borrowerAccepted
    );

    /// @dev Re-declared from OfferFacet for the same reason.
    enum OfferCloseReason { FullyFilled, Dust, Cancelled }
    /// @custom:event-category state-change/offer-mutation
    event OfferClosed(uint256 indexed offerId, OfferCloseReason reason);

    // ── Errors ──────────────────────────────────────────────────────
    error InvalidOfferType();
    error OfferAlreadyAccepted();
    error FunctionDisabled(uint8 whichFlag);
    error AssetMismatch();
    error AmountNoOverlap();
    error RateNoOverlap();
    error CollateralBelowRequired();
    error DurationMismatch();
    error MatchHFTooLow();
    error VaultWithdrawFailed();
    /// @notice #576 — a refinance-tagged offer was passed to `matchOffers`.
    ///         Refinance-tagged offers carry a collateral carry-over contract
    ///         that only the direct accept-and-refinance path can honour
    ///         atomically, so they are excluded from the partial-fill matcher.
    error RefinanceTaggedOfferNotMatchable();
    /// @notice #951 (redesign D3) — a lender position-sale vehicle (a Borrower
    ///         offer linked via `saleOfferToLoanId`) cannot be filled through the
    ///         range matcher; it is a full, all-or-nothing transfer accepted only
    ///         through the direct `acceptOffer` path. See LenderSaleVehicleRedesign.md.
    error SaleVehicleNotMatchable();
    /// @notice #1001 (S3, Codex #1070) — a linked Preclose Option-3 offset offer
    ///         (`offsetOfferToLoanId[lenderOfferId] != 0`) cannot be filled
    ///         through the matcher; it must settle via the direct `acceptOffer` →
    ///         `completeOffsetInternal` path so the old lender is paid at
    ///         completion. Bots skip it at preview.
    error OffsetVehicleNotMatchable();
    /// @notice #595 — an admitted carry-over match where the lender's pro-rated
    ///         collateral requirement exceeds the carried (pinned) amount.
    error RefinanceCarryOverCollateralShortfall();
    /// @notice #633 — the #398 aggregator-adapter feature is paused by governance,
    ///         so an aggregator's intent cannot be filled (user intents still can).
    error AggregatorAdaptersPaused();

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
    function previewMatch(uint256 lenderOfferId, uint256 borrowerOfferId)
        external
        view
        returns (LibOfferMatch.MatchResult memory result)
    {
        return LibOfferMatch.previewMatch(lenderOfferId, borrowerOfferId);
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
            revert FunctionDisabled(3);
        }

        // No borrower collateral floor: two on-chain offers each accepted
        // their own single-value / ranged collateral semantics at create time.
        return _executeMatch(lenderOfferId, borrowerOfferId, 0);
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
    /// @notice The slice materialize cross-facet call reverted with no data.
    error SignedOfferMaterializeFailed();
    /// @notice Burning the consumed transient lender-slice position NFT failed.
    error NFTBurnFailed();
    /// @notice A matched signed offer's collateral:principal ratio is not
    ///         constant across its range (collMin:amount != collMax:amountMax).
    ///         A non-constant ratio is not sliceable; use separate offers or AON.
    error SignedOfferRatioNotConstant();

    // ─── #393 v1-b — LenderIntentVault fill path ─────────────────────────

    /// @notice A keeper/solver filled a lender's standing intent against an
    ///         on-chain borrower counterparty, materializing the slice loan.
    event IntentMatched(
        address indexed lender,
        address indexed matcher,
        address lendingAsset,
        address collateralAsset,
        uint256 sliceOfferId,
        uint256 counterpartyOfferId,
        uint256 loanId,
        uint256 fillAmount
    );

    /// @notice No active standing intent for `(lender, lendingAsset, collateralAsset)`.
    error LenderIntentInactive();
    /// @notice `fillAmount` is below the intent's `minFillAmount`, or zero.
    error LenderIntentFillBelowMin();
    /// @notice This fill would push the intent's live principal past `maxExposure`.
    error LenderIntentExposureExceeded();
    /// @notice The counterparty offer's term exceeds the intent's `maxDurationDays`.
    error LenderIntentDurationTooLong();
    /// @notice The counterparty offer disables the full-term-interest floor
    ///         (`useFullTermInterest == false`). An intent loan must carry the
    ///         floor so a borrower can't escape the lender's committed interest
    ///         by repaying / preclosing early (the synthesis E3 election). The
    ///         solver must pick a counterparty that honours it.
    error LenderIntentFullTermRequired();
    /// @notice The counterparty offer allows partial repayment
    ///         (`allowsPartialRepay == true`), which charges only pro-rata
    ///         interest on the repaid slice and so escapes the committed-interest
    ///         economics the full-term floor protects. The standing intent has no
    ///         opt-in for it, so an intent fill must be full-repay-only.
    error LenderIntentPartialRepayNotAllowed();
    /// @notice The init-LTV-cap collateral floor is unresolvable (missing oracle
    ///         price / illiquid collateral), so the intent's LTV ceiling can't be
    ///         enforced — refuse rather than open a loan blind to the bound.
    error LenderIntentCollateralUnresolvable();
    /// @notice VPFI cannot be filled as an intent's lending asset (#393 v1-d.1
    ///         Codex round-3). Catches the rotation/pre-gate edge where a row's
    ///         `lendingAsset` became `vpfiToken` after it was funded — filling
    ///         it would disburse VPFI through the generic path, bypassing the
    ///         discount/staking rollup. Same selector as
    ///         `LenderIntentFacet.LenderIntentVpfiLendingUnsupported`.
    error LenderIntentVpfiLendingUnsupported();

    /// @notice Keeper-matcher fill of a **vault-backed** signed offer against
    ///         an on-chain counterparty offer — full or partial. The keeper
    ///         (`msg.sender`) earns the 1% LIF. Each call materializes EXACTLY
    ///         the slice it fills (single-value → fully consumed, no dangling
    ///         on-chain offer) and decrements the OFF-chain `signedOfferFilled`
    ///         ledger; successive calls partial-fill the off-chain offer. The
    ///         match's collateral/HF safety is enforced by
    ///         `LibOfferMatch.previewMatch` inside `_executeMatch`.
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
            revert FunctionDisabled(3);
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
        // Route the slice into the correct side-slot. _executeMatch processes
        // the BORROWER offer via acceptOfferInternal and injects the LENDER as
        // the counterparty, so the slice goes in whichever slot matches its
        // own offerType. `msg.sender` (the keeper) is preserved as the matcher
        // because _executeMatch is an INTERNAL call.
        bool signedIsLender =
            LibVaipakam.OfferType(o.offerType) == LibVaipakam.OfferType.Lender;
        // Signed-BORROWER slice: pin the loan collateral to the signer's
        // interpolated floor for this fill (the slice's own `collateralAmount`,
        // == its `collateralAmountMax`). See `_executeMatch`'s borrowerCollFloor
        // doc + the #616 P1 rationale. Signed-LENDER: 0 (the on-chain borrower
        // counterparty governs its own collateral).
        loanId = signedIsLender
            ? _executeMatch(sliceOfferId, counterpartyOfferId, 0)
            : _executeMatch(
                counterpartyOfferId,
                sliceOfferId,
                s.offers[sliceOfferId].collateralAmount
            );

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
                NFTBurnFailed.selector
            );
        }

        emit SignedOfferMatched(
            orderHash, o.signer, msg.sender, sliceOfferId, counterpartyOfferId, loanId, fillAmount
        );
    }

    /// @notice #393 v1-b — fill a lender's STANDING INTENT against an on-chain
    ///         borrower counterparty. The solver (`msg.sender`) earns the 1% LIF.
    ///         Materializes a single-fill lender offer from the intent's bounds —
    ///         rate floor `[minRateBps, MAX_INTEREST_BPS]`, the counterparty's
    ///         term (≤ `maxDurationDays`), and the collateral the intent's
    ///         `maxInitLtvBps` requires — with `creator = lender`, then routes it
    ///         through the same audited `_executeMatch` as `matchOffers`. The
    ///         lender stays lender-of-record (`loan.lender == lender`), so every
    ///         downstream claim/VPFI/KYC/sanctions site is unchanged.
    /// @param lender              The standing-intent owner (= loan lender).
    /// @param lendingAsset        ERC-20 the lender supplies (intent key).
    /// @param collateralAsset     ERC-20 collateral the lender accepts (intent key).
    /// @param counterpartyOfferId The on-chain BORROWER offer to fill against.
    /// @param fillAmount          Principal this match fills.
    /// @return loanId             The initiated loan.
    function matchIntent(
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint256 counterpartyOfferId,
        uint256 fillAmount
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        LibVaipakam._assertNotSanctioned(msg.sender); // solver = LIF recipient
        LibVaipakam._assertNotSanctioned(lender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Master gates: the matcher machinery (partialFillEnabled) + the
        // intent-path kill-switch. Both default off on a fresh deploy.
        if (!s.protocolCfg.partialFillEnabled) revert FunctionDisabled(3);
        if (!s.protocolCfg.lenderIntentEnabled) revert FunctionDisabled(4);
        // #633 — when the aggregator-adapter feature is paused, freeze fills of an
        // aggregator's intent specifically (user/backstop intents keep matching).
        if (
            s.isAggregatorAdapter[lender] &&
            LibVaipakam.cfgAggregatorAdaptersPaused()
        ) revert AggregatorAdaptersPaused();

        LibVaipakam.LenderIntent memory intent =
            s.lenderIntent[lender][lendingAsset][collateralAsset];
        if (!intent.active) revert LenderIntentInactive();
        // #393 v1-d.1 (Codex round-3 P2) — block a VPFI-lending FILL even for a
        // pre-existing intent whose `lendingAsset` became `vpfiToken` via a
        // post-funding rotation (the fund/root gates can't catch a row funded
        // before the rotation). Without this, the unlien + materialize below
        // would disburse VPFI through the generic vault/offer path, bypassing
        // the discount/staking rollup. Leaves only the wind-down exit
        // (`withdrawLenderIntentCapital`, which checkpoints the rollup).
        if (lendingAsset == s.vpfiToken) {
            revert LenderIntentVpfiLendingUnsupported();
        }
        // #393 v1-c — permissioned-solver gate. A `requiresKeeperAuth` intent may
        // only be filled by the lender themselves or a solver the lender has
        // authorized for `KEEPER_ACTION_SIGNED_FILL` (pre-loan, principal-keyed).
        // An un-opted intent (the default) stays openly fillable by any solver.
        if (intent.requiresKeeperAuth) {
            LibAuth.requireKeeperForPrincipal(
                LibVaipakam.KEEPER_ACTION_SIGNED_FILL, lender
            );
        }

        if (fillAmount < intent.minFillAmount) revert LenderIntentFillBelowMin();
        uint256 live = s.lenderIntentLivePrincipal[lender][lendingAsset][collateralAsset];
        if (live + fillAmount > intent.maxExposure) {
            revert LenderIntentExposureExceeded();
        }
        // Honour the lender's max term. Offers carry a single `durationDays`, and
        // `previewMatch` requires both sides match, so the loan term is exactly
        // the counterparty's — cap it against the intent here.
        if (s.offers[counterpartyOfferId].durationDays > intent.maxDurationDays) {
            revert LenderIntentDurationTooLong();
        }
        // The loan inherits the accepted (borrower) offer's `useFullTermInterest`
        // (LoanFacet snapshots it from `counterpartyOfferId`). An intent loan must
        // carry the full-term floor so a borrower can't post an in-bounds offer
        // that disables it and then repay/preclose early below the lender's
        // committed interest (synthesis E3). Require the counterparty honour it.
        if (!s.offers[counterpartyOfferId].useFullTermInterest) {
            revert LenderIntentFullTermRequired();
        }
        // Likewise reject partial-repay: `repayPartial` charges only pro-rata
        // interest on the repaid slice, escaping the committed-interest economics
        // the full-term floor protects. The intent has no opt-in, so an intent
        // fill is full-repay-only (keeps `loan.principal` == the reserved fill,
        // and the exposure accounting exact).
        if (s.offers[counterpartyOfferId].allowsPartialRepay) {
            revert LenderIntentPartialRepayNotAllowed();
        }
        // Derive the collateral the intent's init-LTV ceiling requires for this
        // fill. The materialized lender offer demands it; `previewMatch` enforces
        // the borrower posts ≥ it. Unresolvable (missing oracle / illiquid
        // collateral) ⇒ refuse rather than open a loan blind to the LTV bound.
        uint256 reqColl = LibRiskMath.minCollateralForLtvCap(
            fillAmount, lendingAsset, collateralAsset, intent.maxInitLtvBps
        );
        if (reqColl == 0 || reqColl == type(uint256).max) {
            revert LenderIntentCollateralUnresolvable();
        }

        // #393 v1-d — the intent's funded capital is held as a LIEN (it is not
        // free balance, so no other withdraw door can drain it). Release this
        // fill's slice from the intent-capital lien FIRST so the materialize
        // path below sees it as free balance and can re-lock it as the
        // offer-principal lien. `unlienIntentCapital` reverts
        // `IntentCapitalInsufficient` if the slice exceeds the funded capital —
        // a fill can never lend more than the lender has funded. (This is the
        // hard funding guard; `maxExposure` checked above is the declared cap.)
        LibEncumbrance.unlienIntentCapital(
            lender, lendingAsset, collateralAsset, fillAmount
        );
        // #625 WI-2a — the draw-down may have depleted the intent's funded capital ⇒
        // re-sync the discovery registry (de-lists it from the keeper feed if now 0).
        LibVaipakam.syncIntentRegistry(lender, lendingAsset, collateralAsset);

        // Materialize the single-fill lender slice (creator = lender; consumes
        // the just-freed slice from the lender's vault + creates the
        // offer-principal lien).
        uint256 sliceOfferId = _materializeIntentSlice(
            _intentSliceParams(
                lendingAsset,
                collateralAsset,
                fillAmount,
                reqColl,
                intent.minRateBps,
                s.offers[counterpartyOfferId].durationDays
            ),
            lender
        );

        // Shared core (lender direction; borrower is the counterparty).
        // `msg.sender` (the solver) is preserved as the matcher because this is
        // an INTERNAL call.
        loanId = _executeMatch(sliceOfferId, counterpartyOfferId, 0);

        // Record exposure + the originating intent key (so the terminal-close
        // release survives a lender-position sale that mutates `loan.lender`).
        s.lenderIntentLivePrincipal[lender][lendingAsset][collateralAsset] =
            live + fillAmount;
        s.intentOrigin[loanId] = LibVaipakam.IntentOrigin({
            owner: lender,
            lendingAsset: lendingAsset,
            collateralAsset: collateralAsset,
            amount: fillAmount // release the ORIGINAL fill, not a partial-repaid remainder
        });
        // #625 WI-2c — register the loan in the roll-discovery set (removed when
        // its intentOrigin is cleared at terminal release / roll).
        LibVaipakam.addIntentLoan(loanId);

        // Transient lender-slice cleanup (identical to the signed-lender path):
        // the slice is the match ACCEPTOR, so its own OfferCreated NFT + reverse-
        // map entry are orphaned. Burn + unmap so it isn't a phantom open offer.
        LibMetricsHooks.onOfferAccepted(sliceOfferId);
        uint256 slicePosToken = s.offers[sliceOfferId].positionTokenId;
        delete s.offerIdByPositionTokenId[slicePosToken];
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector, slicePosToken),
            NFTBurnFailed.selector
        );

        emit IntentMatched(
            lender,
            msg.sender,
            lendingAsset,
            collateralAsset,
            sliceOfferId,
            counterpartyOfferId,
            loanId,
            fillAmount
        );
    }

    /// @dev Build the single-fill lender-slice `CreateOfferParams` for an intent
    ///      fill. Separate frame keeps `matchIntent`'s stack under the viaIR
    ///      ceiling (the wide struct build + cross-facet encode). Every field not
    ///      set is the memory zero-default (ERC20 token ids / quantities = 0,
    ///      `allows*` = false, `expiresAt`/`refinanceTargetLoanId` = 0).
    function _intentSliceParams(
        address lendingAsset,
        address collateralAsset,
        uint256 fillAmount,
        uint256 reqColl,
        uint256 minRateBps,
        uint256 durationDays
    ) private pure returns (LibVaipakam.CreateOfferParams memory p) {
        p.offerType = LibVaipakam.OfferType.Lender;
        p.lendingAsset = lendingAsset;
        p.amount = fillAmount;
        p.amountMax = fillAmount; // single-fill slice
        p.interestRateBps = minRateBps; // the lender's floor
        p.interestRateBpsMax = LibVaipakam.MAX_INTEREST_BPS; // accept any rate ≥ floor
        p.collateralAsset = collateralAsset;
        p.collateralAmount = reqColl; // init-LTV-cap requirement
        p.collateralAmountMax = reqColl;
        p.durationDays = durationDays; // == counterparty term (≤ maxDuration)
        p.assetType = LibVaipakam.AssetType.ERC20;
        p.collateralAssetType = LibVaipakam.AssetType.ERC20;
        p.prepayAsset = lendingAsset; // unused for ERC20 lend; non-zero placeholder
        p.creatorRiskAndTermsConsent = true; // consent captured at setLenderIntent
        p.fillMode = LibVaipakam.FillMode.Partial;
        p.periodicInterestCadence = LibVaipakam.PeriodicInterestCadence.None;
        // #625 WI-3 — deliberately leave `useFullTermInterest` / `allowsPartialRepay`
        // at their defaults (false) on the slice: the loan does NOT inherit them from
        // the lender slice. `matchIntent` requires the BORROWER offer to be
        // full-term + non-partial (`LenderIntentFullTermRequired` /
        // `LenderIntentPartialRepayNotAllowed`), and `LoanFacet._copyPrincipalAssetFields`
        // copies the loan's `useFullTermInterest` / `allowsPartialRepay` from the
        // accepted (borrower) offer — so the slice's values are never read for loan
        // terms. Setting them here would be a dead write. The resulting full-term +
        // no-partial guarantee on the loan is pinned by `LenderIntentMatch`'s
        // `test_matchIntent_fillsAndAttributesToLender`.
    }

    /// @dev Materialize an intent slice as an on-chain offer with `creator =
    ///      lender` via the self-gated vault-backed entry (pull-from-free-balance
    ///      + offer-principal lien). Bubbles the inner revert.
    function _materializeIntentSlice(
        LibVaipakam.CreateOfferParams memory params,
        address lender
    ) private returns (uint256 sliceOfferId) {
        // slither-disable-next-line low-level-calls
        (bool ok, bytes memory res) = address(this).call(
            abi.encodeWithSelector(
                OfferCreateFacet.createSignedOfferVault.selector, lender, params
            )
        );
        if (!ok) {
            if (res.length > 0) {
                assembly {
                    revert(add(res, 0x20), mload(res))
                }
            }
            revert SignedOfferMaterializeFailed();
        }
        sliceOfferId = abi.decode(res, (uint256));
    }

    /// @dev Pre-fill checks for a signed-offer match: deadline / GTT / nonce /
    ///      remaining + the AON-full-fill guard. Returns the order hash.
    function _vetSignedOfferForMatch(
        LibSignedOffer.SignedOffer calldata o,
        uint256 fillAmount
    ) private view returns (bytes32 orderHash) {
        if (o.deadline != 0 && block.timestamp > o.deadline) {
            revert SignedOfferSigExpired(o.deadline);
        }
        if (o.expiresAt != 0 && block.timestamp > o.expiresAt) {
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
                OfferCreateFacet.createSignedOfferVault.selector, o.signer, params
            )
        );
        if (!ok) {
            if (res.length > 0) {
                assembly {
                    revert(add(res, 0x20), mload(res))
                }
            }
            revert SignedOfferMaterializeFailed();
        }
        sliceOfferId = abi.decode(res, (uint256));
    }

    /// @dev #671 phase 2 (#728 PR-2b) — re-assert the progressive-risk gate for
    ///      BOTH paired offers' creators at the matcher, against the LIVE
    ///      tier/consent state, mirroring the create-time chokepoint
    ///      (`OfferCreateFacet`). The classification + PairId resolution
    ///      (including the borrower-offer-pair surface and the sale-vehicle
    ///      seller-exempt / buyer-gated split) lives in
    ///      `RiskPreviewFacet.assertMatchAllowed` — delegated via a cross-facet
    ///      call so the heavy classifier doesn't inline into this facet (which is
    ///      near the EIP-170 ceiling). The inner `RiskTierTooLow` /
    ///      `IlliquidPairNotConsented` revert bubbles. No-op unless
    ///      `riskAccessGateEnabled` (guarded so a gate-off match pays no
    ///      cross-call).
    function _assertMatchCreatorsRiskAccess(
        uint256 lenderOfferId,
        uint256 borrowerOfferId
    ) private {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return;
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                RiskPreviewFacet.assertMatchAllowed.selector,
                lenderOfferId,
                borrowerOfferId
            ),
            bytes4(0)
        );
    }

    /// @notice Shared match-execution core for `matchOffers` and the v0.6
    ///         `matchSignedOffer`. `msg.sender` (the matcher / LIF recipient)
    ///         is preserved because this is an internal call from both
    ///         entries — there is no `address(this)` cross-facet hop, so the
    ///         `matchOverride.matcher`, the `OfferMatched` `msg.sender`, and
    ///         the LIF split all resolve to the original external caller.
    /// @param lenderOfferId    The lender (lend) offer being matched.
    /// @param borrowerOfferId  The borrower (borrow) offer being matched.
    /// @param borrowerCollFloor A hard floor for the borrower collateral on this
    ///         match, forwarded into `previewMatch` so the floor is applied at
    ///         BOTH the lock and the HF/LTV gate (no post-hoc clamp). `0`
    ///         (matchOffers + the signed-LENDER direction) is a no-op,
    ///         byte-identical to the prior behaviour. Set non-zero ONLY by the
    ///         signed-BORROWER slice path, where the signer committed a
    ///         constant-ratio collateral for this fill that the engine's
    ///         single-value branch would otherwise refund away — see
    ///         `matchSignedOffer`. The slice pulls exactly this amount, so the
    ///         borrower-side refund nets to zero; clamping UP is always HF-safe.
    /// @return loanId          The newly initiated loan.
    function _executeMatch(
        uint256 lenderOfferId,
        uint256 borrowerOfferId,
        uint256 borrowerCollFloor
    )
        internal
        returns (uint256 loanId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // #595 — carry-over-aware matched refinance. A refinance-tagged BORROWER
        // offer is matchable ONLY as an AON carry-over match that passes the
        // exhaustive admission mirror of `RefinanceFacet._refinanceLoanLogic`
        // (`LibAutoRefinanceCheck.matchAdmissible` — the SAME predicate
        // `previewMatch` uses, so on-chain and preview agree). An AON single
        // full fill consumes the borrower offer in one slice, so the dust-close
        // retag hook below fires in the SAME tx (no uncollateralized window —
        // design §2/§3), the matched collateral is pinned to the carried amount
        // (no identity-gate divergence), and the old lien is retagged atomically.
        // A LENDER offer is never refinance-tagged. Anything tagged that fails
        // admission reverts here, exactly as the atomic path would.
        if (s.offers[lenderOfferId].refinanceTargetLoanId != 0) {
            revert RefinanceTaggedOfferNotMatchable();
        }
        // #951 (redesign D3) — a lender position-sale vehicle is a full-principal,
        // all-or-nothing transfer accepted ONLY through the direct `acceptOffer`
        // path, where `offer.accepted` is set before the auto-complete hop. On the
        // match path `_acceptOffer` defers the accepted-flip to the dust-close
        // block (partialFillEnabled), which runs AFTER the auto-complete would
        // call `completeLoanSaleInternal` — so a matched sale vehicle reverts
        // `SaleOfferNotAccepted`. Reject the pair up front (bots skip it at
        // preview), rather than thread the flip earlier: a position sale is not a
        // range/partial order. See LenderSaleVehicleRedesign.md D3.
        if (s.saleOfferToLoanId[borrowerOfferId] != 0) {
            revert SaleVehicleNotMatchable();
        }
        // #1001 (S3, Codex #1070 r4) — a linked Preclose Option-3 offset offer is
        // a LENDER offer that MUST settle through `completeOffsetInternal`, which
        // only fires on the direct `acceptOffer` path (the auto-complete hop keys
        // on the accepted offer's `offsetOfferToLoanId`). On the match path the
        // accepted-flip defers to the dust-close block and the offset auto-
        // complete never runs, so a matched offset would consume the vehicle
        // WITHOUT settling the old lender — leaving the original loan Active with a
        // live link + NFT lock and, once time drifts past the maturity guard, no
        // recovery even by manual `completeOffset`. Reject up front (bots skip it
        // at preview), exactly as the sale vehicle is rejected above. An offset is
        // a full-principal transfer, not a range/partial order.
        if (s.offsetOfferToLoanId[lenderOfferId] != 0) {
            revert OffsetVehicleNotMatchable();
        }
        {
            uint256 bRefiTarget =
                s.offers[borrowerOfferId].refinanceTargetLoanId;
            if (
                bRefiTarget != 0 &&
                !LibAutoRefinanceCheck.matchAdmissible(
                    s, bRefiTarget, s.offers[borrowerOfferId]
                )
            ) {
                revert RefinanceTaggedOfferNotMatchable();
            }
        }

        // Pre-flight via the shared core; map structured errors into
        // typed reverts declared on this facet.
        LibOfferMatch.MatchResult memory mr =
            LibOfferMatch.previewMatch(
                lenderOfferId, borrowerOfferId, borrowerCollFloor
            );
        if (mr.errorCode != LibOfferMatch.MatchError.Ok) {
            if (mr.errorCode == LibOfferMatch.MatchError.AssetMismatch
                || mr.errorCode == LibOfferMatch.MatchError.AssetTypeMismatch) {
                revert AssetMismatch();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.AmountNoOverlap) {
                revert AmountNoOverlap();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.RateNoOverlap) {
                revert RateNoOverlap();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.CollateralBelowRequired) {
                revert CollateralBelowRequired();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.OfferAccepted) {
                revert OfferAlreadyAccepted();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.DurationMismatch) {
                revert DurationMismatch();
            }
            if (mr.errorCode == LibOfferMatch.MatchError.HFTooLow) {
                revert MatchHFTooLow();
            }
            // #194 — same-creator on both sides surfaces through the
            // `previewMatch` classifier here BEFORE the cross-facet
            // call reaches `_acceptOffer`'s load-bearing
            // `SelfTradeForbidden` revert. Re-raise the same typed
            // error from this facet so a matcher submitting via
            // `matchOffers` sees the SAME revert ABI the direct-accept
            // path returns. Argument is the colliding creator address
            // (lender offer creator == borrower offer creator).
            if (mr.errorCode == LibOfferMatch.MatchError.SelfTrade) {
                revert OfferAcceptFacet.SelfTradeForbidden(
                    s.offers[lenderOfferId].creator
                );
            }
            // #195 — surface the GTT terminal classifier with the
            // expired offer's id so the matcher (bot or otherwise) gets
            // a non-ambiguous revert. Either side can be the expired
            // offer; pick whichever lapsed (lender first so the report
            // is deterministic when both expired in the same second).
            // Re-raises the same typed error the direct-accept path
            // returns so the ABI is uniform across both entry points.
            if (mr.errorCode == LibOfferMatch.MatchError.OfferExpired) {
                LibVaipakam.Offer storage l_ = s.offers[lenderOfferId];
                if (LibVaipakam.isOfferExpired(l_)) {
                    revert OfferAcceptFacet.OfferExpired(
                        lenderOfferId,
                        l_.expiresAt
                    );
                }
                LibVaipakam.Offer storage b_ = s.offers[borrowerOfferId];
                revert OfferAcceptFacet.OfferExpired(
                    borrowerOfferId,
                    b_.expiresAt
                );
            }
            // #125 — AON terminal: the match would land a partial-fill
            // against an AON offer, which violates its "single full
            // fill" contract. Surface the offending offerId so the
            // matcher's revert decoder can render "offer X is AON;
            // your match would have only filled Y of Z." Pick the
            // AON side (lender first deterministically when both
            // carry AON).
            if (mr.errorCode == LibOfferMatch.MatchError.AonRequiresFullFill) {
                LibVaipakam.Offer storage lAon = s.offers[lenderOfferId];
                if (lAon.fillMode == LibVaipakam.FillMode.Aon) {
                    revert OfferAcceptFacet.AonRequiresFullFill(
                        lenderOfferId,
                        lAon.amount,
                        mr.matchAmount
                    );
                }
                LibVaipakam.Offer storage bAon = s.offers[borrowerOfferId];
                revert OfferAcceptFacet.AonRequiresFullFill(
                    borrowerOfferId,
                    bAon.amount,
                    mr.matchAmount
                );
            }
            // #595 — an admitted carry-over match where the lender's pro-rated
            // collateral requirement exceeds the carried (pinned) amount.
            // Surface a dedicated revert (not the generic InvalidOfferType) so
            // callers can distinguish it from a malformed offer.
            if (
                mr.errorCode ==
                LibOfferMatch.MatchError.RefinanceCarryOverCollateralShortfall
            ) {
                revert RefinanceCarryOverCollateralShortfall();
            }
            revert InvalidOfferType();
        }

        // #671 phase 2 (#728 PR-2b) — keeper-match risk re-assertion. The
        // acceptor-side gate in `LoanFacet._maybeRunInitialRiskGates` is scoped
        // to the direct-accept path (`acceptAckActive == true`) and is SKIPPED on
        // the keeper-match path (a match sets no accept-ack — both sides are
        // self-authored offers, design §5), so neither party is re-validated
        // downstream. Re-assert HERE — before any state mutation. The gated
        // parties + the pair they are gated against are resolved in
        // `RiskPreviewFacet.assertMatchAllowed`: a normal match gates BOTH
        // creators against the BORROWER offer's pair (the resulting loan copies
        // its token ids / prepay from that offer, so the lender must consent to
        // the pair it actually joins, not its own offer's possibly-different
        // pair); a lender-sale-vehicle borrower offer instead exempts the exiting
        // seller and gates only the buyer (the lender-offer creator acquiring the
        // sold position) against the LINKED loan's pair — mirroring the
        // sale-vehicle accept semantics (PR-2a). Standing consent only (no #662
        // ack on this path). No-op unless the kill-switch is on.
        _assertMatchCreatorsRiskAccess(lenderOfferId, borrowerOfferId);

        // ── State mutation: install the match override. See the
        // matching docstring on `OfferFacet._acceptOffer` for the
        // override-slot consumer side. `mr.reqCollateral` already reflects the
        // signed-borrower floor (threaded into previewMatch above), so the
        // override, the offer-lien decrement, and the dust-close refund all
        // key off the SAME value and stay consistent.
        LibVaipakam.MatchOverride storage mo = s.matchOverride;
        mo.amount = mr.matchAmount;
        mo.rateBps = mr.matchRateBps;
        mo.collateralAmount = mr.reqCollateral;
        mo.counterparty = s.offers[lenderOfferId].creator;
        mo.matcher = msg.sender;
        mo.active = true;

        // T-407-C (#566) — decrement the lender's offer-principal lock
        // by this fill BEFORE `acceptOfferInternal` withdraws the same
        // `mr.matchAmount` of principal from the lender's vault below.
        // The lock was created at offer-create over the full `amountMax`;
        // each fill draws a slice out, so the lien must shrink in lock-
        // step or the vault-withdraw chokepoint would treat the slice as
        // still encumbered and revert the disbursement. The remaining
        // lock (covering the still-unfilled capacity) is released at the
        // dust-close block below. No-op on a lender offer that never
        // carried a lock (defensive — match-eligible lender offers are
        // always ERC20).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.decrementOfferPrincipalLien.selector,
                lenderOfferId,
                mr.matchAmount
            ),
            bytes4(0)
        );

        // Cross-facet call into OfferFacet's internal acceptor entry
        // — same body as `OfferFacet.acceptOffer`, but without
        // re-acquiring the (already-held) nonReentrant lock. The
        // `address(this)`-only guard inside acceptOfferInternal
        // prevents EOAs from calling it directly.
        bytes memory ret = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                OfferAcceptFacet.acceptOfferInternal.selector,
                borrowerOfferId,
                /* acceptorRiskAndTermsConsent */ true,
                /* usePermit */ false
            ),
            // Surface a clear typed revert on cross-facet failure;
            // the inner revert reason still bubbles via the helper.
            VaultWithdrawFailed.selector
        );
        loanId = abi.decode(ret, (uint256));

        // #573 — decrement the BORROWER offer's collateral lock by the
        // collateral this fill consumed. Done AFTER `acceptOfferInternal`
        // (Codex P1): the inner `_acceptOffer` pays the VPFI Loan-Initiation
        // Fee out of the borrower's vault BEFORE `initiateLoan` creates the
        // child loan's collateral lien. If the collateral asset is VPFI and
        // we decremented the offer lock BEFORE that, `reqCollateral` would
        // momentarily look free to the VPFI withdraw guard and the LIF
        // could be paid out of collateral meant to back the loan. Deferring
        // to here keeps the offer lock covering this fill's collateral
        // throughout the LIF; by now `createCollateralLien` has already
        // re-encumbered `reqCollateral` under the loan, so the net
        // aggregate is unchanged (offer-lock −reqCollateral, loan-lien
        // +reqCollateral). The unfilled remainder is released at the
        // borrower dust-close / single-fill refund below. No-op on a
        // borrower offer with no collateral lock (NFT collateral, or none).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.decrementOfferPrincipalLien.selector,
                borrowerOfferId,
                mr.reqCollateral
            ),
            bytes4(0)
        );

        // Clear the override now that the loan is initiated. Critical:
        // any subsequent same-tx initiateLoan calls (e.g., a follow-up
        // strategic flow) MUST fall through to the legacy field-read
        // path.
        delete s.matchOverride;

        // ── Borrower-side excess-collateral refund (Range Orders
        // Phase 1, symmetric with the lender-side dust-close below).
        //
        // OfferCreateFacet pre-vaults the borrower's collateral
        // UPPER bound at create-time (`offer.collateralAmountMax`,
        // post auto-collapse). The match locked `mr.reqCollateral`
        // — which is `clamp(reqFromLender, [B.collateralAmount,
        // B.collateralAmountMax])` per #164's clamp-up semantics.
        // The unused tail `B.collateralAmountMax - mr.reqCollateral`
        // is refunded to the borrower's wallet immediately so the
        // invariant "vault only holds collateral committed to an
        // active offer or live loan" stays clean. Since borrower
        // offers are single-fill in Phase 1, the tail can never be
        // reused by another match — leaving it in vault would trap
        // the funds. On a legacy single-value borrower offer
        // (auto-collapsed `collateralAmountMax == collateralAmount`)
        // this code path lands at the same numbers as the pre-#164
        // implementation, byte-for-byte.
        //
        // ERC-20 collateral only: NFT collateral (ERC-721 / ERC-1155)
        // is whole-or-nothing — the borrower posts exactly the token
        // ids and quantity the offer references, so reqCollateral
        // always equals borrowerOffer.collateralAmount and there's
        // never overage to refund.
        // Issue #102 — borrower-side per-match refund is now CONDITIONAL
        // on partial-fill mode. Under Phase 1 single-fill (the fallback
        // when `partialFillEnabled` is off), the entire excess
        // `collateralAmountMax - mr.reqCollateral` is refunded on the
        // first (and only) match — that's the existing #164 behaviour.
        // Under partial-fill (#102), the borrower's pre-vaulted
        // collateral STAYS in custody across matches; only the residual
        // is refunded on dust-close at the bottom of this function.
        // Distinguish via the same flag `OfferAcceptFacet._acceptOffer`
        // uses for the symmetric `accepted = true` deferral.
        if (!s.protocolCfg.partialFillEnabled) {
            LibVaipakam.Offer storage B = s.offers[borrowerOfferId];
            if (B.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                // #573 — single-fill fully consumes the borrower offer;
                // release the remaining offer-collateral lock BEFORE the
                // excess refund. After the per-fill decrement above the
                // lock equals exactly the excess about to be returned, so
                // leaving it active would block the creator's own refund.
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                        borrowerOfferId
                    ),
                    bytes4(0)
                );
                // Legacy fallback: a borrower offer created before
                // #164 carries `collateralAmountMax == 0` in storage.
                // Read-side then collapses to `collateralAmount` so
                // the pulled / refunded amounts agree with the pre-
                // #164 deposit.
                uint256 borrowerPulled = B.collateralAmountMax == 0
                    ? B.collateralAmount
                    : B.collateralAmountMax;
                if (borrowerPulled > mr.reqCollateral) {
                    uint256 excess = borrowerPulled - mr.reqCollateral;
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultWithdrawERC20.selector,
                            B.creator,           // pull from borrower's vault
                            B.collateralAsset,
                            B.creator,           // refund to borrower's wallet
                            excess
                        ),
                        VaultWithdrawFailed.selector
                    );
                }
            }
        }

        // ── Lender-side post-match accounting. Under Phase 1 single-
        // fill, the borrower offer was already marked `accepted = true`
        // by `_acceptOffer`; under #102 partial-fill, the borrower-side
        // accounting block BELOW handles the dust-close + accept-flip
        // for borrower offers (symmetric to this lender-side block).
        LibVaipakam.Offer storage L = s.offers[lenderOfferId];
        L.amountFilled += mr.matchAmount;
        uint256 lenderRemaining = L.amountMax - L.amountFilled;

        // Auto-close on dust: if the leftover can't satisfy the
        // lender's per-match minimum (`L.amount`), refund the dust to
        // the lender's wallet and flip `accepted = true`. The same
        // condition fires when the lender is fully filled
        // (`lenderRemaining == 0`).
        if (lenderRemaining < L.amount) {
            // T-407-C (#566) — the lender offer is now terminal (dust-
            // close or full-fill). Release whatever offer-principal lock
            // remains BEFORE the dust refund below. After this match's
            // decrement the residual lock equals `lenderRemaining`
            // exactly, so the release frees precisely the dust about to
            // be withdrawn; on a clean full-fill (`lenderRemaining == 0`)
            // the lock is already drained and the release just tombstones
            // the row. Pairs with the OfferAcceptFacet single-fill
            // release + the OfferCancelFacet release — every terminal a
            // lender offer can reach drops its lock exactly once.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                    lenderOfferId
                ),
                bytes4(0)
            );
            if (lenderRemaining > 0) {
                // Dust refund: pull the unfilled remainder back to the
                // lender's wallet. createOffer pre-vaulted amountMax;
                // _acceptOffer already pulled `mr.matchAmount` for the
                // borrower's principal, leaving `lenderRemaining` still
                // in custody. Lender ERC-20 only — NFT / ERC1155 lender
                // offers are single-fill (amount == amountMax) so this
                // branch is unreachable for them in practice.
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        L.creator,
                        L.lendingAsset,
                        L.creator,
                        lenderRemaining
                    ),
                    VaultWithdrawFailed.selector
                );
            }
            L.accepted = true;
            emit OfferClosed(
                lenderOfferId,
                lenderRemaining == 0
                    ? OfferCloseReason.FullyFilled
                    : OfferCloseReason.Dust
            );
        }

        // ── Borrower-side post-match accounting (Issue #102; symmetric
        // with the lender block above). Only fires when
        // `partialFillEnabled` is ON — otherwise the inner `_acceptOffer`
        // already flipped `accepted = true` on the borrower offer (Phase
        // 1 single-fill fallback). When ON, this block:
        //   - Increments `B.amountFilled` + `B.collateralAmountFilled`
        //     by the matched amounts.
        //   - Auto-closes on dust: if the leftover can't satisfy the
        //     borrower's per-match minimum (`B.amount`), refund the
        //     residual collateral to the borrower's wallet and flip
        //     `accepted = true`. Mirrors the lender-side dust-close
        //     condition exactly.
        LibVaipakam.Offer storage bm = s.offers[borrowerOfferId];
        if (s.protocolCfg.partialFillEnabled && !bm.accepted) {
            bm.amountFilled += mr.matchAmount;
            bm.collateralAmountFilled += mr.reqCollateral;
            // #183 (Canonical Limit-Order Phase 2): direct storage read
            // for the borrower's effective ceiling. The GTC derivation
            // (`amountMax == 0 → derive from collateralAmountMax ×
            // init-LTV cap`) is deleted — under the new invariant
            // `amountMax > 0`, storage never holds the zero sentinel.
            // Frontend computes the value at create-time and ships
            // explicit non-zero; see
            // `docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md` §5.
            uint256 effBorrowerAmountMax = bm.amountMax;
            uint256 borrowerRemaining = effBorrowerAmountMax - bm.amountFilled;
            if (borrowerRemaining < bm.amount) {
                // Dust-close: refund residual collateral and flip accepted.
                // #595 §3.4 — SKIP the offer-lock release + collateral refund for
                // a carry-over refinance offer: it pledged NO fresh collateral
                // (OfferCreateFacet's carry-over deposit/escrow-lock skips) and
                // its backing is the old loan's lien, untouched until the retag
                // hook below. Running the refund here would either revert at the
                // vault-withdraw guard (no free balance) or drain unrelated free
                // collateral. Only the accepted-flip, metrics hook, and retag run.
                if (
                    bm.collateralAssetType == LibVaipakam.AssetType.ERC20 &&
                    !bm.refinanceCarryOver
                ) {
                    // #573 — borrower offer is now terminal; release the
                    // remaining offer-collateral lock BEFORE the residual
                    // refund. After the per-fill decrements the lock equals
                    // `collateralAmountMax - collateralAmountFilled` — exactly
                    // the residual about to be returned — so leaving it
                    // active would block the refund. Pairs with the
                    // single-fill release above + the OfferAcceptFacet
                    // direct-accept hand-off: every terminal a borrower
                    // offer reaches drops its collateral lock exactly once.
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                            borrowerOfferId
                        ),
                        bytes4(0)
                    );
                    uint256 borrowerCollPulled = bm.collateralAmountMax == 0
                        ? bm.collateralAmount
                        : bm.collateralAmountMax;
                    if (borrowerCollPulled > bm.collateralAmountFilled) {
                        uint256 collRefund = borrowerCollPulled - bm.collateralAmountFilled;
                        LibFacet.crossFacetCall(
                            abi.encodeWithSelector(
                                VaultFactoryFacet.vaultWithdrawERC20.selector,
                                bm.creator,           // pull from borrower's vault
                                bm.collateralAsset,
                                bm.creator,           // refund to borrower's wallet
                                collRefund
                            ),
                            VaultWithdrawFailed.selector
                        );
                    }
                }
                bm.accepted = true;
                // Codex round-1 P1 — pair the metrics-hook fire with
                // the accept-flip. The hook was deferred by
                // `OfferAcceptFacet._acceptOffer` on every partial-fill
                // match against this borrower offer; we fire it ONCE
                // here at dust-close so the offer leaves the active-
                // discovery indexes at the moment it actually becomes
                // terminal. Two state changes (`accepted = true` +
                // active-list removal) stay tightly coupled and can't
                // drift.
                LibMetricsHooks.onOfferAccepted(borrowerOfferId);
                emit OfferClosed(
                    borrowerOfferId,
                    borrowerRemaining == 0
                        ? OfferCloseReason.FullyFilled
                        : OfferCloseReason.Dust
                );

                // T-092-H (#549) — atomic accept-and-refinance,
                // MATCHED path. Pairs the chain hook with the
                // deferred `accepted = true` flip just set above.
                // Without this hook the matched path would NOT
                // atomic-chain (Codex round-1 P2 on closed PR
                // #542). Mirrors the direct-path hook in
                // OfferAcceptFacet._acceptOffer.
                if (bm.refinanceTargetLoanId != 0) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            RefinanceFacet.refinanceLoanFromAccept.selector,
                            bm.refinanceTargetLoanId,
                            borrowerOfferId
                        ),
                        bytes4(0)
                    );
                }
            }
        }
        // §3.4 — borrower-side post-match snapshot.
        // Pre-#102 (single-fill): `amountFilled` storage stays 0 even
        //   when `accepted == true`; the event reports the EFFECTIVE
        //   post-match fill (= the offer's `amount` once accepted).
        // Post-#102 (partial-fill ON): `amountFilled` accumulates per
        //   match; the event reports it directly.
        uint256 borrowerEffFilled = (s.protocolCfg.partialFillEnabled || bm.amountFilled > 0)
            ? bm.amountFilled
            : (bm.accepted ? bm.amount : 0);
        emit OfferMatched(
            lenderOfferId,
            borrowerOfferId,
            loanId,
            msg.sender,
            mr.matchAmount,
            mr.matchRateBps,
            lenderRemaining,
            // lifMatcherFee: paid synchronously inside `_acceptOffer`'s
            // LIF split (lender-asset path) or zero (VPFI path —
            // settles at terminal). Computed here for the event so
            // downstream indexers can render the matcher's earnings
            // without re-deriving from the LIF settings. Reads the
            // governance-tunable matcher BPS from cfg, not the
            // constant.
            (mr.matchAmount * LibVaipakam.cfgLoanInitiationFeeBps()
                * LibVaipakam.cfgLifMatcherFeeBps())
                / (LibVaipakam.BASIS_POINTS * LibVaipakam.BASIS_POINTS),
            borrowerEffFilled,
            bm.accepted
        );
    }
}
