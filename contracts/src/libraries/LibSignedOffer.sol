// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SignatureChecker} from
    "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

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
    /// @dev    The encode is split into two `abi.encode` chunks joined with
    ///         `bytes.concat` rather than one 29-argument `abi.encode`. The
    ///         single-call form risks "stack too deep" under viaIR on a
    ///         codebase already near the whole-unit stack ceiling
    ///         (see `reference_viair_stack_too_deep_lever` / the encumbrance
    ///         arc); the chunked form keeps peak stack shallow. The two
    ///         chunks concatenated are byte-identical to the single encode.
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
                    o.collateralAmount,
                    o.collateralAmountMax,
                    o.durationDays,
                    o.assetType,
                    o.collateralAssetType,
                    o.tokenId,
                    o.quantity
                ),
                abi.encode(
                    o.collateralTokenId,
                    o.collateralQuantity,
                    o.prepayAsset,
                    o.allowsPartialRepay,
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

    /// @notice Verify that `o.signer` produced `signature` over `o`'s digest.
    /// @dev    Uses OZ {SignatureChecker.isValidSignatureNow}, which accepts
    ///         BOTH a 65-byte EOA ECDSA signature AND an ERC-1271 contract
    ///         signature — so a smart-contract wallet (Safe, or a future
    ///         LenderIntentVault / aggregator adapter) can sign offers from
    ///         day one. Returns the digest so callers reuse it as the order
    ///         hash without recomputing.
    function verify(SignedOffer memory o, bytes memory signature)
        internal
        view
        returns (bool ok, bytes32 orderHash)
    {
        orderHash = digest(o);
        ok = SignatureChecker.isValidSignatureNow(o.signer, orderHash, signature);
    }
}
