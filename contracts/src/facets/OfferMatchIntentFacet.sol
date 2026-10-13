// src/facets/OfferMatchIntentFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibOfferMatchExecute} from "../libraries/LibOfferMatchExecute.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";

/**
 * @title  OfferMatchIntentFacet
 * @author Vaipakam Developer Team
 * @notice #393 v1-b — the standing-intent fill: a solver (directly, through an
 *         aggregator adapter, or through the backstop vault) fills a lender's
 *         STANDING INTENT against an on-chain borrower offer, materializing the
 *         lender slice and initiating the loan through the shared match core.
 * @dev    #1219 (S-4) — split out of `OfferMatchFacet`, which sat 293 B under
 *         the EIP-170 ceiling when the capacity gates arrived (less than one
 *         cross-facet call), so the three fill gates could not inline there.
 *         This entry is the one the capacity design names for the solver,
 *         backstop and adapter routes, so it is the clean host for its gate.
 *         The execution core (`LibOfferMatchExecute.executeMatch`) is shared
 *         with `matchOffers` / `matchSignedOffer` as ONE library inlined by
 *         both facets — one source, two hosts; it is an INTERNAL call, so
 *         `msg.sender` (the solver / LIF recipient) is preserved exactly as
 *         before. Same storage, same Diamond, same selector: callers change
 *         nothing. The testnets route `matchIntent` to the old host until their
 *         refresh replaces it onto this facet (`RefreshAllFacetsInPlace` cuts it
 *         as a Replace); no mainnet exists yet.
 */
contract OfferMatchIntentFacet is DiamondReentrancyGuard, DiamondPausable {
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
    /// @notice #633 — the #398 aggregator-adapter feature is paused by governance,
    ///         so an aggregator's intent cannot be filled (user intents still can).
    error AggregatorAdaptersPaused();

    /// @notice #393 v1-b — fill a lender's STANDING INTENT against an on-chain
    ///         borrower counterparty. The solver (`msg.sender`) earns the 1% LIF.
    ///         Materializes a single-fill lender offer from the intent's bounds —
    ///         rate floor `[minRateBps, MAX_INTEREST_BPS]`, the counterparty's
    ///         term (≤ `maxDurationDays`), and the collateral the intent's
    ///         `maxInitLtvBps` requires — with `creator = lender`, then routes it
    ///         through the same audited `executeMatch` as `matchOffers`. The
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
        if (!s.protocolCfg.partialFillEnabled) revert LibOfferMatchExecute.FunctionDisabled(3);
        if (!s.protocolCfg.lenderIntentEnabled) revert LibOfferMatchExecute.FunctionDisabled(4);
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
        loanId = LibOfferMatchExecute.executeMatch(sliceOfferId, counterpartyOfferId, 0);
        // #1219 — one fill, charged to the actor the route names (direct solver,
        // the adapter's bound operator, or the outer initiator's free tier — see
        // `LibServiceCapacity.routeActor`), LAST, so a refused charge reverts the
        // fill whole and `previewIntent` reports it as its last check. A
        // keeper-authorized fill is ONE executed item: the keeper-auth check above
        // stays an authorization, not a second charge.
        LibServiceCapacity.chargeSolver();

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
            LibOfferMatchExecute.NFTBurnFailed.selector
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
            revert LibOfferMatchExecute.SignedOfferMaterializeFailed();
        }
        sliceOfferId = abi.decode(res, (uint256));
    }

}
