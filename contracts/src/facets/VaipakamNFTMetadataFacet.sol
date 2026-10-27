// src/facets/VaipakamNFTMetadataFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibJsonText} from "../libraries/LibJsonText.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MetricsFacet} from "./MetricsFacet.sol";

/**
 * @title VaipakamNFTMetadataFacet
 * @author Vaipakam Developer Team
 * @notice The position NFT's public metadata: `tokenURI`, the collection's
 *         `contractURI`, and the admin configuration they render from (the
 *         status-keyed images and the `external_url` base).
 * @dev    Split out of {VaipakamNFTFacet} in #2957, which had reached 24
 *         bytes under EIP-170 once the metadata stated each figure in its own
 *         asset. The seam is the one between the token's ownership and
 *         lifecycle (mint, status, burn, transfer, locks, royalties, which stay
 *         there) and how it is described to a marketplace (here). Both read
 *         the same `LibERC721` storage; this facet writes only the metadata
 *         configuration. Every figure it renders comes from
 *         {MetricsFacet.getNFTPositionSummary}, so this facet and
 *         MetricsFacet are refreshed together.
 */
contract VaipakamNFTMetadataFacet is DiamondAccessControl {
    using Strings for uint256;
    using Strings for address;

    /// @notice Emitted when the image URI for a (status, isLender) pair
    ///         is rotated. Indexers + frontends can listen for this to
    ///         invalidate any cached `tokenURI` reads downstream.
    /// @custom:event-category informational/governance
    event StatusImageURIUpdated(
        LibVaipakam.LoanPositionStatus indexed status,
        bool indexed isLender,
        string uri
    );

    /// @notice Emitted when the per-side default image URL is rotated.
    /// @custom:event-category informational/governance
    event DefaultImageURIUpdated(bool indexed isLender, string uri);

    /**
     * @notice Sets the image URI for a specific (LoanPositionStatus,
     *         isLender) pair. Granular: changing the borrower-defaulted
     *         art doesn't affect the lender-active art.
     * @dev    Admin-only; ADMIN_ROLE is governance-transferable. Pass
     *         an empty string to clear the override and fall back to
     *         the per-side default image. Lookup chain consumed by
     *         `tokenURI`:
     *           1. statusImageUris[status][isLender]
     *           2. defaultLenderImage / defaultBorrowerImage
     *           3. contractImageURI
     *           4. empty string
     * @param status   The position-status enum value to override.
     * @param isLender `true` for lender NFTs, `false` for borrower NFTs.
     * @param uri      Image URL (IPFS, https, or data URI).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function setImageURIForStatus(
        LibVaipakam.LoanPositionStatus status,
        bool isLender,
        string calldata uri
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibERC721._storage().statusImageUris[status][isLender] = uri;
        emit StatusImageURIUpdated(status, isLender, uri);
    }

    /**
     * @notice Sets the per-side default image URL. Used by `tokenURI`
     *         when no granular `(status, isLender)` override is set.
     * @dev    Admin-only. Empty string disables the side-level default,
     *         pushing the fallback to `contractImageURI`.
     * @param isLender `true` for lender default, `false` for borrower.
     * @param uri      Image URL (IPFS, https, or data URI).
     */
    function setDefaultImage(bool isLender, string calldata uri)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (isLender) {
            LibERC721._storage().defaultLenderImage = uri;
        } else {
            LibERC721._storage().defaultBorrowerImage = uri;
        }
        emit DefaultImageURIUpdated(isLender, uri);
    }

    /**
     * @notice Read the resolved image URI for a given `(status, isLender)`
     *         pair, walking the same fallback chain `tokenURI` uses.
     *         Lets the frontend admin dashboard preview which image
     *         will render before broadcasting an override.
     * @return uri The resolved image URI string. Empty when no entry is
     *             set at any level of the chain.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function getImageURIFor(
        LibVaipakam.LoanPositionStatus status,
        bool isLender
    ) external view returns (string memory) {
        return _resolveImageUri(status, isLender);
    }

    /// @dev Image-URI resolution. See {setImageURIForStatus} for the
    ///      lookup-chain spec. Pure storage reads; gas-cheap.
    function _resolveImageUri(
        LibVaipakam.LoanPositionStatus status,
        bool isLender
    ) internal view returns (string memory) {
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        string memory specific = es.statusImageUris[status][isLender];
        if (bytes(specific).length > 0) return specific;
        string memory sideDefault = isLender
            ? es.defaultLenderImage
            : es.defaultBorrowerImage;
        if (bytes(sideDefault).length > 0) return sideDefault;
        if (bytes(es.contractImageURI).length > 0) return es.contractImageURI;
        return "";
    }

    /**
     * @notice Returns the URI for a given token ID, dynamically generating JSON metadata.
     * @dev Generates Base64-encoded JSON with on-chain data.
     *
     *      Range Orders Phase 1 follow-up: reads the live NFT position
     *      summary via {MetricsFacet.getNFTPositionSummary} so the
     *      rendered metadata reflects the realized loan terms (matched
     *      principal/rate after a partial fill), live vault state,
     *      and current claim availability — not the original offer's
     *      range bounds. Numeric traits use OpenSea `display_type`
     *      conventions (`number`, `boost_percentage`, `date`) for
     *      sensible marketplace rendering.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function tokenURI(
        uint256 tokenId
    ) external view returns (string memory) {
        LibERC721.ownerOf(tokenId); // Reverts for non-existent tokens

        LibERC721.ERC721Storage storage es = LibERC721._storage();

        // Single-source-of-truth read for everything the metadata
        // surfaces. MetricsFacet computes loan-vs-offer fallback,
        // symbol/decimals lookup, and claim state in one shot.
        MetricsFacet.NFTPositionSummary memory s =
            MetricsFacet(address(this)).getNFTPositionSummary(tokenId);
        // #2750 — the token symbols are the only strings in this JSON that a
        // third party controls (each token's own contract chooses its
        // symbol). Made JSON-safe and bounded once, here, before any part of
        // the metadata is assembled from them.
        s.principalSymbol = LibJsonText.safeText(s.principalSymbol, LibJsonText.MAX_SYMBOL_BYTES);
        s.collateralSymbol = LibJsonText.safeText(s.collateralSymbol, LibJsonText.MAX_SYMBOL_BYTES);
        s.prepaySymbol = LibJsonText.safeText(s.prepaySymbol, LibJsonText.MAX_SYMBOL_BYTES);
        s.claimableSymbol = LibJsonText.safeText(s.claimableSymbol, LibJsonText.MAX_SYMBOL_BYTES);

        // Image lookup walks the per-(status, isLender) → per-side
        // default → contractImageURI chain. Granular over the prior
        // 4-slot active/closed binary so a defaulted lender NFT can
        // render distinct art from a repaid one.
        string memory image = _resolveImageUri(s.nftStatus, s.isLender);

        // Optional `external_url` — only emitted when an admin has
        // configured the base URL. Empty base ⇒ field omitted, JSON
        // stays lean.
        string memory externalUrlField = _externalUrlField(es.externalUrlBase, s);

        string memory json = string(
            abi.encodePacked(
                '{"name":"Vaipakam NFT #',
                tokenId.toString(),
                '","description":"',
                _buildDescription(s),
                '","image":"',
                image,
                '","background_color":"',
                _backgroundColor(s),
                '"',
                externalUrlField,
                ',"attributes":',
                _buildAttributes(s),
                "}"
            )
        );

        return string(
            abi.encodePacked(
                "data:application/json;base64,",
                Base64.encode(bytes(json))
            )
        );
    }

    /// @dev Human-readable description consumed by marketplaces that render a
    ///      summary alongside traits. Reads from the live NFT position
    ///      summary so a partial-fill loan's NFT shows the realized
    ///      principal, not the lender offer's range minimum.
    function _buildDescription(
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (string memory) {
        // Slither flags consecutive dynamic types in `abi.encodePacked` as
        // a potential collision source. This output is a human-readable
        // string baked into the ERC-721 token URI for marketplace display
        // (never hashed, never used as a key) — different inputs SHOULD
        // collide-visibly in the rendered text, which is the whole point
        // of the format. Not a vuln.
        // slither-disable-next-line encode-packed-collision
        return string(
            abi.encodePacked(
                "Vaipakam ",
                s.isLender ? "Lender" : "Borrower",
                " position NFT #",
                s.tokenId.toString(),
                ". Kind: ",
                _positionKind(s.nftStatus),
                ". Status: ",
                _statusToString(s.nftStatus),
                ". Offer #",
                s.offerId.toString(),
                s.loanId == 0 ? "" : string(abi.encodePacked(", Loan #", s.loanId.toString())),
                ". Claim rights: ",
                _governsClaimRights(s.nftStatus) ? "Yes" : "No",
                ". Chain ID: ",
                s.chainId.toString(),
                "."
            )
        );
    }

    /// @dev Attribute array — three-segment build to keep each fragment
    ///      under viaIR's stack budget. Numeric traits include OpenSea
    ///      `display_type` annotations so marketplaces render them with
    ///      correct UI affordances (percentage badges, date formatters).
    function _buildAttributes(
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (string memory) {
        // See `_buildDescription` for the encode-packed-collision rationale:
        // this output is the JSON `attributes` array baked into the ERC-721
        // token URI for marketplace display — not hashed, not signed, not
        // used as a map key. Concatenating three fragments here is the
        // viaIR stack-budget workaround documented above the function.
        // slither-disable-next-line encode-packed-collision
        return string(
            abi.encodePacked(
                _attributesIdentity(s),
                _attributesEconomics(s),
                _attributesVaultAndClaim(s)
            )
        );
    }

    /// @dev Identity + classification traits — who this NFT represents,
    ///      what kind of position, where it lives.
    function _attributesIdentity(
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (string memory) {
        return string(
            abi.encodePacked(
                '[{"trait_type":"Role","value":"',
                s.isLender ? "Lender" : "Borrower",
                '"},{"trait_type":"Status","value":"',
                _statusToString(s.nftStatus),
                '"},{"trait_type":"Loan State","value":"',
                _loanStatusToString(s.loanStatus),
                '"},{"trait_type":"Position Kind","value":"',
                _positionKind(s.nftStatus),
                // #2957 — two kinds, each stated for what it is: the lent
                // asset's (an NFT for a rental) and the collateral's, which a
                // rental does not have (#2949).
                '"},{"trait_type":"Lent Asset Kind","value":"',
                _assetKindToString(s.principalAssetType),
                '"},{"trait_type":"Collateral Kind","value":"',
                _isRental(s) ? "None" : _assetKindToString(s.collateralAssetType),
                '"},{"trait_type":"Governs Claim Rights","value":"',
                _governsClaimRights(s.nftStatus) ? "Yes" : "No",
                '"},'
            )
        );
    }

    /// @dev Loan economics traits — symbols + decimal-formatted
    ///      amounts (NOT raw wei) + percentage-rendered interest rate.
    ///      `display_type` of `boost_percentage` lets marketplaces
    ///      render `5.00%` from a value of `5`. Address fields kept
    ///      separately for indexers + verification flows.
    function _attributesEconomics(
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (string memory) {
        if (_isRental(s)) return _attributesRental(s);
        return string(
            abi.encodePacked(
                '{"trait_type":"Lending Asset","value":"',
                s.principalSymbol,
                '"},{"trait_type":"Lending Asset Address","value":"',
                s.principalAsset.toHexString(),
                '"},{"trait_type":"Principal","value":"',
                _formatDecimal(s.principalAmount, s.principalDecimals),
                ' ',
                s.principalSymbol,
                '"},{"trait_type":"Interest Rate","display_type":"boost_percentage","value":',
                _bpsToPercentString(s.interestRateBps),
                '},{"trait_type":"Duration (Days)","display_type":"number","value":',
                s.durationDays.toString(),
                '},{"trait_type":"Collateral Asset","value":"',
                s.collateralSymbol,
                '"},{"trait_type":"Collateral Asset Address","value":"',
                s.collateralAsset.toHexString(),
                '"},{"trait_type":"Collateral Amount","value":"',
                _formatDecimal(s.collateralAmount, s.collateralDecimals),
                ' ',
                s.collateralSymbol,
                '"},'
            )
        );
    }

    /// @dev #2957 — a rental's economics, stated in the units each figure is
    ///      actually in: the rented NFT by its token, and the daily fee and
    ///      prepayment in the prepay asset. It has no collateral (#2949).
    function _attributesRental(
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (string memory) {
        return string(
            abi.encodePacked(
                '{"trait_type":"Rented Asset","value":"',
                _nftText(s.principalSymbol, s.principalAssetType, s.principalTokenId, s.principalQuantity),
                '"},{"trait_type":"Rented Asset Address","value":"',
                s.principalAsset.toHexString(),
                '"},{"trait_type":"Daily Rental Fee","value":"',
                _formatDecimal(s.principalAmount, s.prepayDecimals),
                ' ',
                s.prepaySymbol,
                '"},{"trait_type":"Duration (Days)","display_type":"number","value":',
                s.durationDays.toString(),
                '},{"trait_type":"Prepaid Rent","value":"',
                _formatDecimal(s.prepayAmount, s.prepayDecimals),
                ' ',
                s.prepaySymbol,
                '"},{"trait_type":"Prepaid Buffer","value":"',
                _formatDecimal(s.bufferAmount, s.prepayDecimals),
                ' ',
                s.prepaySymbol,
                '"},'
            )
        );
    }

    /// @dev Live vault + claim traits. Surfaces `Locked Collateral`
    ///      (what's actually in vault against this loan right now)
    ///      and `Claimable Now` (what the holder can call
    ///      claimAsLender / claimAsBorrower for) so marketplace
    ///      buyers see the live position state, not just static loan
    ///      terms. `Created At` uses `display_type: "date"` so OpenSea
    ///      renders a localized date.
    function _attributesVaultAndClaim(
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (string memory) {
        return string(
            abi.encodePacked(
                '{"trait_type":"Locked Collateral","value":"',
                s.collateralLockedNow == 0
                    ? "None"
                    : string(abi.encodePacked(
                        _formatDecimal(s.collateralLockedNow, s.collateralDecimals),
                        ' ',
                        s.collateralSymbol
                    )),
                '"},{"trait_type":"Claimable Now","value":"',
                s.isClaimable
                    ? string(abi.encodePacked(_claimText(s), " (terminal)"))
                    : "None",
                '"},{"trait_type":"Created At","display_type":"date","value":',
                s.createdAt.toString(),
                '},{"trait_type":"Offer ID","value":"',
                s.offerId.toString(),
                '"},{"trait_type":"Loan ID","value":"',
                s.loanId.toString(),
                '"},{"trait_type":"Chain ID","value":"',
                s.chainId.toString(),
                '"}]'
            )
        );
    }

    /// @dev Format a fixed-point amount as a human-readable decimal
    ///      string (e.g. 1500000000 with 6 decimals → "1500.0"). Drops
    ///      trailing zeros after the decimal point but keeps at least
    ///      one digit (".0" not "."). Returns "0" for zero amounts.
    function _formatDecimal(uint256 amount, uint8 decimals)
        internal
        pure
        returns (string memory)
    {
        if (amount == 0) return "0";
        if (decimals == 0) return amount.toString();
        uint256 unit = 10 ** decimals;
        uint256 whole = amount / unit;
        uint256 frac = amount % unit;
        if (frac == 0) return whole.toString();
        // Pad frac to `decimals` characters then strip trailing zeros.
        bytes memory fracBuf = bytes(frac.toString());
        bytes memory padded = new bytes(decimals);
        uint256 lead = decimals - fracBuf.length;
        for (uint256 i = 0; i < lead; i++) padded[i] = "0";
        for (uint256 i = 0; i < fracBuf.length; i++) padded[lead + i] = fracBuf[i];
        // Trim trailing zeros.
        uint256 end = decimals;
        while (end > 1 && padded[end - 1] == "0") end -= 1;
        bytes memory trimmed = new bytes(end);
        for (uint256 i = 0; i < end; i++) trimmed[i] = padded[i];
        return string(abi.encodePacked(whole.toString(), ".", trimmed));
    }

    /// @dev BPS → percentage string. 500 → "5", 575 → "5.75". Uses
    ///      _formatDecimal with 2 decimals (since 1% = 100 BPS).
    function _bpsToPercentString(uint256 bps) internal pure returns (string memory) {
        return _formatDecimal(bps, 2);
    }

    /// @dev #2957 — the claim, stated in the asset its claim row names: an
    ///      ERC-20 amount at that token's own decimals, or an NFT by its token
    ///      (and its quantity for an ERC-1155). Never scaled by a guess from
    ///      the holder's role.
    function _claimText(
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (string memory) {
        if (s.claimableAssetType == LibVaipakam.AssetType.ERC20) {
            return string(abi.encodePacked(
                _formatDecimal(s.claimableAmount, s.claimableDecimals),
                " ",
                s.claimableSymbol
            ));
        }
        return _nftText(s.claimableSymbol, s.claimableAssetType, s.claimableTokenId, s.claimableQuantity);
    }

    /// @dev An NFT named by its collection and token: "NAME #id", or
    ///      "qty x NAME #id" for an ERC-1155.
    function _nftText(
        string memory name,
        LibVaipakam.AssetType kind,
        uint256 tokenId,
        uint256 quantity
    ) internal pure returns (string memory) {
        string memory token = string(abi.encodePacked(name, " #", tokenId.toString()));
        if (kind == LibVaipakam.AssetType.ERC1155) {
            return string(abi.encodePacked(quantity.toString(), " x ", token));
        }
        return token;
    }

    /// @dev A rental lends an NFT; a loan lends an ERC-20 (#2949).
    function _isRental(
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (bool) {
        return s.principalAssetType != LibVaipakam.AssetType.ERC20;
    }

    /// @dev LoanStatus enum → human string. Mirrors the on-chain
    ///      `LibVaipakam.LoanStatus` ordering.
    function _loanStatusToString(LibVaipakam.LoanStatus status)
        internal
        pure
        returns (string memory)
    {
        if (status == LibVaipakam.LoanStatus.Active) return "Active";
        if (status == LibVaipakam.LoanStatus.Repaid) return "Repaid";
        if (status == LibVaipakam.LoanStatus.Defaulted) return "Defaulted";
        if (status == LibVaipakam.LoanStatus.Settled) return "Settled";
        if (status == LibVaipakam.LoanStatus.FallbackPending) return "Fallback Pending";
        return "Unknown";
    }

    /// @dev Builds the optional OpenSea `external_url` JSON fragment
    ///      (`,"external_url":"…"`) for tokenURI. Returns an empty
    ///      string when no base URL is configured so the JSON stays
    ///      lean. Encodes a deep-link query so marketplace clicks
    ///      land on the right dashboard view:
    ///        - With a loan: `?loan=<id>&side=lender|borrower`
    ///        - Offer-only:  `?token=<tokenId>`
    function _externalUrlField(
        string memory base,
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (string memory) {
        if (bytes(base).length == 0) return "";
        string memory query;
        if (s.loanId != 0) {
            query = string(abi.encodePacked(
                "?loan=", s.loanId.toString(),
                "&side=", s.isLender ? "lender" : "borrower"
            ));
        } else {
            query = string(abi.encodePacked("?token=", s.tokenId.toString()));
        }
        return string(abi.encodePacked(',"external_url":"', base, query, '"'));
    }

    /// @dev OpenSea `background_color` for the position card — six-char
    ///      lowercase hex (no `#` prefix per the spec). Pinned per
    ///      side + terminal so a marketplace grid view differentiates
    ///      lender / borrower / defaulted at a glance:
    ///        - Lender (active):   forest green   (2f855a)
    ///        - Borrower (active): steel blue     (2b6cb0)
    ///        - Defaulted / Liquidated: muted red (c53030)
    ///        - Closed (terminal-fine): slate     (4a5568)
    ///      Status takes precedence over role for terminal cases so a
    ///      defaulted lender position renders red, not green.
    function _backgroundColor(
        MetricsFacet.NFTPositionSummary memory s
    ) internal pure returns (string memory) {
        if (
            s.loanStatus == LibVaipakam.LoanStatus.Defaulted ||
            s.nftStatus == LibVaipakam.LoanPositionStatus.LoanDefaulted ||
            s.nftStatus == LibVaipakam.LoanPositionStatus.LoanLiquidated
        ) {
            return "c53030";
        }
        if (
            s.nftStatus == LibVaipakam.LoanPositionStatus.LoanClosed ||
            s.nftStatus == LibVaipakam.LoanPositionStatus.LoanRepaid ||
            s.loanStatus == LibVaipakam.LoanStatus.Repaid ||
            s.loanStatus == LibVaipakam.LoanStatus.Settled
        ) {
            return "4a5568";
        }
        return s.isLender ? "2f855a" : "2b6cb0";
    }

    /// @dev Offer-state vs active-loan vs resolved-loan bucket. Keeps
    ///      third-party renderers from conflating a cancellable offer with
    ///      a live claim-bearing position.
    function _positionKind(
        LibVaipakam.LoanPositionStatus status
    ) internal pure returns (string memory) {
        if (status == LibVaipakam.LoanPositionStatus.OfferCreated) return "Offer";
        if (
            status == LibVaipakam.LoanPositionStatus.LoanInitiated ||
            status == LibVaipakam.LoanPositionStatus.LoanFallbackPending
        ) return "Active Loan";
        if (status == LibVaipakam.LoanPositionStatus.LoanClosed) return "Closed Loan";
        return "Resolved Loan";
    }

    /// @dev True when ownership of this NFT currently confers the right to
    ///      initiate or collect a claim (cancel refund, repayment, default
    ///      collateral, or liquidation proceeds). Fully-closed tokens carry
    ///      no remaining claim.
    function _governsClaimRights(
        LibVaipakam.LoanPositionStatus status
    ) internal pure returns (bool) {
        return status != LibVaipakam.LoanPositionStatus.LoanClosed &&
            status != LibVaipakam.LoanPositionStatus.None;
    }

    function _assetKindToString(
        LibVaipakam.AssetType kind
    ) internal pure returns (string memory) {
        if (kind == LibVaipakam.AssetType.ERC20) return "ERC20";
        if (kind == LibVaipakam.AssetType.ERC721) return "ERC721";
        return "ERC1155";
    }

    // ==================== Collection Metadata (contractURI) ====================

    /**
     * @notice Collection-level metadata URI (contractURI convention).
     * @dev Returns a base64-encoded JSON blob describing the collection
     *      (name, description, image). Marketplaces read this to render
     *      the collection page and fall back to tokenURI for items.
     *      Image defaults to the lender-side default image asset unless
     *      the admin has set a dedicated `contractImageURI`.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function contractURI() external view returns (string memory) {
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        string memory image = bytes(es.contractImageURI).length > 0
            ? es.contractImageURI
            : es.defaultLenderImage;

        string memory json = string(
            abi.encodePacked(
                '{"name":"',
                es.name,
                '","description":"Vaipakam P2P lending and rental position NFTs. Each token represents a live offer or loan on the Vaipakam protocol.",',
                '"image":"',
                image,
                '","external_link":"https://vaipakam.xyz"}'
            )
        );

        return string(
            abi.encodePacked(
                "data:application/json;base64,",
                Base64.encode(bytes(json))
            )
        );
    }

    /**
     * @notice Sets a dedicated collection image (overrides the lender-active default).
     * @dev Admin-only. Passing an empty string clears the override.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function setContractImageURI(string calldata uri)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibERC721._storage().contractImageURI = uri;
    }

    /**
     * @notice Sets the base URL emitted in `tokenURI`'s OpenSea
     *         `external_url` field. Admin-only. Marketplaces render
     *         a "View on Vaipakam" deep-link against this URL,
     *         appending `?loan=<id>&side=<…>` (or `?token=<id>`
     *         when the NFT hasn't been linked to a loan yet).
     *
     *         Pass an empty string to omit `external_url` from the
     *         metadata entirely (the default — leaves the JSON
     *         lean on chains where the dApp isn't deployed).
     *
     *         Per chain: e.g. `https://vaipakam.com` on mainnet,
     *         `https://testnet.vaipakam.com` on testnets, or the
     *         operator's own fork's URL.
     */
    /// @custom:event-category informational/governance
    event ExternalUrlBaseUpdated(string newBase);
    function setExternalUrlBase(string calldata newBase)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibERC721._storage().externalUrlBase = newBase;
        emit ExternalUrlBaseUpdated(newBase);
    }

    /// @dev Render the enum for tokenURI attributes.
    ///      Keep these strings stable — off-chain indexers key on them.
    function _statusToString(
        LibVaipakam.LoanPositionStatus status
    ) internal pure returns (string memory) {
        if (status == LibVaipakam.LoanPositionStatus.OfferCreated) return "Offer Created";
        if (status == LibVaipakam.LoanPositionStatus.LoanInitiated) return "Loan Initiated";
        if (status == LibVaipakam.LoanPositionStatus.LoanRepaid) return "Loan Repaid";
        if (status == LibVaipakam.LoanPositionStatus.LoanDefaulted) return "Loan Defaulted";
        if (status == LibVaipakam.LoanPositionStatus.LoanLiquidated) return "Loan Liquidated";
        if (status == LibVaipakam.LoanPositionStatus.LoanClosed) return "Loan Closed";
        if (status == LibVaipakam.LoanPositionStatus.LoanFallbackPending) return "Loan Fallback Pending";
        return "";
        }
}
