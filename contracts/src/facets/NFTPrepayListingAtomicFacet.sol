// src/facets/NFTPrepayListingAtomicFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibPrepayOrder} from "../libraries/LibPrepayOrder.sol";
import {LibPrepayListingWiring} from "../libraries/LibPrepayListingWiring.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IListingExecutorRecorder} from "../seaport/IListingExecutorRecorder.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {CollateralListingExecutor} from "../seaport/CollateralListingExecutor.sol";
import {
    ISeaportOrderHash,
    OrderComponents
} from "../seaport/ISeaportOrderHash.sol";
import {
    ISeaportMatch,
    AdvancedOrder,
    OrderParameters,
    OfferItem,
    ConsiderationItem,
    OrderType,
    CriteriaResolver,
    Fulfillment,
    FulfillmentComponent
} from "../seaport/ISeaportMatch.sol";
import {ItemType} from "../seaport/ISeaportZone.sol";
import {
    FeeLeg,
    BidderOrder,
    MAX_BIDDER_FEE_LEGS,
    MAX_RESOLVERS,
    MAX_BIDDER_EXTRADATA_BYTES,
    MAX_CRITERIA_PROOF_DEPTH,
    PREPAY_MODE_ATOMIC_MATCH
} from "../seaport/PrepayTypes.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {NFTPrepayListingFacet} from "./NFTPrepayListingFacet.sol";

/**
 * @title NFTPrepayListingAtomicFacet
 * @author Vaipakam Developer Team
 * @notice T-086 Round-6 / Block D (#345): the borrower's single
 *         entry point for atomic match-rotation against an OpenSea
 *         Offer via Seaport `matchAdvancedOrders`. Kills the v1
 *         English-mode race window §15.3 deliberately accepted —
 *         no rotation tx that any third party can snipe; the
 *         bidder's signed Offer and the Vaipakam counter-order
 *         settle in ONE atomic tx or both revert.
 *
 *         Sibling facet to {NFTPrepayListingFacet}. The v1 selectors
 *         (`postPrepayListing` / `updatePrepayListing` /
 *         `cancelPrepayListing` / `cancelExpiredPrepayListing`)
 *         stay byte-for-byte unchanged on the v1 facet — this facet
 *         adds ONE new selector (`matchOpenSeaOffer`) for the
 *         Match-button path.
 *
 * @dev    See `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`
 *         §17 (Round-6 design doc) for the full architecture +
 *         protocol-level rationale. Section references in code
 *         comments below point at the canonical spec.
 *
 *         The flow at match time:
 *           STEP 0  Mandatory auto-clear of any pre-existing v1
 *                   listing (§17.11 step 0).
 *           STEP 1  Construct counter-order components.
 *           STEP 2  Re-derive Vaipakam orderHash via Seaport.
 *           STEP 3  Lock the borrower NFT.
 *           STEP 4  Pin (recordOrder + restamp diamond slots).
 *           STEP 5  Wire the vault via LibPrepayListingWiring.
 *           STEP 6  Settle via Seaport.matchAdvancedOrders.
 */
