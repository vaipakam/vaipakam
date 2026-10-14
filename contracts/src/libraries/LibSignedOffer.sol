// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SignatureChecker} from
    "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title LibSignedOffer
 * @author Vaipakam Developer Team
 * @notice EIP-712 typed-data foundation for the v0.5 signed off-chain
 *         offer book (#396 — see
 *         `docs/DesignsAndPlans/SignedOfferBookV05Design.md`).
 *
 * @dev    A `SignedOffer` is the gasless, off-chain form of an offer: the
 *         creator signs the economically-binding terms once (no tx); a
 *         counterparty fills it on-chain via `SignedOfferFacet`, where the
 *         signature is verified and the offer is materialized into a normal
 *         on-chain offer at the instant of fill.
 *
 *         The digest binds EVERY term, so neither the matcher nor the
 *         acceptor can alter a signed offer. `signer` is bound into the
 *         struct so the recovered / ERC-1271-validated signer must equal it.
 *
 *         Library-resident (not facet-resident) so the EIP-712 hashing is
 *         ONE bytecode blob shared by `SignedOfferFacet` + any future
 *         consumer (the v1 LenderIntentVault), and so tests can hash without
 *         a cross-facet call.
 *
 *         `creatorRiskAndTermsConsent` is intentionally NOT a field: the act
 *         of signing IS the creator's consent (documented in the user-facing
 *         copy). The materialize step sets it true on the on-chain offer.
 */
