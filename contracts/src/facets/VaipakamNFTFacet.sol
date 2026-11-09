// src/facets/VaipakamNFTFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibPositionNFT, IPositionNFTCore} from "../libraries/LibPositionNFT.sol";
import {LibRevert} from "../libraries/LibRevert.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";

/**
 * @title VaipakamNFTFacet
 * @author Vaipakam Developer Team
 * @notice The Diamond's side of the position NFTs (#3205). WHO holds a
 *         position is recorded by the standalone `PositionNFT` contract, which
 *         no facet can write; this facet mints new positions there, keeps each
 *         position's status, offer, loan and side, retires a closed position's
 *         token, and answers the core's transfer check.
 * @dev    The Diamond is no longer an ERC-721: it carries no `ownerOf`,
 *         `transferFrom` or approval entry. Marketplaces, wallets and the app
 *         read and move positions at the core. The token's metadata
 *         (`tokenURI`, `contractURI`) is drawn by {VaipakamNFTMetadataFacet}
 *         and the royalty by {royaltyInfo} here, both as the core's renderer.
 */
contract VaipakamNFTFacet is DiamondReentrancyGuard, DiamondAccessControl {

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

    /// @notice Emitted when a position's token is retired: the position
    ///         closed, and the token stays with its holder as a receipt.
    /// @param tokenId The retired token.
    /// @custom:event-category state-change/nft-mutation
    event PositionRetired(uint256 indexed tokenId);

    /// @notice Emitted once, when the Diamond records its PositionNFT core.
    /// @custom:event-category informational/governance
    event PositionNFTSet(address indexed core);

    // Custom errors for clarity and gas efficiency.
    error NotAuthorized();
    error PositionNFTNotForThisDiamond(address core, address itsDiamond);

    /**
     * @notice Record the PositionNFT core and seed the default artwork. Once,
     *         at deploy.
     * @dev    The core must name THIS Diamond as its minter, so a core built
     *         for another Diamond cannot be wired by mistake. The collection's
     *         name and symbol are the core's constructor constants.
     *         Image URIs: only the two per-side defaults seed here; granular
     *         per-(status, isLender) overrides are set afterwards via
     *         `setImageURIForStatus` (or `ConfigureNFTImageURIs.s.sol`). The
     *         default IPFS URL is a placeholder operators swap before mainnet.
     * @param core The PositionNFT contract.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function initializeNFT(address core) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        address itsDiamond = IPositionNFTCore(core).diamond();
        if (itsDiamond != address(this)) revert PositionNFTNotForThisDiamond(core, itsDiamond);
        LibPositionNFT.setCore(core);
        LibPositionNFT.ERC721Storage storage es = LibPositionNFT._storage();
        string memory defaultIpfs =
            "https://ipfs.io/ipfs/QmahNt61bcS6dySxy2qszmXC3AsRMoUxapttrj4WLHNc7k";
        es.defaultLenderImage = defaultIpfs;
        es.defaultBorrowerImage = defaultIpfs;
        es.initialized = true;
        emit PositionNFTSet(core);
    }

    /// @notice The PositionNFT core (0 before {initializeNFT}).
    function positionNFT() external view returns (address) {
        return LibPositionNFT._storage().core;
    }

    /// @notice #2529 — the highest position-NFT id ever allocated (0 before
    ///         the first). Ids run from 1 and are never reused.
    /// @dev    Every allocation site (offer creation, loan acceptance, and the
    ///         lender and borrower position handovers in {LibLoan}) mints the
    ///         id it takes in the same transaction or reverts, so every id from
    ///         1 to this value was minted once. An id in that range that
    ///         {isPositionRetired} reports was retired (its position closed);
    ///         an id above it was never minted.
    function highestTokenId() external view returns (uint256) {
        return LibVaipakam.storageSlot().nextTokenId;
    }

    /// @notice Whether `tokenId`'s position closed and its token was retired.
    function isPositionRetired(uint256 tokenId) external view returns (bool) {
        return LibPositionNFT.isRetired(tokenId);
    }

    /// @notice The protocol route open on `tokenId` (an offset, a sale, a
    ///         collateral listing, a swap-to-repay intent), or None. A route
    ///         does not stop the token moving; moving it makes the route's
    ///         completion revert, and the route can then only be cancelled.
    function positionRoute(uint256 tokenId) external view returns (LibPositionNFT.RouteReason) {
        return LibPositionNFT.routeOf(tokenId);
    }

    /// @notice #3336 — whether the `reason` route bound to `tokenId` is dead:
    ///         it is no longer the open route, or the position moved since it
    ///         opened. The rule every permissionless teardown of a moved
    ///         position applies ({LibPositionNFT.routeIsDead}), served so a
    ///         keeper finds those flows without a simulation per flow; the
    ///         teardown still decides.
    function isPositionRouteDead(uint256 tokenId, LibPositionNFT.RouteReason reason) external view returns (bool) {
        return LibPositionNFT.routeIsDead(tokenId, reason);
    }

    // ==================== The core's transfer check ====================

    /**
     * @notice The PositionNFT core's transfer check: called by the core on
     *         every transfer (never on a mint), after it recorded the move. A
     *         revert refuses the transfer; nothing here can move a token.
     * @dev    Two rules, the ones the in-Diamond transfer applied before
     *         #3205:
     *         - #821 / #1123 FREEZE-AT-SOURCE: no position moves into or out of
     *           a sanctions-flagged wallet (fail-closed through the
     *           confirmed-flagged registry, so not `view`).
     *         - #2342: a terminal loan's fee-tier exclusion is re-derived for
     *           the new holder. This is the one-way transfer ping the owner
     *           allowed (2026-11-07) where a time-accrued record must follow
     *           the holder.
     *         Guarded: a position transfer made while any Diamond call is in
     *         progress (a receiver hook re-entering) reverts, as the guarded
     *         in-Diamond transfer did. The core calls this BEFORE a safe
     *         transfer's receiver hook, with the new owner already recorded;
     *         by the time the hook runs this guard is released, so the hook
     *         may call the Diamond, but the move it reacts to is final.
     */
    function checkPositionTransfer(address, address from, address to, uint256 tokenId) external nonReentrant {
        if (msg.sender != LibPositionNFT._storage().core) revert NotAuthorized();
        LibVaipakam.assertPositionMoveNotSanctioned(from, to);
        _syncTierExclusion(LibPositionNFT._storage().loanIds[tokenId]);
    }

    /**
     * @dev #2342 — a position changing hands on a TERMINAL loan changes who
     *      its owed VPFI belongs to, so re-derive the loan's fee-tier
     *      exclusion (`EncumbranceMutateFacet.syncTierExclusion`): selling the
     *      claim moves the VPFI out of the stored party's tier, selling it
     *      back to the stored party returns it. Run after the move (and after
     *      a safe transfer's receiver hook, which cannot re-enter this
     *      guarded facet). Also called from {retirePosition}, where the holder
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

    // ==================== Vaipakam NFT Logic ====================

    /**
     * @notice Mints a new position NFT at the core for an offer or loan
     *         participant, and records what the position is.
     * @dev Callable only by authorized facets (e.g., OfferFacet via Diamond).
     *      A token minted to a holder under the core's holder lock (protected
     *      account mode) is locked from the start.
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
        LibPositionNFT.ERC721Storage storage es = LibPositionNFT._storage();
        es.nftStatuses[tokenId] = initialStatus;
        es.offerIds[tokenId] = offerId;
        es.loanIds[tokenId] = loanId;
        es.isLenderRoles[tokenId] = isLender;
        LibPositionNFT.mint(to, tokenId);

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
        LibPositionNFT.ERC721Storage storage es = LibPositionNFT._storage();
        es.nftStatuses[tokenId] = newStatus;
        es.loanIds[tokenId] = loanId;

        emit NFTStatusUpdated(tokenId, newStatus);
    }

    /**
     * @notice Retire a position's token after the position closed (its final
     *         claim, a cancelled offer, a position handed to a new token).
     * @dev    Callable only by authorized facets. The core never burns: the
     *         token stays with its holder as a receipt, and every Diamond
     *         holder read treats it as gone ({LibPositionNFT.ownerOf} reverts,
     *         {LibPositionNFT.holderOrZero} reads 0), exactly as a burned token
     *         read before #3205. Its offer, loan and side are kept so the
     *         receipt still renders; a status naming a live position becomes
     *         LoanClosed, and the position summary shows no live figures for
     *         it. Idempotent.
     */
    function retirePosition(uint256 tokenId) external {
        _enforceAuthorizedCaller();
        _retire(tokenId);
    }

    /**
     * @notice Retire the own position token of each of the two offers that is
     *         now terminal (accepted, fully filled or dust-closed), and drop
     *         its open-offer entry. Callable only by authorized facets: the
     *         matcher calls it once per match, after its post-match accounting.
     * @dev    #3205 — one position token per loan side, never shared. A match
     *         slice never takes an offer's own token (each slice's loan gets
     *         its own creator-side token, minted in `LoanFacet`), so an
     *         offer's own token belongs to the offer alone and closes with it.
     *         An offer still open, or with no token, is left alone. Idempotent.
     */
    function retireTerminalOfferTokens(uint256 offerIdA, uint256 offerIdB) external {
        _enforceAuthorizedCaller();
        _retireIfTerminal(offerIdA);
        _retireIfTerminal(offerIdB);
    }

    function _retireIfTerminal(uint256 offerId) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage o = s.offers[offerId];
        uint256 tokenId = o.positionTokenId;
        if (!o.accepted || tokenId == 0 || LibPositionNFT.isRetired(tokenId)) return;
        delete s.offerIdByPositionTokenId[tokenId];
        _retire(tokenId);
    }

    function _retire(uint256 tokenId) private {
        LibPositionNFT.ERC721Storage storage es = LibPositionNFT._storage();
        if (es.retired[tokenId]) return;
        // Only a minted token is retired: an id retired before its mint would
        // be born closed.
        if (LibPositionNFT.core().holderOf(tokenId) == address(0)) {
            revert LibPositionNFT.ERC721NonexistentToken(tokenId);
        }

        // #569 — LIEN LIFECYCLE = BORROWER-POSITION-NFT LIFECYCLE.
        // The collateral lien is created when the borrower position NFT is
        // minted (loan-init) and must not outlive it. Releasing here is the
        // single STRUCTURAL backstop guaranteeing a lien can never survive
        // its borrower NFT — the whole class of "a terminal released the
        // lien early / a return-leg forgot to release" bugs (Codex #572
        // r4–6) cannot survive it. Gated on a TERMINAL loan status so it
        // fires only on a genuine CLOSE-retire, NOT on an obligation-transfer
        // re-key (which retires the OLD borrower token while the loan stays
        // Active and the lien is being re-keyed to the NEW borrower —
        // status gate is order-independent vs the re-key's token swap).
        // Idempotent + ERC20-only: a no-op on already-released liens,
        // lender positions, offer NFTs (loanId 0), Active/FallbackPending
        // loans, and NFT-rental loans (never liened, D-1).
        uint256 retiredLoanId = es.loanIds[tokenId];
        if (retiredLoanId != 0 && !es.isLenderRoles[tokenId]) {
            LibVaipakam.LoanStatus st = LibVaipakam
                .storageSlot()
                .loans[retiredLoanId]
                .status;
            if (
                st != LibVaipakam.LoanStatus.Active &&
                st != LibVaipakam.LoanStatus.FallbackPending
            ) {
                LibEncumbrance.releaseCollateralLien(retiredLoanId);
            }
        }

        LibPositionNFT.retire(tokenId);
        // The receipt must not read as a live position on a marketplace: a
        // status that still names an open offer or loan becomes LoanClosed
        // (no claim rights). A terminal status (repaid, defaulted, liquidated)
        // is kept, so the receipt still says how the position ended.
        LibVaipakam.LoanPositionStatus st = es.nftStatuses[tokenId];
        if (
            st == LibVaipakam.LoanPositionStatus.OfferCreated
                || st == LibVaipakam.LoanPositionStatus.LoanInitiated
                || st == LibVaipakam.LoanPositionStatus.LoanFallbackPending
        ) {
            es.nftStatuses[tokenId] = LibVaipakam.LoanPositionStatus.LoanClosed;
            emit NFTStatusUpdated(tokenId, LibVaipakam.LoanPositionStatus.LoanClosed);
        }

        // #2342 — the side's holder is now nobody, so nothing on it can stay
        // excluded. Normally a no-op (the claim released the records first);
        // it clears the charge if anything was left.
        _syncTierExclusion(retiredLoanId);

        emit PositionRetired(tokenId);
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
        LibPositionNFT.ERC721Storage storage es = LibPositionNFT._storage();
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
        LibPositionNFT.ERC721Storage storage es = LibPositionNFT._storage();
        es.royaltyReceiver = receiver;
        es.royaltyBps = royaltyBps;
        emit RoyaltyUpdated(receiver, royaltyBps);
    }

    /// @notice Raw enum accessor (preferred programmatic API).
    function nftStatusOf(
        uint256 tokenId
    ) external view returns (LibVaipakam.LoanPositionStatus) {
        return LibPositionNFT._storage().nftStatuses[tokenId];
    }

    // Internal helpers

    /// @dev Enforces that the caller is an authorized facet (via Diamond proxy).
    function _enforceAuthorizedCaller() internal view {
        if (msg.sender != address(this)) {
            revert NotAuthorized();
        }
    }
}
