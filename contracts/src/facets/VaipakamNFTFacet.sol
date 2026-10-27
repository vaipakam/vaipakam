// src/facets/VaipakamNFTFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibRevert} from "../libraries/LibRevert.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Enumerable.sol";


/**
 * @title VaipakamNFTFacet
 * @author Vaipakam Developer Team
 * @notice This facet handles minting, updating, and burning of Vaipakam NFTs representing offers and loans.
 * @dev Uses LibERC721 (diamond-safe namespaced storage) instead of inheriting OZ ERC721, which would
 *      cause storage slot collisions in a diamond proxy. All ERC721 state (owners, balances, approvals,
 *      name, symbol) and NFT metadata (statuses, IPFS URIs) live in LibERC721.ERC721Storage at a fixed
 *      storage position. Must be initialized via initializeNFT() during diamond deployment.
 *      The token's public metadata (`tokenURI`, `contractURI` and the image and
 *      `external_url` configuration) is on {VaipakamNFTMetadataFacet} (#2957).
 */
contract VaipakamNFTFacet is IERC721, IERC721Enumerable, DiamondReentrancyGuard, DiamondAccessControl {

    /// @notice Emitted when a Vaipakam NFT is minted.
    /// @param tokenId The unique ID of the minted NFT.
    /// @param owner The address receiving the NFT.
    /// @param role The role associated (Lender or Borrower).
    /// @custom:event-category state-change/nft-mutation
    event NFTMinted(
        uint256 indexed tokenId,
        address indexed owner,
        string role
    );

    /// @notice Emitted when an NFT's status is updated.
    /// @param tokenId The ID of the updated NFT.
    /// @param newStatus The new status (enum value).
    /// @custom:event-category state-change/nft-mutation
    event NFTStatusUpdated(
        uint256 indexed tokenId,
        LibVaipakam.LoanPositionStatus newStatus
    );

    /// @notice Emitted when an NFT is burned.
    /// @param tokenId The ID of the burned NFT.
    /// @custom:event-category state-change/nft-mutation
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
    // forge-lint: disable-next-line(mixed-case-function)
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
        //
        // Image URIs: only the two per-side defaults seed at init;
        // granular per-(status, isLender) overrides are populated
        // afterwards via `setImageURIForStatus` (or via
        // `ConfigureNFTImageURIs.s.sol` post-deploy). Default IPFS
        // URL here is a placeholder — operators MUST swap it via the
        // setter before mainnet launch.
        string memory defaultIpfs =
            "https://ipfs.io/ipfs/QmahNt61bcS6dySxy2qszmXC3AsRMoUxapttrj4WLHNc7k";
        LibERC721.initialize("Vaipakam NFT", "VAIPAK", defaultIpfs, defaultIpfs);
        // The ERC-165 claims (ERC-721 family, EIP-2981 and the rest of the
        // Diamond's) are recorded by `DiamondInterfacesInit`, the one list
        // (#2752), not here.
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

    // ERC-721 metadata (IERC721Metadata): `name` and `symbol` live here;
    // `tokenURI` is on {VaipakamNFTMetadataFacet} (#2957). The Diamond as a
    // whole implements the interface, and supportsInterface says so.
    function name() external view returns (string memory) {
        return LibERC721.name();
    }

    function symbol() external view returns (string memory) {
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

    // Slither's `arbitrary-send-erc20` heuristic flags any `transferFrom`
    // with non-msg.sender `from`. This IS the ERC-721 `transferFrom`
    // function from the standard interface — by definition the spender
    // moves the owner's token via approval (`approve` / `setApprovalFor
    // All`). `LibERC721.transferFrom` enforces the standard ERC-721
    // permission check (msg.sender == from || isApprovedForAll[from]
    // [msg.sender] || getApproved[tokenId] == msg.sender) before any
    // state write. Not a vuln — standard ERC-721 semantic.
    // slither-disable-next-line arbitrary-send-erc20
    function transferFrom(address from, address to, uint256 tokenId) external override nonReentrant {
        _assertTransferNotSanctioned(from, to);
        LibERC721.transferFrom(from, to, tokenId);
        _syncTierExclusion(LibERC721._storage().loanIds[tokenId]);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external override nonReentrant {
        _assertTransferNotSanctioned(from, to);
        LibERC721.safeTransferFrom(from, to, tokenId, "");
        _syncTierExclusion(LibERC721._storage().loanIds[tokenId]);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external override nonReentrant {
        _assertTransferNotSanctioned(from, to);
        LibERC721.safeTransferFrom(from, to, tokenId, data);
        _syncTierExclusion(LibERC721._storage().loanIds[tokenId]);
    }

    /**
     * @dev #2342 — a position changing hands on a TERMINAL loan changes who
     *      its owed VPFI belongs to, so re-derive the loan's fee-tier
     *      exclusion (`EncumbranceMutateFacet.syncTierExclusion`): selling the
     *      claim moves the VPFI out of the stored party's tier, selling it
     *      back to the stored party returns it. Run after the move (and after
     *      a safe transfer's receiver hook, which cannot re-enter this
     *      guarded facet). Also called from {burnNFT}, where the holder
     *      becomes nobody. An Active loan has no exclusion (#2342 scope); a
     *      FallbackPending loan's exclusion (#1566 slice 2: its VPFI fallback
     *      custody row) is charged to the stored `loan.borrower` whoever
     *      holds either position, so a transfer cannot change it; and an
     *      offer NFT has no loan. All three skip the call.
     */
    function _syncTierExclusion(uint256 loanId) private {
        if (loanId == 0) return;
        LibVaipakam.LoanStatus st = LibVaipakam.storageSlot().loans[loanId].status;
        if (
            st == LibVaipakam.LoanStatus.Active ||
            st == LibVaipakam.LoanStatus.FallbackPending
        ) return;
        (bool ok, bytes memory ret) = address(this).call(
            abi.encodeWithSelector(LibEncumbrance.TIER_EXCLUSION_SYNC_SELECTOR, loanId)
        );
        LibRevert.bubbleOnFailureTyped(ok, ret, bytes4(0));
    }

    /**
     * @dev #821 (Codex #832) — FREEZE-AT-SOURCE for sanctioned wallets. A user-
     *      initiated position-NFT transfer must not move a position into OR out
     *      of a sanctions-flagged wallet: blocking the SENDER stops a flagged
     *      party laundering its position to a clean wallet to escape the payout
     *      freeze (the laundering vector Codex flagged), and blocking the
     *      RECIPIENT stops a position from being parked on a flagged wallet. This
     *      is the single source-level guard that lets the close-out paths trust
     *      `ownerOf` == the economic owner: a flagged wallet's position is frozen
     *      IN PLACE until the flag clears, while a position transferred BEFORE a
     *      later flag (a legitimate secondary-market buyer) is unaffected.
     *
     *      Scope: ONLY these external user-facing transfer entrypoints. Mint
     *      (`mintNFT`), burn (`burnNFT`), status updates, and protocol-internal
     *      position moves use separate authorized functions / `LibERC721`
     *      directly, so the protocol can still mint to / burn / settle a flagged
     *      party's position at terminal (the Tier-2 close-out must complete).
     *      No-op while the sanctions oracle is unset.
     */
    /// @dev #1123 — FAIL-CLOSED via the confirmed-flagged registry: a wallet
    ///      confirmed sanctioned while the oracle was reachable cannot move a
    ///      position even during an oracle outage. No longer `view` (the gate may
    ///      self-heal-clear a de-listed party on an authoritative clean read).
    function _assertTransferNotSanctioned(address from, address to) private {
        LibVaipakam.assertPositionMoveNotSanctioned(from, to);
    }

    // ==================== Vaipakam NFT Logic ====================

    /**
     * @notice Mints a new Vaipakam NFT for an offer or loan participant.
     * @dev Callable only by authorized facets (e.g., OfferFacet via Diamond).
     */
    // forge-lint: disable-next-line(mixed-case-function)
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
    // forge-lint: disable-next-line(mixed-case-function)
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
    // forge-lint: disable-next-line(mixed-case-function)
    function burnNFT(uint256 tokenId) external {
        _enforceAuthorizedCaller();
        LibERC721.ERC721Storage storage es = LibERC721._storage();

        // #569 — LIEN LIFECYCLE = BORROWER-POSITION-NFT LIFECYCLE.
        // The collateral lien is created when the borrower position NFT is
        // minted (loan-init) and must not outlive it. Releasing here is the
        // single STRUCTURAL backstop guaranteeing a lien can never survive
        // its borrower NFT — the whole class of "a terminal released the
        // lien early / a return-leg forgot to release" bugs (Codex #572
        // r4–6) cannot survive it. Gated on a TERMINAL loan status so it
        // fires only on a genuine CLOSE-burn, NOT on an obligation-transfer
        // re-key (which burns the OLD borrower token while the loan stays
        // Active and the lien is being re-keyed to the NEW borrower —
        // status gate is order-independent vs the re-key's token swap).
        // Idempotent + ERC20-only: a no-op on already-released liens,
        // lender positions, offer NFTs (loanId 0), Active/FallbackPending
        // loans, and NFT-rental loans (never liened, D-1).
        uint256 burnedLoanId = es.loanIds[tokenId];
        if (burnedLoanId != 0 && !es.isLenderRoles[tokenId]) {
            LibVaipakam.LoanStatus st = LibVaipakam
                .storageSlot()
                .loans[burnedLoanId]
                .status;
            if (
                st != LibVaipakam.LoanStatus.Active &&
                st != LibVaipakam.LoanStatus.FallbackPending
            ) {
                LibEncumbrance.releaseCollateralLien(burnedLoanId);
            }
        }

        LibERC721._burn(tokenId);
        delete es.nftStatuses[tokenId];
        delete es.offerIds[tokenId];
        delete es.loanIds[tokenId];
        delete es.isLenderRoles[tokenId];

        // #2342 — the side's holder is now nobody, so nothing on it can stay
        // excluded. Normally a no-op (the claim released the records first);
        // it clears the charge if anything was left.
        _syncTierExclusion(burnedLoanId);

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

    // ==================== EIP-2981 Royalties ====================

    /// @notice Emitted when the collection's default royalty policy is updated.
    /// @custom:event-category informational/governance
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

    // `_isClosedStatus` (previously here) removed in #148 Phase 5 —
    // every call site was refactored to compare the status enum
    // directly. The terminal-state set (Repaid / Defaulted /
    // Liquidated / Closed; FallbackPending is non-terminal because
    // the borrower can still cure) is documented inline at each
    // remaining caller.

}
