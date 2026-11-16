// src/facets/OfferMaterializeFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibPermit2, ISignatureTransfer} from "../libraries/LibPermit2.sol";
import {LibOfferAdmission} from "../libraries/LibOfferAdmission.sol";
import {LibOfferCreate} from "../libraries/LibOfferCreate.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {LibSignedOffer} from "../libraries/LibSignedOffer.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title  OfferMaterializeFacet
 * @author Vaipakam Developer Team
 * @notice Turns an offer that was agreed off the book into a normal on-chain
 *         offer at the moment it fills: a signed off-chain offer
 *         (`SignedOfferFacet`, `SignedOfferMatchFacet`) or a standing
 *         lender intent's slice (`LibIntentFill`). Both entries are
 *         Diamond-only; the caller has already checked the signature or the
 *         intent and runs the accept or match straight after.
 * @dev    Split off `OfferCreateFacet` in #3328 along the "how the creator's
 *         assets arrive" seam: what an offer is (validation, record, token,
 *         book entry) is `LibOfferCreate`, run here and in the plain creates.
 *         Selectors, errors and the `OfferCreatorFullTariffSet` event are
 *         unchanged; only the host facet moved.
 */
contract OfferMaterializeFacet is DiamondPausable, IVaipakamErrors {
    /// @notice Funding mode for a materialized signed offer (#396 v0.5).
    ///         `VaultBacked` (0): the signer pre-funded their vault, so the
    ///         creator-side stake is already free vault balance — skip the
    ///         wallet pull, assert the free balance covers the stake, and let
    ///         `LibOfferCreate.finish`'s offer-principal lien lock it.
    ///         `WalletWitness` (1): pull the stake from the signer's wallet via
    ///         Permit2 `permitWitnessTransferFrom`, the offer hash bound as the
    ///         witness so one signature authorizes the pull AND the terms.
    enum SignedFunding {
        VaultBacked,
        WalletWitness
    }

    /// @dev #3328 — what the materialized offer is: an ordinary signed offer
    ///      (both legs ERC-20), one loan of an on-chain collection offer
    ///      (principal from the parent's escrow, so the depository ledger is
    ///      not drawn), or one loan of a signed collection offer (principal
    ///      from the signer's free vault balance, drawn as any signed fill).
    ///      Both collection kinds may name NFT collateral.
    enum Source {
        Signed,
        CollectionParent,
        SignedCollection
    }

    /// @notice The signed offer's shape isn't supported in v0.5 (only ERC-20
    ///         Lender-principal and ERC-20-collateral Borrower offers; NFT
    ///         lender / NFT-rental / refinance-tagged are out of v0.5 scope).
    error SignedOfferUnsupportedShape();
    /// @notice Vault-backed signed offer: the signer's free vault balance of
    ///         the staked asset is below the offer stake.
    error SignedOfferInsufficientFreeBalance(
        address asset,
        uint256 free,
        uint256 needed
    );

    /// @notice Materialize a signed off-chain offer into a normal on-chain
    ///         offer at the instant of fill (#396 v0.5). Self-gated cross-facet
    ///         entry called ONLY by `OfferAcceptFacet`'s signed-offer accept
    ///         path, which has already verified the signature + nonce/replay
    ///         ledger. Reuses `LibOfferCreate.setup` + `LibOfferCreate.finish`
    ///         verbatim (all validation + the NFT mint + the offer-principal
    ///         lien) and swaps only the asset pull by `fundingMode`.
    /// @dev    Gated on `msg.sender == address(this)` (diamond) like
    ///         `createOfferInternal`. `creator` is the real signer (passed
    ///         on-behalf-of so `offer.creator` + the lien + sanctions all
    ///         resolve to the signer, not the diamond). v0.5 restricts the
    ///         shape to the two clean ERC-20 legs the Permit2 / free-balance
    ///         funding can serve; NFT and refinance-tagged offers revert
    ///         `SignedOfferUnsupportedShape`.
    /// @notice Vault-backed materialize entry (narrow ABI boundary — the
    ///         caller encodes only `(creator, params)`, keeping the
    ///         cross-facet call site under viaIR's stack ceiling). The
    ///         signer's stake is already free vault balance.
    /// @param creator The offer signer (on-behalf-of). @param params Terms.
    /// @param full    #1949 — the maker's Full opt-in carried on the signed artifact
    ///                (whole order or the slice's pro-rata share).
    /// @return offerId The materialized on-chain offer id.
    function createSignedOfferVault(
        address creator,
        LibVaipakam.CreateOfferParams calldata params,
        LibSignedOffer.MakerFull calldata full
    ) external whenNotPaused returns (uint256 offerId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        ISignatureTransfer.PermitTransferFrom memory emptyPermit;
        return _materializeSignedOffer(
            creator, params, SignedFunding.VaultBacked, emptyPermit, bytes32(0), "", full, Source.Signed
        );
    }

    /// @notice #3328 — materialize one loan of a collection offer: a
    ///         one-token lender slice of the parent's terms, funded by the
    ///         loan's principal the caller (`CollectionOfferFacet`) has just
    ///         released from the parent's reserve in the lender's vault.
    /// @dev    Diamond-only. Unlike a signed offer, the slice may name
    ///         ERC-721 / ERC-1155 collateral (the lender stakes only the
    ///         ERC-20 principal; the borrower's token arrives at accept or is
    ///         already liened under their matched offer). The principal was
    ///         purpose-bound escrow, never the lender's depository balance, so
    ///         the depository ledger is not drawn.
    /// @param lender The collection offer's lender. @param params The slice.
    /// @param full   The lender's Full opt-in on the parent, per loan.
    /// @return offerId The slice offer id.
    function createCollectionSlice(
        address lender,
        LibVaipakam.CreateOfferParams calldata params,
        LibSignedOffer.MakerFull calldata full
    ) external whenNotPaused returns (uint256 offerId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        ISignatureTransfer.PermitTransferFrom memory emptyPermit;
        return _materializeSignedOffer(
            lender, params, SignedFunding.VaultBacked, emptyPermit, bytes32(0), "", full, Source.CollectionParent
        );
    }

    /// @notice #3328 — materialize one loan of a SIGNED collection offer: a
    ///         one-token lender slice of the signed terms, funded from the
    ///         signer's free vault balance at this fill. Nothing was reserved
    ///         when the offer was signed, so the free balance is checked here
    ///         and drawn from the depository ledger like any vault-backed
    ///         signed fill.
    /// @dev    Diamond-only (`CollectionOfferFacet`). The collateral may be
    ///         ERC-721 / ERC-1155, as for the on-chain collection slice.
    function createSignedCollectionSlice(
        address signer,
        LibVaipakam.CreateOfferParams calldata params,
        LibSignedOffer.MakerFull calldata full
    ) external whenNotPaused returns (uint256 offerId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        ISignatureTransfer.PermitTransferFrom memory emptyPermit;
        return _materializeSignedOffer(
            signer, params, SignedFunding.VaultBacked, emptyPermit, bytes32(0), "", full, Source.SignedCollection
        );
    }

    /// @notice Wallet-backed (Permit2-witness) materialize entry.
    /// @param creator   The offer signer (on-behalf-of). @param params Terms.
    /// @param permit    Permit2 struct the signer signed.
    /// @param witness   The SignedOffer hash bound as the Permit2 witness.
    /// @param permitSig The Permit2 witness signature.
    /// @param full      #1949 — the maker's Full opt-in carried on the signed artifact.
    /// @return offerId  The materialized on-chain offer id.
    function createSignedOfferWallet(
        address creator,
        LibVaipakam.CreateOfferParams calldata params,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes32 witness,
        bytes calldata permitSig,
        LibSignedOffer.MakerFull calldata full
    ) external whenNotPaused returns (uint256 offerId) {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        return _materializeSignedOffer(
            creator, params, SignedFunding.WalletWitness, permit, witness, permitSig, full, Source.Signed
        );
    }

    /// @dev Shared materialize body for both signed-offer funding entries.
    ///      Reuses `LibOfferCreate.setup` + `LibOfferCreate.finish` verbatim and
    ///      swaps only the asset pull by `fundingMode`. `creator` is the real
    ///      signer (passed on-behalf-of so `offer.creator` + the lien +
    ///      sanctions resolve to the signer, not the diamond). v0.5 restricts
    ///      the shape to the two clean ERC-20 legs.
    function _materializeSignedOffer(
        address creator,
        LibVaipakam.CreateOfferParams calldata params,
        SignedFunding fundingMode,
        ISignatureTransfer.PermitTransferFrom memory permit,
        bytes32 witness,
        bytes memory permitSig,
        LibSignedOffer.MakerFull memory full,
        Source source
    ) private returns (uint256 offerId) {
        // v0.5 supported shapes: ERC-20 Lender-principal offer, or
        // ERC-20-collateral Borrower offer. NFT lender / NFT-rental
        // (prepay) / refinance-tagged are deferred.
        address fundedAsset = source != Source.Signed
            ? _resolveCollectionSliceAsset(params)
            : _resolveSignedOfferStakeAsset(params);
        if (params.refinanceTargetLoanId != 0) {
            revert SignedOfferUnsupportedShape();
        }

        address vault;
        (offerId, vault) = LibOfferCreate.setup(creator, params);
        _applyMakerFull(offerId, full); // #1949
        uint256 amount = LibOfferCreate.creatorPullAmount(offerId, params);

        if (fundingMode == SignedFunding.VaultBacked) {
            // Funds already sit in the signer's vault as free balance — assert
            // they cover the stake, then SKIP the wallet pull. The
            // `LibOfferCreate.finish` offer-principal lien locks the verified free
            // balance; the immediate accept (caller side) consumes + releases
            // it. No `recordVaultDepositERC20` — the balance was tracked when
            // the signer originally deposited it.
            uint256 raw = LibVaipakam.trackedHolding(creator, fundedAsset, 0);
            uint256 free = LibEncumbrance.freeBalance(creator, fundedAsset, 0, raw);
            if (free < amount) {
                revert SignedOfferInsufficientFreeBalance(fundedAsset, free, amount);
            }
            // The signer spends free vault balance: the depository ledger
            // (what of it the signer may withdraw) pays first. A collection
            // slice's principal is the parent's escrow, not that balance.
            if (source != Source.CollectionParent) LibDepositoryLedger.spend(creator, fundedAsset, 0, amount);
        } else {
            // Wallet-witness: one Permit2 signature binds the pull + the terms.
            LibPermit2.pullWithWitness(
                creator,
                vault,
                fundedAsset,
                amount,
                permit,
                witness,
                LibSignedOffer.WITNESS_TYPE_STRING,
                permitSig
            );
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.recordVaultDepositERC20.selector,
                    creator,
                    fundedAsset,
                    amount
                ),
                VaultDepositFailed.selector
            );
        }
        LibOfferCreate.finish(creator, offerId, params, LibOfferAdmission.Route.SignedMaterialize);
    }

    /// @notice #1949 — the same event `ProfileFacet.setOfferCreatorFullTariff`
    ///         emits (same signature, one topic): a signed-offer maker's Full
    ///         opt-in is applied at materialization, so indexers see one shape.
    event OfferCreatorFullTariffSet(uint256 indexed offerId, bool creatorFull, uint256 maxCStar, bool allowDowngrade);

    /// @dev #1949 — apply the maker's Full opt-in carried on the signed artifact.
    ///      A signed offer is materialized and accepted in ONE transaction, so
    ///      there is no post-create moment for the standing-offer setter; the
    ///      three fields and the event are the setter's, so the accept's tariff
    ///      resolution and the indexer see one shape. The ceiling rule has ONE
    ///      home, `LibSignedOffer.fillFailure`, run by every fill route
    ///      before any value moves; the materialize entries are Diamond-only, and
    ///      their third caller (the intent slice) passes no maker Full, so a
    ///      second check here would be a second statement of one rule. A slice's
    ///      pro-rata ceiling rounds UP, so a vetted non-zero ceiling never
    ///      arrives here as zero.
    function _applyMakerFull(uint256 offerId, LibSignedOffer.MakerFull memory full) private {
        if (!full.full) return;
        LibVaipakam.Offer storage o = LibVaipakam.storageSlot().offers[offerId];
        o.creatorFull = true;
        o.creatorMaxCStar = full.maxCStar;
        o.creatorAllowFullDowngrade = full.allowDowngrade;
        emit OfferCreatorFullTariffSet(offerId, true, full.maxCStar, full.allowDowngrade);
    }

    /// @dev #3328 — a collection slice is a Lender offer of an ERC-20
    ///      principal against ERC-721 / ERC-1155 collateral; its stake is the
    ///      principal.
    function _resolveCollectionSliceAsset(
        LibVaipakam.CreateOfferParams calldata params
    ) private pure returns (address) {
        if (
            params.offerType != LibVaipakam.OfferType.Lender ||
            params.assetType != LibVaipakam.AssetType.ERC20 ||
            params.collateralAssetType == LibVaipakam.AssetType.ERC20
        ) {
            revert SignedOfferUnsupportedShape();
        }
        return params.lendingAsset;
    }

    /// @dev Resolve the creator-side staked ERC-20 asset for a signed offer
    ///      and enforce the v0.5 supported shape. Lender ⇒ `lendingAsset`
    ///      (principal); ERC-20 Borrower ⇒ `collateralAsset`. Any non-ERC-20
    ///      leg reverts `SignedOfferUnsupportedShape` (NFT lender + NFT-rental
    ///      prepay funding are deferred past v0.5).
    function _resolveSignedOfferStakeAsset(
        LibVaipakam.CreateOfferParams calldata params
    ) private pure returns (address) {
        if (params.offerType == LibVaipakam.OfferType.Lender) {
            // BOTH legs must be ERC-20 in v0.5: the principal (the lender's
            // stake, checked) AND the collateral the borrower will pledge. A
            // signed lender offer requiring ERC-721/1155 collateral would
            // otherwise materialize and route through the untested NFT-
            // collateral accept path (out of v0.5 scope).
            if (
                params.assetType != LibVaipakam.AssetType.ERC20 ||
                params.collateralAssetType != LibVaipakam.AssetType.ERC20
            ) {
                revert SignedOfferUnsupportedShape();
            }
            return params.lendingAsset;
        }
        if (
            params.assetType != LibVaipakam.AssetType.ERC20 ||
            params.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) {
            revert SignedOfferUnsupportedShape();
        }
        return params.collateralAsset;
    }
}
