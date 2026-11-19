// src/facets/SignedOfferMatchFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {SignedOfferFacet} from "./SignedOfferFacet.sol";
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
 *         The signed-offer half of a match (the fill rule, the signature, the
 *         fill ledger and the slice's materialization) runs on
 *         `SignedOfferFacet.takeSignedMatchSlice`, through one self-call:
 *         every signed-offer check lives on that facet, and this one keeps
 *         only the match. The two are refreshed together.
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

    // Every refusal of the signed offer itself, the slice rules included,
    // is LibSignedOffer's and is raised by `SignedOfferFacet.takeSignedMatchSlice`.

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
    /// @param set                 Where `o` sits in the set its maker signed
    ///                            (#3327 part 2); no others when signed alone.
    /// @param counterpartyOfferId The on-chain offer on the OTHER side.
    /// @param fillAmount          The principal this match fills (≤ remaining).
    /// @param auth                The offer's co-signer's authorization of this
    ///                            slice (#3327), naming the counterparty offer's
    ///                            creator as the taker; ignored when the offer
    ///                            names no co-signer.
    /// @return loanId             The initiated loan.
    function matchSignedOffer(
        LibSignedOffer.SignedOffer calldata o,
        bytes calldata sig,
        LibSignedOffer.OfferSet calldata set,
        uint256 counterpartyOfferId,
        uint256 fillAmount,
        LibSignedOffer.FillAuth calldata auth
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        LibVaipakam._assertNotSanctioned(msg.sender); // matcher = LIF recipient
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.partialFillEnabled) {
            revert LibOfferMatchExecute.FunctionDisabled(3);
        }
        // The signed-offer half (#3443 follow-up): vet, signature, fill ledger
        // and the slice's materialization, all on `SignedOfferFacet`, which
        // holds every other signed-offer check. The ledger is written there
        // BEFORE the match below (CEI).
        (bytes32 orderHash, uint256 sliceOfferId) =
            _takeSlice(o, sig, set, s.offers[counterpartyOfferId].creator, fillAmount, auth);
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
        // One call site: the match core is inlined once into this facet.
        loanId = LibOfferMatchExecute.executeMatch(
            signedIsLender ? sliceOfferId : counterpartyOfferId,
            signedIsLender ? counterpartyOfferId : sliceOfferId,
            signedIsLender ? 0 : s.offers[sliceOfferId].collateralAmount
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

    /// @dev Self-call `SignedOfferFacet.takeSignedMatchSlice`, bubbling its
    ///      refusal unchanged.
    function _takeSlice(
        LibSignedOffer.SignedOffer calldata o,
        bytes calldata sig,
        LibSignedOffer.OfferSet calldata set,
        address taker,
        uint256 fillAmount,
        LibSignedOffer.FillAuth calldata auth
    ) private returns (bytes32 orderHash, uint256 sliceOfferId) {
        // slither-disable-next-line low-level-calls
        (bool ok, bytes memory res) = address(this).call(
            abi.encodeWithSelector(
                SignedOfferFacet.takeSignedMatchSlice.selector, o, sig, set, taker, fillAmount, auth
            )
        );
        if (!ok) {
            if (res.length > 0) {
                assembly ("memory-safe") {
                    revert(add(res, 0x20), mload(res))
                }
            }
            revert LibOfferMatchExecute.SignedOfferMaterializeFailed();
        }
        (orderHash, sliceOfferId) = abi.decode(res, (bytes32, uint256));
    }
}