contract NFTPrepayListingAtomicFacet is DiamondReentrancyGuard, DiamondPausable {
    using LibVaipakam for LibVaipakam.Storage;

    // ─── Events ─────────────────────────────────────────────────────────

    /// @notice Emitted on every successful atomic match. Distinct
    ///         from `PrepayListingPosted` because atomic matches are
    ///         short-lived on-chain (post + settle in one tx) — the
    ///         indexer handles `PrepayListingMatched` end-to-end
    ///         without a transient "live listing" row. Per Round-6
    ///         §17.7 ratified shape.
    /// @dev    `bidderFeeTotal` is the SCALAR sum of bidder's
    ///         consideration[1..] amounts — the load-bearing value
    ///         the facet re-verifies via `Σ(bidder fees) + protocol
    ///         legs == offer_value`. NO per-recipient fee array is
    ///         emitted (Raja round-10 P2: an unverified array would
    ///         be a spoofing surface); per-recipient fee detail comes
    ///         from Seaport's canonical `OrderFulfilled` event for
    ///         the bidder's order.
    /// @custom:event-category state-change/loan-mutation
    event PrepayListingMatched(
        uint256 indexed loanId,
        address indexed matcher,
        bytes32 indexed vaipakamOrderHash,
        bytes32 bidderOrderHash,
        address bidder,
        uint256 offerValue,
        uint256 bidderFeeTotal,
        address paymentToken,
        address conduit,
        bytes32 conduitKey,
        address executor
    );

    // ─── Errors ─────────────────────────────────────────────────────────

    /// @notice One of v1's entry gates fired. We forward the v1
    ///         revert symbols so consumer error-handling that
    ///         already knows v1 keeps working — these are declared
    ///         on the v1 facet but Solidity needs them visible here
    ///         to use the same selector. We re-declare them.
    error PrepayListingDisabled();
    error PrepayLoanNotActive(uint256 loanId, LibVaipakam.LoanStatus actual);
    error PrepayListingNotAllowed(uint256 loanId);
    error UnsupportedCollateralForV1(LibVaipakam.AssetType collateralType);
    error UnsupportedPrincipalForV1(LibVaipakam.AssetType principalType);
    error PrepayGraceWindowClosed(uint256 loanId, uint256 nowTime, uint256 gracePeriodEnd);
    error NotPositionHolder(uint256 loanId, address caller, address expected);
    error SanctionedAddress(address who);
    error ExecutorNotSet();
    error ConduitNotApproved(address conduit);

    /// @notice §17.5 — on-chain re-derive of the bidder's orderHash
    ///         doesn't match the dapp-pinned `expectedBidderOrderHash`
    ///         (pinned from the EARLIER offers-list response, not
    ///         the signed-bundle response — the load-bearing
    ///         protection against a compromised bundle endpoint).
    error BidderOrderHashMismatch(bytes32 expected, bytes32 derived);

    /// @notice §17.5 — bidder cancelled on-chain via
    ///         `Seaport.cancel` (gates on `isCancelled`) OR Seaport
    ///         records the order as already fully filled (only
    ///         meaningful when `totalSize != 0`; for fresh off-
    ///         chain offers totalFilled == totalSize == 0 and is
    ///         allowed through).
    error BidderOrderNotFillable(uint8 reason);

    /// @notice §17.5-bis — bidder's order shape doesn't match the
    ///         atomic-match invariant. `reason` is a small enum
    ///         tag for indexer / dapp UX classification.
    error BidderOrderShapeMismatch(uint8 reason);

    /// @notice §17.6 — bidder's offer-item token isn't the loan's
    ///         principal asset. Subsumed by ShapeMismatch but
    ///         carries a distinct symbol because the token-identity
    ///         invariant is §15.7's load-bearing rule, called out
    ///         on its own.
    error BidderPaymentTokenMismatch(address expected, address actual);

    /// @notice §17.5-bis sum invariant. `Σ(bidder fees) +
    ///         protocol legs > offer_value` — bidder's signed fees
    ///         leave nothing for the protocol legs (no lender +
    ///         treasury + borrower payout is possible).
    error AtomicMatchInsufficientForBorrower();

    /// @notice §17.9 defense-in-depth — pre-Seaport balance assert.
    ///         `Σ(consideration) != offer_value` means a routing
    ///         bug would silently leak the unspent ERC20 to the
    ///         executor's sweep surface. Reverting at the facet
    ///         boundary is strictly more informative.
    error AtomicMatchBalanceMismatch(uint256 consumed, uint256 available);

    /// @notice Raja's gas-griefing caps (§17.4 calldata caps).
    error BidderExtraDataTooLarge(uint256 supplied, uint256 cap);
    error TooManyResolvers(uint256 supplied, uint256 cap);
    error CriteriaProofTooDeep(uint256 supplied, uint256 cap);

    // ─── Shape-mismatch reason tags ────────────────────────────────────

    uint8 internal constant SHAPE_EXTRA_OFFER_ITEMS = 1;
    uint8 internal constant SHAPE_OFFER_WRONG_TYPE = 2;
    uint8 internal constant SHAPE_OFFER_NOT_FIXED_AMOUNT = 3;
    uint8 internal constant SHAPE_EXTRA_CONSIDERATION_ITEMS = 4;
    uint8 internal constant SHAPE_CONS0_WRONG_TYPE = 5;
    uint8 internal constant SHAPE_CONS0_WRONG_TOKEN = 6;
    uint8 internal constant SHAPE_CONS0_WRONG_RECIPIENT = 7;
    uint8 internal constant SHAPE_CONS0_NFT_AMOUNT_MISMATCH = 8;
    uint8 internal constant SHAPE_CONS0_NOT_FIXED_AMOUNT = 9;
    uint8 internal constant SHAPE_CONSFEE_WRONG_TYPE = 10;
    uint8 internal constant SHAPE_CONSFEE_WRONG_TOKEN = 11;
    uint8 internal constant SHAPE_CONSFEE_NOT_FIXED_AMOUNT = 12;

    // ─── Not-fillable reason tags ──────────────────────────────────────

    uint8 internal constant NOT_FILLABLE_CANCELLED = 1;
    uint8 internal constant NOT_FILLABLE_FULLY_FILLED = 2;

    // ─── Entry point ───────────────────────────────────────────────────

    /**
     * @notice Atomically match an OpenSea Offer against a freshly-
     *         built Vaipakam counter-order, settling the loan in
     *         one tx. Replaces the v1 two-step Match flow
     *         (`updatePrepayListing` rotation → bidder's separate
     *         `Seaport.fulfillOrder`) with a single atomic call;
     *         no race window for a third-party snipe.
     *
     * @param loanId                   Loan being matched.
     * @param bidder                   Bidder's signed OpenSea Offer
     *                                 (components + signature +
     *                                 SIP-7 SignedZone extraData)
     *                                 fetched by the dapp from the
     *                                 agent proxy.
     * @param expectedBidderOrderHash  Hash the dapp pinned from
     *                                 the EARLIER offers-list
     *                                 response (NOT from the
     *                                 signed-bundle response —
     *                                 §17.5). Must match the
     *                                 on-chain re-derive of
     *                                 `bidder.components`.
     * @param resolvers                Criteria resolvers for
     *                                 collection-criteria offers
     *                                 (empty for item offers).
     * @param salt                     Vaipakam-side counter-order's
     *                                 salt — caller-supplied so the
     *                                 borrower can pick a fresh
     *                                 random.
     * @param conduitKey               Vaipakam-side counter-order's
     *                                 conduit. MUST be in the
     *                                 executor's `approvedConduits`
     *                                 allow-list.
     *
     * @return vaipakamOrderHash       Hash of the Vaipakam-side
     *                                 counter-order — emitted on the
     *                                 PrepayListingMatched event for
     *                                 indexer correlation.
     */
    function matchOpenSeaOffer(
        uint256 loanId,
        BidderOrder calldata bidder,
        bytes32 expectedBidderOrderHash,
        CriteriaResolver[] calldata resolvers,
        uint256 salt,
        bytes32 conduitKey
    ) external nonReentrant whenNotPaused returns (bytes32 vaipakamOrderHash) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // ── §17.4 full v1 entry-gate set ─────────────────────────────
        _assertEntryGates(s, loan, loanId);

        // ── §17.4 calldata caps (Raja P3) ────────────────────────────
        _assertCalldataCaps(bidder, resolvers);

        // ── §17.5 bidder bytes verification ──────────────────────────
        address seaportAddr = _seaport(s);
        bytes32 derivedHash = ISeaportOrderHash(seaportAddr).getOrderHash(bidder.components);
        if (derivedHash != expectedBidderOrderHash) {
            revert BidderOrderHashMismatch(expectedBidderOrderHash, derivedHash);
        }
        _assertBidderNotCancelled(seaportAddr, derivedHash);

        // ── §17.5-bis bidder shape + token-identity (§17.6) ──────────
        // Returns bidderFeeTotal so we can compute effectiveAsk below.
        uint256 bidderFeeTotal = _assertBidderShape(loan, bidder.components);

        // ── §17.7 counter-order construction inputs ──────────────────
        IVaipakamPrepayContext.PrepayContext memory pctx =
            IVaipakamPrepayContext(address(this)).getPrepayContext(loanId, block.timestamp);
        uint256 offerValue = bidder.components.offer[0].startAmount;
        if (offerValue < pctx.lenderLeg + pctx.treasuryLeg + bidderFeeTotal) {
            // Bidder's fees + protocol legs leave nothing (or
            // negative) for the borrower remainder.
            revert AtomicMatchInsufficientForBorrower();
        }
        uint256 effectiveAsk = offerValue - bidderFeeTotal;

        // ── §17.11 STEP 0: auto-clear pre-existing v1 listing ────────
        _autoClearPreExistingListing(s, loan, loanId);

        // ── §17.11 STEP 1-5: lock + build counter-order + record +
        //    wire vault ─────────────────────────────────────────────
        address executor = s.collateralListingExecutor;
        if (executor == address(0)) revert ExecutorNotSet();

        // Resolve conduit address from the borrower-supplied key
        // via Seaport's ConduitController — same path v1's
        // `_resolveConduit` uses.
        IListingExecutorRecorder rec = IListingExecutorRecorder(executor);
        address conduit = LibPrepayOrder.resolveConduit(
            CollateralListingExecutor(executor).seaport(),
            conduitKey
        );
        if (!rec.approvedConduits(conduit)) revert ConduitNotApproved(conduit);

        vaipakamOrderHash = _buildAndRecord(
            s, loan, loanId, pctx, effectiveAsk, salt, conduitKey, conduit, executor
        );

        // ── §17.11 STEP 6: settle via matchAdvancedOrders ────────────
        // Build the two AdvancedOrders + the Fulfillment[] + invoke
        // Seaport with recipient = executor (§17.9.bis defense-in-
        // depth so any leakage past the shape check lands at a code-
        // controlled address, not the borrower's EOA).
        _settle(
            seaportAddr,
            bidder,
            pctx,
            executor,
            offerValue,
            bidderFeeTotal,
            effectiveAsk,
            salt,
            conduitKey,
            resolvers
        );

        // ── Emit canonical event ─────────────────────────────────────
        emit PrepayListingMatched(
            loanId,
            msg.sender,
            vaipakamOrderHash,
            derivedHash,
            bidder.components.offerer,
            offerValue,
            bidderFeeTotal,
            bidder.components.offer[0].token,
            conduit,
            conduitKey,
            executor
        );
    }

    // ─── Entry-gate helper ─────────────────────────────────────────────

    /// @dev Re-applies the FULL v1 entry-gate set per §17.4. Without
    ///      these, the §17.11 step 0(a) zero-existing-hash branch
    ///      would let a borrower bypass the lender's frozen
    ///      `allowsPrepayListing` consent on a loan that never went
    ///      through v1 `postPrepayListing`.
    function _assertEntryGates(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId
    ) private view {
        if (!s.cfgPrepayListingEnabled) revert PrepayListingDisabled();
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert PrepayLoanNotActive(loanId, loan.status);
        }
        if (!loan.allowsPrepayListing) {
            revert PrepayListingNotAllowed(loanId);
        }
        if (
            loan.collateralAssetType != LibVaipakam.AssetType.ERC721 &&
            loan.collateralAssetType != LibVaipakam.AssetType.ERC1155
        ) {
            revert UnsupportedCollateralForV1(loan.collateralAssetType);
        }
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedPrincipalForV1(loan.assetType);
        }
        uint256 graceEnd = _gracePeriodEnd(loan);
        if (block.timestamp >= graceEnd) {
            revert PrepayGraceWindowClosed(loanId, block.timestamp, graceEnd);
        }
        address holder = VaipakamNFTFacet(address(this)).ownerOf(loan.borrowerTokenId);
        if (holder != msg.sender) {
            revert NotPositionHolder(loanId, msg.sender, holder);
        }
        LibVaipakam._assertNotSanctioned(msg.sender);
    }

    // ─── Calldata-cap helper (Raja P3 #344) ────────────────────────────

    function _assertCalldataCaps(
        BidderOrder calldata bidder,
        CriteriaResolver[] calldata resolvers
    ) private pure {
        if (bidder.extraData.length > MAX_BIDDER_EXTRADATA_BYTES) {
            revert BidderExtraDataTooLarge(bidder.extraData.length, MAX_BIDDER_EXTRADATA_BYTES);
        }
        if (resolvers.length > MAX_RESOLVERS) {
            revert TooManyResolvers(resolvers.length, MAX_RESOLVERS);
        }
        for (uint256 i = 0; i < resolvers.length; ) {
            if (resolvers[i].criteriaProof.length > MAX_CRITERIA_PROOF_DEPTH) {
                revert CriteriaProofTooDeep(
                    resolvers[i].criteriaProof.length, MAX_CRITERIA_PROOF_DEPTH
                );
            }
            unchecked { ++i; }
        }
    }

    // ─── §17.5 cancellation check ──────────────────────────────────────

    /// @dev `getOrderStatus(orderHash)` returns `(isValidated,
    ///      isCancelled, totalFilled, totalSize)`. For fresh
    ///      off-chain-signed offers, `isValidated == false` AND
    ///      `totalSize == 0` — gating on `!isValidated` would
    ///      reject every normal offer. Only `isCancelled` is a
    ///      hard reject; the totalFilled check is conditioned on
    ///      `totalSize != 0` so the zero-state "never recorded
    ///      on-chain" is allowed through (Seaport's own match-time
    ///      path handles signature validation natively).
    function _assertBidderNotCancelled(address seaportAddr, bytes32 orderHash) private view {
        (
            ,           // isValidated — NOT used (see comment)
            bool isCancelled,
            uint256 totalFilled,
            uint256 totalSize
        ) = ISeaportMatch(seaportAddr).getOrderStatus(orderHash);
        if (isCancelled) revert BidderOrderNotFillable(NOT_FILLABLE_CANCELLED);
        if (totalSize != 0 && totalFilled >= totalSize) {
            revert BidderOrderNotFillable(NOT_FILLABLE_FULLY_FILLED);
        }
    }

    // ─── §17.5-bis bidder shape invariant ──────────────────────────────

    /// @dev Asserts every shape invariant the atomic-match flow
    ///      depends on, in §17.5-bis order:
    ///        - exactly 1 ERC20 offer item in `loan.principalAsset`
    ///        - fixed amount (startAmount == endAmount)
    ///        - consideration.length ∈ [1, 1 + MAX_BIDDER_FEE_LEGS]
    ///        - consideration[0] is the NFT shape with the
    ///          expected token + amount (1 for ERC721, full
    ///          collateralQuantity for ERC1155) and recipient ==
    ///          bidder.offerer
    ///        - consideration[1..] are all ERC20 fee legs in
    ///          loan.principalAsset with fixed amounts
    ///      Returns `bidderFeeTotal` so the caller can compute
    ///      `effectiveAsk` without re-summing.
    function _assertBidderShape(
        LibVaipakam.Loan storage loan,
        OrderComponents calldata components
    ) private view returns (uint256 bidderFeeTotal) {
        // Offer side — exactly 1 ERC20 = loan.principalAsset,
        // fixed amount.
        if (components.offer.length != 1) {
            revert BidderOrderShapeMismatch(SHAPE_EXTRA_OFFER_ITEMS);
        }
        if (components.offer[0].itemType != ItemType.ERC20) {
            revert BidderOrderShapeMismatch(SHAPE_OFFER_WRONG_TYPE);
        }
        if (components.offer[0].token != loan.principalAsset) {
            revert BidderPaymentTokenMismatch(
                loan.principalAsset, components.offer[0].token
            );
        }
        if (components.offer[0].startAmount != components.offer[0].endAmount) {
            revert BidderOrderShapeMismatch(SHAPE_OFFER_NOT_FIXED_AMOUNT);
        }

        // Consideration side — count cap.
        uint256 considerationLen = components.consideration.length;
        if (
            considerationLen == 0 ||
            considerationLen > 1 + MAX_BIDDER_FEE_LEGS
        ) {
            revert BidderOrderShapeMismatch(SHAPE_EXTRA_CONSIDERATION_ITEMS);
        }

        // consideration[0] — the NFT shape.
        _assertBidderConsiderationNftItem(loan, components);

        // consideration[1..] — ERC20 fee legs in loan.principalAsset
        // with fixed amounts. Accumulate the sum for the caller.
        for (uint256 i = 1; i < considerationLen; ) {
            if (components.consideration[i].itemType != ItemType.ERC20) {
                revert BidderOrderShapeMismatch(SHAPE_CONSFEE_WRONG_TYPE);
            }
            if (components.consideration[i].token != loan.principalAsset) {
                revert BidderOrderShapeMismatch(SHAPE_CONSFEE_WRONG_TOKEN);
            }
            if (
                components.consideration[i].startAmount !=
                components.consideration[i].endAmount
            ) {
                revert BidderOrderShapeMismatch(SHAPE_CONSFEE_NOT_FIXED_AMOUNT);
            }
            bidderFeeTotal += components.consideration[i].startAmount;
            unchecked { ++i; }
        }
    }

    /// @dev consideration[0] shape check (§17.5-bis NFT-quantity
    ///      exact-match): itemType matches collateral asset type,
    ///      token matches collateral asset, recipient is bidder,
    ///      amount matches (1 for ERC721; full collateralQuantity
    ///      for ERC1155), fixed start/end amount.
    function _assertBidderConsiderationNftItem(
        LibVaipakam.Loan storage loan,
        OrderComponents calldata components
    ) private view {
        ItemType t = components.consideration[0].itemType;
        bool ok;
        uint256 expectedAmount;
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            ok = (t == ItemType.ERC721 || t == ItemType.ERC721_WITH_CRITERIA);
            expectedAmount = 1;
        } else {
            // ERC1155 (asset-type check at entry-gate already
            // rejected ERC20 collateral).
            ok = (t == ItemType.ERC1155 || t == ItemType.ERC1155_WITH_CRITERIA);
            expectedAmount = loan.collateralQuantity;
        }
        if (!ok) revert BidderOrderShapeMismatch(SHAPE_CONS0_WRONG_TYPE);
        if (components.consideration[0].token != loan.collateralAsset) {
            revert BidderOrderShapeMismatch(SHAPE_CONS0_WRONG_TOKEN);
        }
        if (components.consideration[0].recipient != components.offerer) {
            revert BidderOrderShapeMismatch(SHAPE_CONS0_WRONG_RECIPIENT);
        }
        // Raja PR #346 round-1 review — the "fixed amount" (no
        // Dutch decay on the NFT side) and the "amount equals
        // expected" checks were fused into one revert that always
        // surfaced as the amount-mismatch tag (8). Splitting them
        // so the SHAPE_CONS0_NOT_FIXED_AMOUNT tag (9) is reachable
        // and the reason tags map 1:1 to the conditions. Matches
        // the design doc §17.5-bis NFT-quantity exact-match
        // walkthrough (start==end first, then ==expected).
        if (
            components.consideration[0].startAmount !=
            components.consideration[0].endAmount
        ) {
            revert BidderOrderShapeMismatch(SHAPE_CONS0_NOT_FIXED_AMOUNT);
        }
        if (components.consideration[0].startAmount != expectedAmount) {
            revert BidderOrderShapeMismatch(SHAPE_CONS0_NFT_AMOUNT_MISMATCH);
        }
    }

    // ─── §17.11 STEP 0: auto-clear pre-existing v1 listing ─────────────

    /// @dev Mirrors v1 `_cancel:1078-1123` byte-for-byte:
    ///      pinnedExecutor lookup → _unlock → clear storage slots
    ///      → clearOrder → LibPrepayListingWiring.unwire → emit.
    ///      If `existingHash == 0` the whole sequence is skipped
    ///      (no false-cancellation row in indexer history for a
    ///      never-posted listing).
    function _autoClearPreExistingListing(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId
    ) private {
        bytes32 existingHash = s.prepayListingOrderHash[loanId];
        if (existingHash == bytes32(0)) return;

        address pinnedExecutor = s.prepayListingExecutor[loanId];
        if (pinnedExecutor == address(0)) revert ExecutorNotSet();

        LibERC721._unlock(loan.borrowerTokenId);
        delete s.prepayListingOrderHash[loanId];
        delete s.prepayListingExecutor[loanId];
        IListingExecutorRecorder(pinnedExecutor).clearOrder(existingHash);
        LibPrepayListingWiring.unwire(s, loan, existingHash);

        emit NFTPrepayListingFacet.PrepayListingCanceled(
            loanId,
            msg.sender,
            existingHash,
            NFTPrepayListingFacet.CancelReason.ReplacedByMatch
        );
    }

    // ─── §17.11 STEPS 1-5: lock + record + wire ───────────────────────

    function _buildAndRecord(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        IVaipakamPrepayContext.PrepayContext memory pctx,
        uint256 effectiveAsk,
        uint256 salt,
        bytes32 conduitKey,
        address conduit,
        address executor
    ) private returns (bytes32 vaipakamOrderHash) {
        // Build the Vaipakam-side canonical order shape +
        // re-derive the hash. Reuses the v1 fixed-price builder
        // (the counter-order shape is identical to a fixed-price
        // listing at ask = effectiveAsk).
        FeeLeg[] memory emptyFeeLegs = new FeeLeg[](0);
        vaipakamOrderHash = LibPrepayOrder.buildAndHashMem(
            pctx,
            s.userVaipakamVaults[loan.borrower],
            executor,
            CollateralListingExecutor(executor).seaport(),
            effectiveAsk,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            salt,
            conduitKey,
            emptyFeeLegs // memory-typed sibling for Block D
        );

        // STEP 3 — Lock the borrower NFT.
        LibERC721._lock(loan.borrowerTokenId, LibERC721.LockReason.PrepayCollateralListing);

        // STEP 4 — Pin + restamp diamond slots. `askPrice = endAskPrice
        // = effectiveAsk` per §17.11 step 4 (Codex round-10 P3 — the
        // counter-order's 3 protocol legs sum to effectiveAsk, NOT
        // gross offer_value, so the cancel-time reconstruction
        // matches the actual orderHash).
        s.prepayListingOrderHash[loanId] = vaipakamOrderHash;
        s.prepayListingExecutor[loanId] = executor;
        IListingExecutorRecorder(executor).recordOrder(
            vaipakamOrderHash,
            loanId,
            conduit,
            conduitKey,
            salt,
            block.timestamp,
            effectiveAsk,        // askPrice
            effectiveAsk,        // endAskPrice = askPrice (fixed)
            0,                   // auctionEndTime sentinel
            PREPAY_MODE_ATOMIC_MATCH,
            emptyFeeLegs // empty — Vaipakam side has no fee legs (memory→calldata at external call boundary)
        );

        // STEP 5 — Wire the vault.
        LibPrepayListingWiring.wire(s, loan, vaipakamOrderHash, conduit, executor);
    }

    // (No internal helper needed — external calls to
    // `recordOrder` accept memory arguments and Solidity
    // handles the memory→calldata encoding transparently at the
    // call site. We construct `new FeeLeg[](0)` inline at the
    // call site in `_buildAndRecord`.)

    // ─── §17.11 STEP 6: settle via matchAdvancedOrders ─────────────────

    /// @dev Builds the two `AdvancedOrder`s + the Fulfillment[] +
    ///      invokes `matchAdvancedOrders` with `recipient = executor`
    ///      (§17.9.bis). Uses a helper struct to thread the many
    ///      arguments without blowing the stack-depth budget.
    struct SettleInputs {
        address seaportAddr;
        BidderOrder bidder;
        IVaipakamPrepayContext.PrepayContext pctx;
        address executor;
        uint256 offerValue;
        uint256 bidderFeeTotal;
        uint256 effectiveAsk;
        uint256 salt;
        bytes32 conduitKey;
    }

    function _settle(
        address seaportAddr,
        BidderOrder calldata bidder,
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address executor,
        uint256 offerValue,
        uint256 bidderFeeTotal,
        uint256 effectiveAsk,
        uint256 salt,
        bytes32 conduitKey,
        CriteriaResolver[] calldata resolvers
    ) private {
        // Pre-Seaport balance assertion (§17.9 load-bearing —
        // Codex round-7 P3: Seaport doesn't require offer items
        // to end at zero, so without this an under-fulfillment
        // would silently leak the unspent ERC20 to the recipient
        // sweep surface).
        uint256 consumed = bidderFeeTotal + pctx.lenderLeg + pctx.treasuryLeg + (effectiveAsk - pctx.lenderLeg - pctx.treasuryLeg);
        if (consumed != offerValue) {
            revert AtomicMatchBalanceMismatch(consumed, offerValue);
        }

        AdvancedOrder[] memory orders = new AdvancedOrder[](2);
        orders[0] = _wrapBidderOrder(bidder);
        orders[1] = _buildVaipakamAdvancedOrder(pctx, effectiveAsk, salt, conduitKey, executor);

        Fulfillment[] memory fulfillments = _buildFulfillments(bidder.components.consideration.length);

        ISeaportMatch(seaportAddr).matchAdvancedOrders(
            orders,
            resolvers,
            fulfillments,
            executor // §17.9.bis defense-in-depth
        );
    }

    /// @dev Wrap the bidder's signed bytes into an AdvancedOrder.
    ///      Round-6 §17.11 step 6 specifies the AdvancedOrder fields
    ///      explicitly: numerator/denominator = 1/1 (full-fill);
    ///      signature = bidder's signature; extraData = bidder's
    ///      SIP-7 SignedZone blob (REQUIRED for fee-enforced
    ///      collections — Codex round-6 P2).
    function _wrapBidderOrder(BidderOrder calldata bidder)
        private
        pure
        returns (AdvancedOrder memory)
    {
        return AdvancedOrder({
            parameters: _toOrderParameters(bidder.components),
            numerator: 1,
            denominator: 1,
            signature: bidder.signature,
            extraData: bidder.extraData
        });
    }

    /// @dev Build OrderParameters from OrderComponents — drops the
    ///      `counter` field (Seaport reads the current counter from
    ///      its own mapping at match time) and adds
    ///      `totalOriginalConsiderationItems` (Seaport's
    ///      consideration-array bounds check).
    function _toOrderParameters(OrderComponents calldata c)
        private
        pure
        returns (OrderParameters memory)
    {
        // Translate the OfferItem[] from the components shape to the
        // parameters shape. The shapes are field-for-field identical
        // (the components and parameters versions of OfferItem +
        // ConsiderationItem are the same Seaport struct used in
        // different containers); we copy via per-field assignment to
        // sidestep Solidity's struct-type-identity rules between
        // file-local definitions.
        OfferItem[] memory offer = new OfferItem[](c.offer.length);
        for (uint256 i = 0; i < c.offer.length; ) {
            offer[i] = OfferItem({
                itemType: ItemType(uint8(c.offer[i].itemType)),
                token: c.offer[i].token,
                identifierOrCriteria: c.offer[i].identifierOrCriteria,
                startAmount: c.offer[i].startAmount,
                endAmount: c.offer[i].endAmount
            });
            unchecked { ++i; }
        }
        ConsiderationItem[] memory consideration = new ConsiderationItem[](c.consideration.length);
        for (uint256 i = 0; i < c.consideration.length; ) {
            consideration[i] = ConsiderationItem({
                itemType: ItemType(uint8(c.consideration[i].itemType)),
                token: c.consideration[i].token,
                identifierOrCriteria: c.consideration[i].identifierOrCriteria,
                startAmount: c.consideration[i].startAmount,
                endAmount: c.consideration[i].endAmount,
                recipient: c.consideration[i].recipient
            });
            unchecked { ++i; }
        }
        return OrderParameters({
            offerer: c.offerer,
            zone: c.zone,
            offer: offer,
            consideration: consideration,
            orderType: OrderType(uint8(c.orderType)),
            startTime: c.startTime,
            endTime: c.endTime,
            zoneHash: c.zoneHash,
            salt: c.salt,
            conduitKey: c.conduitKey,
            totalOriginalConsiderationItems: c.consideration.length
        });
    }

    /// @dev Build the Vaipakam-side AdvancedOrder. The OrderParameters
    ///      shape matches what `LibPrepayOrder._components` would build
    ///      for a fixed-price listing at ask = effectiveAsk. The
    ///      signature is empty (ERC-1271 path via the vault); extraData
    ///      is empty (FULL_RESTRICTED zone callback, not SIP-7).
    function _buildVaipakamAdvancedOrder(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        uint256 effectiveAsk,
        uint256 salt,
        bytes32 conduitKey,
        address executor
    ) private view returns (AdvancedOrder memory) {
        // Offer item — the collateral NFT.
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem({
            itemType: pctx.collateralAssetType == LibVaipakam.AssetType.ERC721
                ? ItemType.ERC721
                : ItemType.ERC1155,
            token: pctx.collateralAsset,
            identifierOrCriteria: pctx.collateralTokenId,
            startAmount: pctx.collateralAssetType == LibVaipakam.AssetType.ERC721
                ? 1
                : pctx.collateralQuantity,
            endAmount: pctx.collateralAssetType == LibVaipakam.AssetType.ERC721
                ? 1
                : pctx.collateralQuantity
        });

        // Consideration — 3 protocol legs (lender + treasury +
        // borrower remainder) in loan.principalAsset.
        uint256 borrowerRem = effectiveAsk - pctx.lenderLeg - pctx.treasuryLeg;
        ConsiderationItem[] memory consideration = new ConsiderationItem[](3);
        consideration[0] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: pctx.principalAsset,
            identifierOrCriteria: 0,
            startAmount: pctx.lenderLeg,
            endAmount: pctx.lenderLeg,
            recipient: payable(pctx.lenderNftOwner)
        });
        consideration[1] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: pctx.principalAsset,
            identifierOrCriteria: 0,
            startAmount: pctx.treasuryLeg,
            endAmount: pctx.treasuryLeg,
            recipient: payable(pctx.treasury)
        });
        consideration[2] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: pctx.principalAsset,
            identifierOrCriteria: 0,
            startAmount: borrowerRem,
            endAmount: borrowerRem,
            recipient: payable(pctx.borrowerNftOwner)
        });

        OrderParameters memory params = OrderParameters({
            offerer: pctx.borrowerVault,
            zone: executor,
            offer: offer,
            consideration: consideration,
            orderType: OrderType.FULL_RESTRICTED,
            startTime: block.timestamp,
            endTime: pctx.graceEnd,
            zoneHash: bytes32(0),
            salt: salt,
            conduitKey: conduitKey,
            totalOriginalConsiderationItems: 3
        });

        return AdvancedOrder({
            parameters: params,
            numerator: 1,
            denominator: 1,
            signature: "",        // ERC-1271 path; no off-chain sig
            extraData: ""         // FULL_RESTRICTED zone, not SIP-7
        });
    }

    /// @dev Build the Fulfillment[] array per §17.9:
    ///        (A) bidder.offer[0] → bidder.consideration[i] for
    ///            i ∈ [1, considerationLen)
    ///        (B) bidder.offer[0] → vaipakam.consideration[j] for
    ///            j ∈ [0, 3)
    ///        (C) vaipakam.offer[0] → bidder.consideration[0]
    ///      Total = n_bidderFees + 3 + 1 = considerationLen + 3.
    function _buildFulfillments(uint256 bidderConsiderationLen)
        private
        pure
        returns (Fulfillment[] memory fulfillments)
    {
        // (A) bidder-fee legs: considerationLen - 1 fulfillments
        // (B) 3 protocol legs
        // (C) 1 NFT pairing
        uint256 nBidderFees = bidderConsiderationLen - 1;
        uint256 total = nBidderFees + 3 + 1;
        fulfillments = new Fulfillment[](total);

        // (A)
        for (uint256 i = 0; i < nBidderFees; ) {
            FulfillmentComponent[] memory off = new FulfillmentComponent[](1);
            off[0] = FulfillmentComponent({orderIndex: 0, itemIndex: 0});
            FulfillmentComponent[] memory con = new FulfillmentComponent[](1);
            con[0] = FulfillmentComponent({orderIndex: 0, itemIndex: i + 1});
            fulfillments[i] = Fulfillment({offerComponents: off, considerationComponents: con});
            unchecked { ++i; }
        }
        // (B)
        for (uint256 j = 0; j < 3; ) {
            FulfillmentComponent[] memory off = new FulfillmentComponent[](1);
            off[0] = FulfillmentComponent({orderIndex: 0, itemIndex: 0});
            FulfillmentComponent[] memory con = new FulfillmentComponent[](1);
            con[0] = FulfillmentComponent({orderIndex: 1, itemIndex: j});
            fulfillments[nBidderFees + j] = Fulfillment({
                offerComponents: off, considerationComponents: con
            });
            unchecked { ++j; }
        }
        // (C)
        {
            FulfillmentComponent[] memory off = new FulfillmentComponent[](1);
            off[0] = FulfillmentComponent({orderIndex: 1, itemIndex: 0});
            FulfillmentComponent[] memory con = new FulfillmentComponent[](1);
            con[0] = FulfillmentComponent({orderIndex: 0, itemIndex: 0});
            fulfillments[nBidderFees + 3] = Fulfillment({
                offerComponents: off, considerationComponents: con
            });
        }
    }

    // ─── Misc helpers ───────────────────────────────────────────────────

    /// @dev Same shape as v1 `NFTPrepayListingFacet._gracePeriodEnd:969`
    ///      — startTime + durationDays*1day + LibVaipakam.gracePeriod().
    function _gracePeriodEnd(LibVaipakam.Loan storage loan)
        private
        view
        returns (uint256)
    {
        uint256 endTime = uint256(loan.startTime) + (uint256(loan.durationDays) * 1 days);
        return endTime + LibVaipakam.gracePeriod(loan.durationDays);
    }

    function _seaport(LibVaipakam.Storage storage s) private view returns (address) {
        address executor = s.collateralListingExecutor;
        if (executor == address(0)) revert ExecutorNotSet();
        return CollateralListingExecutor(executor).seaport();
    }
}
