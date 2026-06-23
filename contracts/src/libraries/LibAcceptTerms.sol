// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SignatureChecker} from
    "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title LibAcceptTerms
 * @author Vaipakam Developer Team
 * @notice EIP-712 typed-data foundation for offer-acceptance term binding
 *         (#662 — see `docs/DesignsAndPlans/OfferAcceptTermBindingDesign.md`).
 *
 * @dev    `acceptOffer` historically bound the acceptor's signature to an
 *         opaque `offerId` + a hardcodable `bool` only. A phishing clone could
 *         therefore have a victim sign a valid acceptance whose wallet prompt
 *         revealed nothing human-readable, draining them via a dummy-asset
 *         offer (the illiquid LTV/HF-bypass vector, scenarios A/B in the
 *         design doc).
 *
 *         The fix: acceptance is an EIP-712-typed `AcceptTerms` message that
 *         binds EVERY loan-affecting field. Wallets render the real terms, so
 *         the acceptor sees what they're agreeing to; the contract then
 *         enforces that the rendered terms equal the stored offer before any
 *         value moves. The calldata-only guard alone is tautological against
 *         an attacker's own offer — the typed prompt is the load-bearing piece
 *         (Codex review #722, L169).
 *
 *         An **acceptance-specific** EIP-712 domain (`"Vaipakam AcceptOffer"`,
 *         distinct from `LibSignedOffer`'s `"Vaipakam SignedOffer"`) means the
 *         wallet labels the prompt as an acceptance, and a signed-offer
 *         signature can never be cross-replayed as an acceptance.
 *
 *         Library-resident so the hashing is ONE bytecode blob shared by every
 *         accept entry point (direct / Permit2 / signed-offer fill) and so
 *         tests can hash without a cross-facet call.
 */
library LibAcceptTerms {
    /// @notice The EIP-712 typed-data form of an offer acceptance. Field order
    ///         is load-bearing: it MUST match {ACCEPT_TERMS_TYPEHASH} and the
    ///         off-chain signer's type definition exactly, or recovered
    ///         signatures will not match. Enum-typed offer fields are carried
    ///         as `uint8` (EIP-712 primitive), mirroring {LibSignedOffer}.
    struct AcceptTerms {
        address acceptor; // MUST equal the recovered / 1271 signer + the funds-mover
        address offerCreator; // counterparty (offer.creator → loan.lender/borrower)
        bytes32 offerKey; // direct: keccak256(offerId); signed: the signed-offer digest
        uint8 offerType; // LibVaipakam.OfferType — selects role-aware endpoints
        address lendingAsset;
        address collateralAsset;
        uint256 amount; // EQUALITY vs the role-correct endpoint
        uint256 collateralAmount;
        uint256 interestRateBps; // EQUALITY vs the role-correct rate endpoint
        uint256 durationDays;
        uint256 tokenId;
        uint256 collateralTokenId;
        uint256 quantity;
        uint256 collateralQuantity;
        uint8 assetType; // LibVaipakam.AssetType (lent)
        uint8 collateralAssetType; // LibVaipakam.AssetType (collateral)
        address prepayAsset;
        bool useFullTermInterest;
        bool allowsPartialRepay;
        bool allowsPrepayListing;
        bool allowsParallelSale;
        uint256 refinanceTargetLoanId;
        uint256 linkedLoanId; // saleOfferToLoanId / offsetOfferToLoanId target
        bytes32 parallelSaleOrderHash; // live Seaport order kept across accept (0 if none)
        uint8 periodicInterestCadence; // LibVaipakam.PeriodicInterestCadence
        bool riskAndTermsConsent; // the §233 single mandatory consent (folded in for relay-safety)
        address acknowledgedIlliquidLendingAsset; // == lendingAsset iff illiquid, else 0
        address acknowledgedIlliquidCollateralAsset; // == collateralAsset iff illiquid, else 0
        uint256 nonce; // per-acceptor replay nonce
        uint256 deadline; // signature validity deadline (unix-seconds)
    }

    /// @dev keccak256 of the canonical type string. The string MUST list the
    ///      fields in EXACTLY the {AcceptTerms} struct order, with EIP-712
    ///      primitive types (enums ⇒ uint8). Any drift silently breaks
    ///      signature verification.
    bytes32 internal constant ACCEPT_TERMS_TYPEHASH = keccak256(
        "AcceptTerms("
        "address acceptor,"
        "address offerCreator,"
        "bytes32 offerKey,"
        "uint8 offerType,"
        "address lendingAsset,"
        "address collateralAsset,"
        "uint256 amount,"
        "uint256 collateralAmount,"
        "uint256 interestRateBps,"
        "uint256 durationDays,"
        "uint256 tokenId,"
        "uint256 collateralTokenId,"
        "uint256 quantity,"
        "uint256 collateralQuantity,"
        "uint8 assetType,"
        "uint8 collateralAssetType,"
        "address prepayAsset,"
        "bool useFullTermInterest,"
        "bool allowsPartialRepay,"
        "bool allowsPrepayListing,"
        "bool allowsParallelSale,"
        "uint256 refinanceTargetLoanId,"
        "uint256 linkedLoanId,"
        "bytes32 parallelSaleOrderHash,"
        "uint8 periodicInterestCadence,"
        "bool riskAndTermsConsent,"
        "address acknowledgedIlliquidLendingAsset,"
        "address acknowledgedIlliquidCollateralAsset,"
        "uint256 nonce,"
        "uint256 deadline"
        ")"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    /// @dev Acceptance-specific domain name — distinct from
    ///      `LibSignedOffer`'s `"Vaipakam SignedOffer"` so a signed-offer
    ///      signature cannot be replayed as an acceptance and the wallet
    ///      labels the prompt correctly (Codex #722 r3).
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("Vaipakam AcceptOffer");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    /// @notice EIP-712 domain separator, bound to this chain + the Diamond
    ///         (`address(this)` resolves to the Diamond in the executing
    ///         facet context). Computed fresh each call so a fork / redeploy
    ///         can never share a separator.
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

    /// @notice The EIP-712 struct hash of an `AcceptTerms`.
    /// @dev    The encode is split into chunks of ≤10 values joined with
    ///         `bytes.concat`, NOT one 31-argument `abi.encode`: this internal
    ///         lib fn inlines into every consumer, and a wide single encode
    ///         trips viaIR's whole-unit stack ceiling (see
    ///         `reference_viair_stack_too_deep_lever` + the same pattern in
    ///         {LibSignedOffer.hashStruct}). Every field is a STATIC EIP-712
    ///         type (uint/address/bool/bytes32), so the chunked concat is
    ///         byte-identical to the single encode. Keep chunk widths ≤10 if
    ///         fields are added.
    function hashStruct(AcceptTerms memory a) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    ACCEPT_TERMS_TYPEHASH,
                    a.acceptor,
                    a.offerCreator,
                    a.offerKey,
                    a.offerType,
                    a.lendingAsset,
                    a.collateralAsset,
                    a.amount,
                    a.collateralAmount
                ),
                abi.encode(
                    a.interestRateBps,
                    a.durationDays,
                    a.tokenId,
                    a.collateralTokenId,
                    a.quantity,
                    a.collateralQuantity,
                    a.assetType,
                    a.collateralAssetType,
                    a.prepayAsset,
                    a.useFullTermInterest
                ),
                abi.encode(
                    a.allowsPartialRepay,
                    a.allowsPrepayListing,
                    a.allowsParallelSale,
                    a.refinanceTargetLoanId,
                    a.linkedLoanId,
                    a.parallelSaleOrderHash,
                    a.periodicInterestCadence,
                    a.riskAndTermsConsent,
                    a.acknowledgedIlliquidLendingAsset,
                    a.acknowledgedIlliquidCollateralAsset
                ),
                abi.encode(a.nonce, a.deadline)
            )
        );
    }

    /// @notice The full EIP-712 digest a signer signs
    ///         (`\x19\x01` ‖ domainSeparator ‖ hashStruct).
    function digest(AcceptTerms memory a) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), hashStruct(a))
        );
    }

    /// @notice Verify that `a.acceptor` produced `signature` over `a`'s digest.
    /// @dev    OZ {SignatureChecker.isValidSignatureNow} accepts BOTH a 65-byte
    ///         EOA ECDSA signature AND an ERC-1271 contract signature, so a
    ///         smart-contract wallet (Safe, etc.) can accept offers. `acceptor`
    ///         is bound INTO the digest (so the same owner's signature cannot
    ///         validate for a different ERC-1271 account); the caller must
    ///         additionally assert `a.acceptor` is the account whose funds move.
    function verify(AcceptTerms memory a, bytes memory signature)
        internal
        view
        returns (bool ok)
    {
        ok = SignatureChecker.isValidSignatureNow(
            a.acceptor, digest(a), signature
        );
    }
}
