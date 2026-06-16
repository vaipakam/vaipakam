// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SignatureChecker} from
    "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {LibVaipakam} from "./LibVaipakam.sol";

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
        "uint256 refinanceTargetLoanId,bool useFullTermInterest,address signer,"
        "uint256 nonce,uint256 deadline)"
        "TokenPermissions(address token,uint256 amount)";

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("Vaipakam SignedOffer");
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
    /// @dev    The encode is split into THREE `abi.encode` chunks of ≤10
    ///         values joined with `bytes.concat`, rather than one 29-argument
    ///         `abi.encode`. This library function INLINES into every consumer
    ///         (internal lib funcs always inline), so a wide single `abi.encode`
    ///         pushes the consumer over viaIR's whole-unit stack ceiling
    ///         (observed: "Variable ... too deep by 1 slot" once OfferAcceptFacet
    ///         inlined it — see `reference_viair_stack_too_deep_lever`). EVERY
    ///         `SignedOffer` field is a STATIC EIP-712 type (uint/address/bool/
    ///         bytes32), so `abi.encode` is plain 32-byte-word concatenation and
    ///         the three chunks concatenated are byte-identical to the single
    ///         29-arg encode. Keep chunk widths ≤10 if fields are added.
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
                    o.signer,
                    o.nonce,
                    o.deadline
                )
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
        p.amountMax = o.amountMax;
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
    /// @param  o          The signed offer.
    /// @param  fillAmount The principal this slice fills (≤ the offer's remaining).
    function toCreateOfferParams(SignedOffer memory o, uint256 fillAmount)
        internal
        pure
        returns (LibVaipakam.CreateOfferParams memory p)
    {
        p = toCreateOfferParams(o);
        // Principal collapses to the slice (single-value).
        p.amount = fillAmount;
        p.amountMax = fillAmount;
        // Collateral scales pro-rata at the offer's CONSTANT ratio:
        // `sliceColl = collateralAmount * fillAmount / amount`. The matcher's
        // `_vetSignedOfferForMatch` guarantees the signed ratio is constant
        // (`collMin:amount == collMax:amountMax`), so this single formula gives
        // exactly `collateralAmount` at the floor and `collateralAmountMax` at
        // the ceiling, and is ADDITIVE across partial slices: the per-slice
        // collateral sums to `collateralAmountMax` at full fill (integer-floor
        // keeps the aggregate AT OR BELOW the signed ceiling — never above, so
        // a multi-slice fill can't over-collect from the signer). Mirrors the
        // pro-rata partial-fill model standard limit-order books (0x / Seaport /
        // CoW) use; a non-constant ratio is rejected before reaching here.
        uint256 sliceColl = (o.collateralAmount * fillAmount) / o.amount;
        p.collateralAmount = sliceColl;
        p.collateralAmountMax = sliceColl;
    }
}
