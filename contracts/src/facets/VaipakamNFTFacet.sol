// src/facets/VaipakamNFTFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Enumerable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";


/**
 * @title VaipakamNFTFacet
 * @author Vaipakam Developer Team
 * @notice This facet handles minting, updating, and burning of Vaipakam NFTs representing offers and loans.
 * @dev Uses LibERC721 (diamond-safe namespaced storage) instead of inheriting OZ ERC721, which would
 *      cause storage slot collisions in a diamond proxy. All ERC721 state (owners, balances, approvals,
 *      name, symbol) and NFT metadata (statuses, IPFS URIs) live in LibERC721.ERC721Storage at a fixed
 *      storage position. Must be initialized via initializeNFT() during diamond deployment.
 */
contract VaipakamNFTFacet is IERC721, IERC721Metadata, IERC721Enumerable, DiamondReentrancyGuard, DiamondAccessControl {
    using Strings for uint256;
    using Strings for address;

    /// @notice Emitted when a Vaipakam NFT is minted.
    /// @param tokenId The unique ID of the minted NFT.
    /// @param owner The address receiving the NFT.
    /// @param role The role associated (Lender or Borrower).
    event NFTMinted(
        uint256 indexed tokenId,
        address indexed owner,
        string role
    );

    /// @notice Emitted when an NFT's status is updated.
    /// @param tokenId The ID of the updated NFT.
    /// @param newStatus The new status (enum value).
    event NFTStatusUpdated(
        uint256 indexed tokenId,
        LibVaipakam.LoanPositionStatus newStatus
    );

    /// @notice Emitted when an NFT is burned.
    /// @param tokenId The ID of the burned NFT.
    event NFTBurned(uint256 indexed tokenId);

    // Custom errors for clarity and gas efficiency.
    error NotAuthorized();
    error InvalidTokenId();
    error NFTAlreadyBurned();

    /**
     * @notice Initializes ERC721 state in diamond storage.
     * @dev Must be called once during diamond deployment (e.g., in DiamondInit).
     *      Replaces the constructor which cannot initialize diamond proxy storage.
     */
    function initializeNFT() external onlyRole(LibAccessControl.ADMIN_ROLE) {
        // Name + symbol are intentionally one-shot at deploy time —
        // `LibERC721.initialize` reverts on second call. No admin
        // setter exists by design: NFT collection identity is part of
        // the contract's surface that marketplaces, wallets, and
        // indexers cache, and a mutable identity is both an attack
        // surface (compromised admin → rename to scam) and a UX
        // hazard (wallets can't tell if it's still the same collection).
        // Get the values right before the first mainnet deploy; future
        // changes mean redeploy, not in-place mutation.
        LibERC721.initialize(
            "Vaipakam NFT",
            "VAIPAK",
            "https://ipfs.io/ipfs/QmahNt61bcS6dySxy2qszmXC3AsRMoUxapttrj4WLHNc7k",
            "https://ipfs.io/ipfs/QmahNt61bcS6dySxy2qszmXC3AsRMoUxapttrj4WLHNc7k",
            "https://ipfs.io/ipfs/QmahNt61bcS6dySxy2qszmXC3AsRMoUxapttrj4WLHNc7k",
            "https://ipfs.io/ipfs/QmahNt61bcS6dySxy2qszmXC3AsRMoUxapttrj4WLHNc7k"
        );
        _registerNFTInterfaces();
    }

    /**
     * @notice Overrides the four position-NFT image URIs set at initialize-time.
     * @dev Admin-only. Lets governance rotate collection artwork without
     *      re-running `initializeNFT()`.
     */
    function setLoanImageURIs(
        string calldata lenderActive,
        string calldata lenderClosed,
        string calldata borrowerActive,
        string calldata borrowerClosed
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        es.lenderActiveIPFS = lenderActive;
        es.lenderClosedIPFS = lenderClosed;
        es.borrowerActiveIPFS = borrowerActive;
        es.borrowerClosedIPFS = borrowerClosed;
    }

    function _registerNFTInterfaces() internal {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[type(IERC721).interfaceId] = true;
        ds.supportedInterfaces[type(IERC721Metadata).interfaceId] = true;
        ds.supportedInterfaces[type(IERC721Enumerable).interfaceId] = true;
        ds.supportedInterfaces[0x2a55205a] = true; // EIP-2981 royaltyInfo
    }

    // ==================== ERC721 Interface ====================

    /// @dev EIP-2981 `royaltyInfo(uint256,uint256)` selector. Hardcoded because
    ///      this facet doesn't import the IERC2981 interface type.
    bytes4 private constant _INTERFACE_ID_ERC2981 = 0x2a55205a;

    function supportsInterface(bytes4 interfaceId) external pure override(IERC165) returns (bool) {
        return
            interfaceId == type(IERC721).interfaceId ||
            interfaceId == type(IERC721Metadata).interfaceId ||
            interfaceId == type(IERC721Enumerable).interfaceId ||
            interfaceId == type(IERC165).interfaceId ||
            interfaceId == _INTERFACE_ID_ERC2981;
    }

    // ==================== IERC721Enumerable ====================

    /// @inheritdoc IERC721Enumerable
    function totalSupply() external view override returns (uint256) {
        return LibERC721.totalSupply();
    }

    /// @inheritdoc IERC721Enumerable
    function tokenByIndex(uint256 index) external view override returns (uint256) {
        return LibERC721.tokenByIndex(index);
    }

    /// @inheritdoc IERC721Enumerable
    function tokenOfOwnerByIndex(address owner, uint256 index) external view override returns (uint256) {
        return LibERC721.tokenOfOwnerByIndex(owner, index);
    }

    function name() external view override returns (string memory) {
        return LibERC721.name();
    }

    function symbol() external view override returns (string memory) {
        return LibERC721.symbol();
    }

    function balanceOf(address owner) external view override returns (uint256) {
        return LibERC721.balanceOf(owner);
    }

    function ownerOf(uint256 tokenId) public view override returns (address) {
        return LibERC721.ownerOf(tokenId);
    }

    function approve(address to, uint256 tokenId) external override {
        LibERC721.approve(to, tokenId);
    }

    function getApproved(uint256 tokenId) external view override returns (address) {
        return LibERC721.getApproved(tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external override {
        LibERC721.setApprovalForAll(operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view override returns (bool) {
        return LibERC721.isApprovedForAll(owner, operator);
    }

    function transferFrom(address from, address to, uint256 tokenId) external override nonReentrant {
        LibERC721.transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external override nonReentrant {
        LibERC721.safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external override nonReentrant {
        LibERC721.safeTransferFrom(from, to, tokenId, data);
    }

    // ==================== Vaipakam NFT Logic ====================

    /**
     * @notice Mints a new Vaipakam NFT for an offer or loan participant.
     * @dev Callable only by authorized facets (e.g., OfferFacet via Diamond).
     */
    function mintNFT(
        address to,
        uint256 tokenId,
        uint256 offerId,
        uint256 loanId,
        bool isLender,
        LibVaipakam.LoanPositionStatus initialStatus
    ) external {
        _enforceAuthorizedCaller();
        LibERC721._safeMint(to, tokenId);
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        es.nftStatuses[tokenId] = initialStatus;
        es.offerIds[tokenId] = offerId;
        es.loanIds[tokenId] = loanId;
        es.isLenderRoles[tokenId] = isLender;

        emit NFTMinted(tokenId, to, isLender ? "Lender" : "Borrower");
    }

    /**
     * @notice Updates the status of an existing Vaipakam NFT.
     * @dev Callable only by authorized facets.
     */
    function updateNFTStatus(
        uint256 tokenId,
        uint256 loanId,
        LibVaipakam.LoanPositionStatus newStatus
    ) external {
        _enforceAuthorizedCaller();
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        es.nftStatuses[tokenId] = newStatus;
        es.loanIds[tokenId] = loanId;

        emit NFTStatusUpdated(tokenId, newStatus);
    }

    /**
     * @notice Burns a Vaipakam NFT after loan closure or claims.
     * @dev Callable only by authorized facets.
     */
    function burnNFT(uint256 tokenId) external {
        _enforceAuthorizedCaller();
        LibERC721._burn(tokenId);
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        delete es.nftStatuses[tokenId];
        delete es.offerIds[tokenId];
        delete es.loanIds[tokenId];
        delete es.isLenderRoles[tokenId];

        emit NFTBurned(tokenId);
    }

    /**
     * @notice Returns the native transfer-lock reason for `tokenId`.
     * @dev Exposed so UIs can detect that a position NFT is locked mid
     *      strategic flow (Preclose Option 3 offset, EarlyWithdrawal sale)
     *      and surface the lock to users before they attempt to initiate
     *      a conflicting action. A return value of `LockReason.None`
     *      means the token is freely transferable.
     */
    function positionLock(uint256 tokenId) external view returns (LibERC721.LockReason) {
        return LibERC721.lockOf(tokenId);
    }

    /**
     * @notice Returns the URI for a given token ID, dynamically generating JSON metadata.
     * @dev Generates Base64-encoded JSON with on-chain data.
     */
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        ownerOf(tokenId); // Reverts for non-existent tokens

        LibERC721.ERC721Storage storage es = LibERC721._storage();
        uint256 offerId = es.offerIds[tokenId];
        uint256 loanId = es.loanIds[tokenId];
        LibVaipakam.LoanPositionStatus statusEnum = es.nftStatuses[tokenId];
        bool isLender = es.isLenderRoles[tokenId];
        bool isClosed = _isClosedStatus(statusEnum);

        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[offerId];

        string memory image = isLender
            ? (isClosed ? es.lenderClosedIPFS : es.lenderActiveIPFS)
            : (isClosed ? es.borrowerClosedIPFS : es.borrowerActiveIPFS);

        string memory json = string(
            abi.encodePacked(
                '{"name":"Vaipakam NFT #',
                tokenId.toString(),
                '","description":"',
                _buildDescription(tokenId, isLender, statusEnum, offerId, loanId),
                '","image":"',
                image,
                '","attributes":',
                _buildAttributes(isLender, statusEnum, offer, offerId, loanId),
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
    ///      summary alongside traits. Kept explicit about position kind + claim
    ///      governance so third-party sites don't misrepresent a stale offer
    ///      as a live claim-bearing loan position (README §3).
    function _buildDescription(
        uint256 tokenId,
        bool isLender,
        LibVaipakam.LoanPositionStatus statusEnum,
        uint256 offerId,
        uint256 loanId
    ) internal view returns (string memory) {
        return string(
            abi.encodePacked(
                "Vaipakam ",
                isLender ? "Lender" : "Borrower",
                " position NFT #",
                tokenId.toString(),
                ". Kind: ",
                _positionKind(statusEnum),
                ". Status: ",
                _statusToString(statusEnum),
                ". Offer #",
                offerId.toString(),
                loanId == 0 ? "" : string(abi.encodePacked(", Loan #", loanId.toString())),
                ". Claim rights: ",
                _governsClaimRights(statusEnum) ? "Yes" : "No",
                ". Chain ID: ",
                block.chainid.toString(),
                "."
            )
        );
    }

    /// @dev Attribute array. Retains the historical traits (so existing
    ///      indexers don't break) and appends the standardized high-signal
    ///      fields required by README §3: linked offer ID, linked loan ID,
    ///      network context, position kind, claim-rights flag, and asset kind.
    function _buildAttributes(
        bool isLender,
        LibVaipakam.LoanPositionStatus statusEnum,
        LibVaipakam.Offer storage offer,
        uint256 offerId,
        uint256 loanId
    ) internal view returns (string memory) {
        return string(
            abi.encodePacked(
                _attributesCore(isLender, statusEnum, offer),
                _attributesExtended(statusEnum, offer, offerId, loanId)
            )
        );
    }

    function _attributesCore(
        bool isLender,
        LibVaipakam.LoanPositionStatus statusEnum,
        LibVaipakam.Offer storage offer
    ) internal view returns (string memory) {
        return string(
            abi.encodePacked(
                '[{"trait_type":"Role","value":"',
                isLender ? "Lender" : "Borrower",
                '"},{"trait_type":"Status","value":"',
                _statusToString(statusEnum),
                '"},{"trait_type":"Lending Asset","value":"',
                offer.lendingAsset.toHexString(),
                '"},{"trait_type":"Amount","value":"',
                offer.amount.toString(),
                '"},{"trait_type":"Interest Rate (BPS)","value":"',
                offer.interestRateBps.toString(),
                '"},{"trait_type":"Collateral Asset","value":"',
                offer.collateralAsset.toHexString(),
                '"},{"trait_type":"Collateral Amount","value":"',
                offer.collateralAmount.toString(),
                '"},{"trait_type":"Duration (Days)","value":"',
                offer.durationDays.toString(),
                '"},{"trait_type":"Principal Liquidity","value":"',
                uint256(offer.principalLiquidity).toString(),
                '"},{"trait_type":"Collateral Liquidity","value":"',
                uint256(offer.collateralLiquidity).toString(),
                '"},'
            )
        );
    }

    function _attributesExtended(
        LibVaipakam.LoanPositionStatus statusEnum,
        LibVaipakam.Offer storage offer,
        uint256 offerId,
        uint256 loanId
    ) internal view returns (string memory) {
        return string(
            abi.encodePacked(
                '{"trait_type":"Offer ID","value":"',
                offerId.toString(),
                '"},{"trait_type":"Loan ID","value":"',
                loanId.toString(),
                '"},{"trait_type":"Position Kind","value":"',
                _positionKind(statusEnum),
                '"},{"trait_type":"Governs Claim Rights","value":"',
                _governsClaimRights(statusEnum) ? "Yes" : "No",
                '"},{"trait_type":"Asset Kind","value":"',
                _assetKindToString(offer.assetType),
                '"},{"trait_type":"Chain ID","value":"',
                block.chainid.toString(),
                '"}]'
            )
        );
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
     *      Image defaults to the lender-active IPFS asset unless the admin
     *      has set a dedicated `contractImageURI`.
     */
    function contractURI() external view returns (string memory) {
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        string memory image = bytes(es.contractImageURI).length > 0
            ? es.contractImageURI
            : es.lenderActiveIPFS;

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
    function setContractImageURI(string calldata uri)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibERC721._storage().contractImageURI = uri;
    }

    // ==================== EIP-2981 Royalties ====================

    /// @notice Emitted when the collection's default royalty policy is updated.
    event RoyaltyUpdated(address indexed receiver, uint96 royaltyBps);

    error InvalidRoyalty();

    /**
     * @notice EIP-2981 royalty info for secondary sales of Vaipakam NFTs.
     * @dev NFT marketplaces call this (per the EIP-2981 standard) to honour
     *      collection royalties. A single default policy applies to every
     *      tokenId in the collection.
     * @param salePrice The sale price the marketplace is settling.
     * @return receiver Address that should receive the royalty.
     * @return royaltyAmount Absolute royalty amount (salePrice * bps / 10_000).
     */
    function royaltyInfo(uint256 /* tokenId */, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        receiver = es.royaltyReceiver;
        royaltyAmount = receiver == address(0)
            ? 0
            : (salePrice * uint256(es.royaltyBps)) / 10_000;
    }

    /**
     * @notice Updates the collection's default royalty policy.
     * @dev Admin-only. Capped at 10% (1000 bps) to keep secondary markets
     *      listable. Setting `receiver = address(0)` disables royalties.
     */
    function setDefaultRoyalty(address receiver, uint96 royaltyBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (royaltyBps > 1000) revert InvalidRoyalty();
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        es.royaltyReceiver = receiver;
        es.royaltyBps = royaltyBps;
        emit RoyaltyUpdated(receiver, royaltyBps);
    }

    /// @notice Raw enum accessor (preferred programmatic API).
    function nftStatusOf(
        uint256 tokenId
    ) external view returns (LibVaipakam.LoanPositionStatus) {
        return LibERC721._storage().nftStatuses[tokenId];
    }

    // Internal helpers

    /// @dev Enforces that the caller is an authorized facet (via Diamond proxy).
    function _enforceAuthorizedCaller() internal view {
        if (msg.sender != address(this)) {
            revert NotAuthorized();
        }
    }

    /// @dev Checks if a status indicates loan closure (terminal state). Terminal
    ///      states are Repaid, Defaulted, Liquidated, and Closed — FallbackPending
    ///      is explicitly non-terminal because the borrower can still cure.
    function _isClosedStatus(
        LibVaipakam.LoanPositionStatus status
    ) internal pure returns (bool) {
        return
            status == LibVaipakam.LoanPositionStatus.LoanClosed ||
            status == LibVaipakam.LoanPositionStatus.LoanRepaid ||
            status == LibVaipakam.LoanPositionStatus.LoanDefaulted ||
            status == LibVaipakam.LoanPositionStatus.LoanLiquidated;
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