library LibSignedOffer {
    /// @notice The EIP-712 typed-data form of an offer. Field order is
    ///         load-bearing: it MUST match {SIGNED_OFFER_TYPEHASH} and the
    ///         off-chain signer's type definition exactly, or recovered
    ///         signatures will not match.
    struct SignedOffer {
        uint8 offerType; // LibVaipakam.OfferType
        address lendingAsset;
        uint256 amount; // min / single-value
        uint256 amountMax; // range max (0 ⇒ collapse to `amount`)
        uint256 interestRateBps; // min / single-value
        uint256 interestRateBpsMax; // range max
        address collateralAsset;
        uint256 collateralAmount; // min / single-value
        uint256 collateralAmountMax; // range max (borrower only)
        uint256 durationDays;
        uint8 assetType; // LibVaipakam.AssetType (lent asset)
        uint8 collateralAssetType; // LibVaipakam.AssetType (collateral)
        uint256 tokenId;
        uint256 quantity;
        uint256 collateralTokenId;
        uint256 collateralQuantity;
        address prepayAsset; // NFT-rental prepay asset (else address(0))
        bool allowsPartialRepay;
        bool allowsPrepayListing;
        bool allowsParallelSale;
        uint64 expiresAt; // GTT offer-expiry (0 ⇒ GTC)
        uint8 fillMode; // LibVaipakam.FillMode (Partial/Aon/Ioc)
        uint8 periodicInterestCadence; // LibVaipakam.PeriodicInterestCadence
        uint256 refinanceTargetLoanId;
        bool useFullTermInterest;
        // #1949 — the MAKER's Full tariff opt-in, carried on the artifact they
        // sign: a signed offer is materialized and accepted in one transaction,
        // so the post-create setter (`ProfileFacet.setOfferCreatorFullTariff`)
        // never has a moment to run. The same three fields the setter writes.
        // `creatorMaxCStar` bounds the WHOLE order; a slice takes its pro-rata
        // share ({makerFullFor}).
        bool creatorFull;
        uint256 creatorMaxCStar;
        bool creatorAllowFullDowngrade;
        address signer; // MUST equal the recovered / 1271 signer
        uint256 nonce; // per-signer batch-cancel nonce
        uint256 deadline; // signature validity deadline (unix-seconds)
    }

    /// @dev keccak256 of the canonical type string. The string MUST list the
    ///      fields in EXACTLY the {SignedOffer} struct order, with EIP-712
    ///      primitive types (enums ⇒ uint8, GTT ⇒ uint64, the rest as
    ///      declared). Any drift here silently breaks signature verification.
    bytes32 internal constant SIGNED_OFFER_TYPEHASH = keccak256(
        "SignedOffer("
        "uint8 offerType,"
        "address lendingAsset,"
        "uint256 amount,"
        "uint256 amountMax,"
        "uint256 interestRateBps,"
        "uint256 interestRateBpsMax,"
        "address collateralAsset,"
        "uint256 collateralAmount,"
        "uint256 collateralAmountMax,"
        "uint256 durationDays,"
        "uint8 assetType,"
        "uint8 collateralAssetType,"
        "uint256 tokenId,"
        "uint256 quantity,"
        "uint256 collateralTokenId,"
        "uint256 collateralQuantity,"
        "address prepayAsset,"
        "bool allowsPartialRepay,"
        "bool allowsPrepayListing,"
        "bool allowsParallelSale,"
        "uint64 expiresAt,"
        "uint8 fillMode,"
        "uint8 periodicInterestCadence,"
        "uint256 refinanceTargetLoanId,"
        "bool useFullTermInterest,"
        "bool creatorFull,"
        "uint256 creatorMaxCStar,"
        "bool creatorAllowFullDowngrade,"
        "address signer,"
        "uint256 nonce,"
        "uint256 deadline"
        ")"
    );

    /// @notice Permit2 witness type declaration for the wallet-backed fill
    ///         path. Permit2 prepends its own
    ///         `PermitWitnessTransferFrom(TokenPermissions permitted,address
    ///         spender,uint256 nonce,uint256 deadline,` stub, then this
    ///         string. Per EIP-712 `encodeType`, the witness member name
    ///         comes first (`SignedOffer witness)`), then the referenced
    ///         struct type definitions in ALPHABETICAL order — `SignedOffer`
    ///         before `TokenPermissions`. The inner `SignedOffer(...)` body
    ///         MUST be byte-identical to the body inside
    ///         {SIGNED_OFFER_TYPEHASH}, or Permit2's reconstructed digest
    ///         won't match the signer's.
    string internal constant WITNESS_TYPE_STRING =
        "SignedOffer witness)"
        "SignedOffer("
        "uint8 offerType,address lendingAsset,uint256 amount,uint256 amountMax,"
        "uint256 interestRateBps,uint256 interestRateBpsMax,address collateralAsset,"
        "uint256 collateralAmount,uint256 collateralAmountMax,uint256 durationDays,"
        "uint8 assetType,uint8 collateralAssetType,uint256 tokenId,uint256 quantity,"
        "uint256 collateralTokenId,uint256 collateralQuantity,address prepayAsset,"
        "bool allowsPartialRepay,bool allowsPrepayListing,bool allowsParallelSale,"
        "uint64 expiresAt,uint8 fillMode,uint8 periodicInterestCadence,"
        "uint256 refinanceTargetLoanId,bool useFullTermInterest,bool creatorFull,"
        "uint256 creatorMaxCStar,bool creatorAllowFullDowngrade,address signer,"
        "uint256 nonce,uint256 deadline)"
        "TokenPermissions(address token,uint256 amount)";

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("Vaipakam SignedOffer");

    /// @notice #1949 — a signed Full opt-in must carry a positive ceiling, exactly as
    ///         `ProfileFacet.setOfferCreatorFullTariff` requires of a standing offer.
    error SignedOfferFullNeedsMaxCStar();

    /// @notice #1949 — the maker's Full opt-in as the materialize entries take it.
    struct MakerFull {
        bool full;
        uint256 maxCStar;
        bool allowDowngrade;
    }

    /// @notice #1949 — vetting: a Full opt-in without a ceiling can never materialize
    ///         (the standing-offer setter refuses the same shape), so refuse it before
    ///         any value moves. Both fill paths call this first.
    function requireFullWellFormed(SignedOffer calldata o) internal pure {
        if (o.creatorFull && o.creatorMaxCStar == 0) revert SignedOfferFullNeedsMaxCStar();
    }

    /// @notice #1949 — the maker Full intent for the part of `o` a fill materializes:
    ///         the principal from `filledBefore` to `filledBefore + fillAmount`. The
    ///         slice's ceiling is the DIFFERENCE of the cumulative pro-rata ceiling
    ///         `cum(P) = ceil(creatorMaxCStar * P / ceiling)` at its two ends — the
    ///         same telescoping form the slice collateral uses (`toCreateOfferParams`).
    ///         Summed over every slice the inner terms cancel, so the slices' ceilings
    ///         total `cum(filled)`, which is at most the signed ceiling and equals it
    ///         once the order is fully filled (Codex #2489 r2). Rounding each slice up
    ///         on its own instead let the slices sum past the signed ceiling, one wei
    ///         per slice, so a keeper splitting an order into minimum fills obtained
    ///         Full authorization the maker never signed. The whole order (from 0 to
    ///         the ceiling) takes the signed ceiling exactly. A slice can come out zero
    ///         only when the signed ceiling is below one wei per slice, where any real
    ///         tariff exceeds the share anyway; such a slice is refused (or downgraded,
    ///         if the maker allowed it), never charged above the signed total. A
    ///         non-Full order carries zeros. Each `cum` is a full-width `mulDiv`: the
    ///         ceiling is signer-chosen, and a plain product would overflow on a large
    ///         one and refuse every slice fill.
    function makerFullFor(SignedOffer memory o, uint256 filledBefore, uint256 fillAmount)
        internal
        pure
        returns (MakerFull memory f)
    {
        if (!o.creatorFull) return f;
        uint256 ceiling = o.amountMax == 0 ? o.amount : o.amountMax;
        f.full = true;
        f.allowDowngrade = o.creatorAllowFullDowngrade;
        f.maxCStar = _cumCeiling(o.creatorMaxCStar, filledBefore + fillAmount, ceiling)
            - _cumCeiling(o.creatorMaxCStar, filledBefore, ceiling);
    }

    /// @dev The cumulative pro-rata ceiling at principal `filled` of an order of size
    ///      `ceiling`: the whole signed ceiling at (or past) the order's size, else its
    ///      share rounded up. Monotone in `filled`, so the slice difference above can
    ///      never underflow.
    function _cumCeiling(uint256 maxCStar, uint256 filled, uint256 ceiling) private pure returns (uint256) {
        return filled >= ceiling ? maxCStar : Math.mulDiv(maxCStar, filled, ceiling, Math.Rounding.Ceil);
    }
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    /// @notice The EIP-712 domain separator, bound to this chain + the
    ///         Diamond (`address(this)` inside the executing library/facet
    ///         context resolves to the Diamond). Computed fresh each call so
    ///         a fork / redeploy can never share a separator (no cached
    ///         stale chainId), which is the cheap defence the `Permit2`-style
    ///         constant-address constant cannot give us here.
    function domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice The EIP-712 struct hash of a `SignedOffer` (the `hashStruct`,
    ///         NOT the full digest — see {digest}).
    /// @dev    The encode is split into FOUR `abi.encode` chunks of ≤10
    ///         values joined with `bytes.concat`, rather than one 32-argument
    ///         `abi.encode`. This library function INLINES into every consumer
    ///         (internal lib funcs always inline), so a wide single `abi.encode`
    ///         pushes the consumer over viaIR's whole-unit stack ceiling
    ///         (observed: "Variable ... too deep by 1 slot" once OfferAcceptFacet
    ///         inlined it — see `reference_viair_stack_too_deep_lever`). EVERY
    ///         `SignedOffer` field is a STATIC EIP-712 type (uint/address/bool/
    ///         bytes32), so `abi.encode` is plain 32-byte-word concatenation and
    ///         the three chunks concatenated are byte-identical to the single
    ///         32-arg encode. Keep chunk widths ≤10 if fields are added.
    function hashStruct(SignedOffer memory o) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    SIGNED_OFFER_TYPEHASH,
                    o.offerType,
                    o.lendingAsset,
                    o.amount,
                    o.amountMax,
                    o.interestRateBps,
                    o.interestRateBpsMax,
                    o.collateralAsset,
                    o.collateralAmount
                ),
                abi.encode(
                    o.collateralAmountMax,
                    o.durationDays,
                    o.assetType,
                    o.collateralAssetType,
                    o.tokenId,
                    o.quantity,
                    o.collateralTokenId,
                    o.collateralQuantity,
                    o.prepayAsset,
                    o.allowsPartialRepay
                ),
                abi.encode(
                    o.allowsPrepayListing,
                    o.allowsParallelSale,
                    o.expiresAt,
                    o.fillMode,
                    o.periodicInterestCadence,
                    o.refinanceTargetLoanId,
                    o.useFullTermInterest,
                    o.creatorFull,
                    o.creatorMaxCStar,
                    o.creatorAllowFullDowngrade
                ),
                abi.encode(o.signer, o.nonce, o.deadline)
            )
        );
    }

    /// @notice The full EIP-712 digest a signer signs (`\x19\x01` ‖
    ///         domainSeparator ‖ hashStruct). This is also the **order hash**
    ///         the v0.5 remaining-amount / replay ledger is keyed by.
    function digest(SignedOffer memory o) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), hashStruct(o))
        );
    }

    /// @notice Verify that `o.signer` produced `signature` over `o`'s digest,
    ///         and return the **struct hash** as the canonical order hash.
    /// @dev    Uses OZ {SignatureChecker.isValidSignatureNow}, which accepts
    ///         BOTH a 65-byte EOA ECDSA signature AND an ERC-1271 contract
    ///         signature — so a smart-contract wallet (Safe, or a future
    ///         LenderIntentVault / aggregator adapter) can sign offers from
    ///         day one.
    ///
    ///         `orderHash` is the **`hashStruct`** (domain-independent), NOT
    ///         the full digest, so the v0.5 remaining/replay ledger keys on
    ///         the same value in BOTH funding modes: vault-backed verifies the
    ///         full digest here, while wallet-backed binds this same
    ///         `hashStruct` as the Permit2 witness. Chain/domain binding still
    ///         lives in the signature check (the digest folds in the
    ///         chain-bound domain separator), so a cross-chain replay fails at
    ///         signature verification regardless of the ledger key.
    function verify(SignedOffer memory o, bytes memory signature)
        internal
        view
        returns (bool ok, bytes32 orderHash)
    {
        orderHash = hashStruct(o);
        bytes32 fullDigest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), orderHash)
        );
        ok = SignatureChecker.isValidSignatureNow(o.signer, fullDigest, signature);
    }

    /// @notice Map a `SignedOffer` to the on-chain `CreateOfferParams` used to
    ///         materialize it (full size — the offer's own `amount`/range).
    /// @dev    Shared by `SignedOfferFacet` (the v0.5 fill path) and the v0.6
    ///         `OfferMatchFacet` matcher so the mapping lives in ONE place.
    ///         Populated field-by-field on a memory struct (a 26-field literal
    ///         trips viaIR's stack ceiling). `creatorRiskAndTermsConsent` is
    ///         set true — the signature IS the creator's consent.
    function toCreateOfferParams(SignedOffer memory o)
        internal
        pure
        returns (LibVaipakam.CreateOfferParams memory p)
    {
        p.offerType = LibVaipakam.OfferType(o.offerType);
        p.lendingAsset = o.lendingAsset;
        p.amount = o.amount;
        p.interestRateBps = o.interestRateBps;
        p.collateralAsset = o.collateralAsset;
        p.collateralAmount = o.collateralAmount;
        p.durationDays = o.durationDays;
        p.assetType = LibVaipakam.AssetType(o.assetType);
        p.tokenId = o.tokenId;
        p.quantity = o.quantity;
        p.creatorRiskAndTermsConsent = true;
        p.prepayAsset = o.prepayAsset;
        p.collateralAssetType = LibVaipakam.AssetType(o.collateralAssetType);
        p.collateralTokenId = o.collateralTokenId;
        p.collateralQuantity = o.collateralQuantity;
        p.allowsPartialRepay = o.allowsPartialRepay;
        // #1195 B1 (Pass-2, §1083) — honor the `amountMax == 0 ⇒ amount`
        // sentinel on the DIRECT fill path too, matching the matcher path
        // (OfferMatchFacet) and this offer's own `_ceiling` consume-ledger
        // helper. Without this, a signed offer authored with `amountMax == 0`
        // (single-value shorthand) reverts `AmountMaxMustBePositive` at
        // create-time on a direct fill while filling fine via the matcher —
        // a fail-loud path inconsistency.
        p.amountMax = o.amountMax == 0 ? o.amount : o.amountMax;
        p.interestRateBpsMax = o.interestRateBpsMax;
        p.collateralAmountMax = o.collateralAmountMax;
        p.periodicInterestCadence =
            LibVaipakam.PeriodicInterestCadence(o.periodicInterestCadence);
        p.expiresAt = o.expiresAt;
        p.fillMode = LibVaipakam.FillMode(o.fillMode);
        p.allowsPrepayListing = o.allowsPrepayListing;
        p.allowsParallelSale = o.allowsParallelSale;
        p.refinanceTargetLoanId = o.refinanceTargetLoanId;
        p.useFullTermInterest = o.useFullTermInterest;
    }

    /// @notice Map a `SignedOffer` to a SLICE of it sized `fillAmount` — used
    ///         by the v0.6 matcher to materialize exactly the portion a single
    ///         match fills. The principal collapses to `fillAmount`
    ///         (single-value, so the materialized slice is fully consumed by
    ///         one match — no dangling on-chain remainder); the collateral
    ///         scales **pro-rata, rounded UP**; the rate band is kept so the
    ///         match midpoint with the counterparty still resolves.
    /// @dev    Rounding-up is the conservative choice, but correctness does NOT
    ///         depend on the precise slice collateral: `LibOfferMatch.previewMatch`
    ///         independently computes the real required collateral and enforces
    ///         `CollateralBelowRequired` + the synthetic HF / LtvAboveTier gates,
    ///         so a too-low slice collateral reverts the match — it can never
    ///         mint an under-collateralized loan. The off-chain offer's
    ///         remaining is tracked by `signedOfferFilled[orderHash]`.
    /// @param  o            The signed offer.
    /// @param  filledBefore Cumulative principal already filled by prior slices
    ///                      of THIS order (the `signedOfferFilled` ledger value
    ///                      BEFORE this fill). Used to price collateral as the
    ///                      cumulative DIFFERENCE so per-slice rounding can't
    ///                      drop the signed total — see below.
    /// @param  fillAmount   The principal this slice fills (≤ the remaining).
    function toCreateOfferParams(
        SignedOffer memory o,
        uint256 filledBefore,
        uint256 fillAmount
    )
        internal
        pure
        returns (LibVaipakam.CreateOfferParams memory p)
    {
        p = toCreateOfferParams(o);
        // Principal collapses to the slice (single-value).
        p.amount = fillAmount;
        p.amountMax = fillAmount;
        // Collateral scales pro-rata at the offer's CONSTANT ratio
        // (`collMin:amount == collMax:amountMax`, guaranteed by the matcher's
        // `_vetSignedOfferForMatch`). Price it as the cumulative DIFFERENCE of
        // the pro-rata curve `cumColl(P) = collateralAmount * P / amount`:
        //
        //   sliceColl = cumColl(filledBefore + fillAmount) − cumColl(filledBefore)
        //
        // This TELESCOPES — summed over all slices the intermediate terms cancel
        // and the total is `cumColl(amountMax) = collateralAmountMax` EXACTLY
        // (constant ratio makes that division exact). Pricing each slice
        // independently as `collMin*fill/amount` instead would floor each slice
        // separately, so a keeper could pick fills whose dropped remainders sum
        // to less than the signed total (e.g. amount=3/collMin=2 filled 4+5
        // locks 2+3=5, not 6) — under-collateralizing a signed-LENDER full fill.
        // The cumulative form assigns each rounding remainder to the slice that
        // crosses the next integer, so the signed pro-rata total is preserved.
        uint256 sliceColl =
            (o.collateralAmount * (filledBefore + fillAmount)) / o.amount
                - (o.collateralAmount * filledBefore) / o.amount;
        p.collateralAmount = sliceColl;
        p.collateralAmountMax = sliceColl;
    }
}
