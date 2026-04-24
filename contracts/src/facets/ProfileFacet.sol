// src/facets/ProfileFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title ProfileFacet
 * @author Vaipakam Developer Team
 * @notice This facet handles user profile management, including country setting for sanctions compliance and tiered KYC verification in the Vaipakam platform.
 * @dev Part of the Diamond Standard (EIP-2535). Uses shared LibVaipakam storage for userCountry, kycVerified, and kycTier mappings.
 *      Users can set their country (self-reported ISO code). KYC tier is set by Diamond owner (admin/multi-sig) after off-chain verification.
 *      Tiered KYC per README Section 16:
 *        Tier0 — No KYC required (<$1,000 USD)
 *        Tier1 — Limited KYC required ($1,000–$9,999 USD)
 *        Tier2 — Full KYC/AML required ($10,000+ USD)
 *      Required for offer filtering (sanctions) and KYC checks at various transaction thresholds.
 *      Custom errors, events. No reentrancy as no asset transfers. Pausable for emergencies.
 *      View functions for queries. The legacy kycVerified flag is kept in sync with tier for backward compatibility.
 *      Best practices: Nat-spec comments, access control, gas-optimized (minimal storage).
 */
contract ProfileFacet is DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    /// @notice Emitted when a user sets their country.
    /// @param user The user's address.
    /// @param country The ISO country code set.
    event UserCountrySet(address indexed user, string country);

    /// @notice Emitted when a user's KYC status is updated (legacy boolean flag).
    /// @param user The user's address.
    /// @param verified The new KYC verification status.
    event KYCStatusUpdated(address indexed user, bool verified);

    /// @notice Emitted when a user's KYC tier is updated.
    /// @param user The user's address.
    /// @param tier The new KYC tier level.
    event KYCTierUpdated(address indexed user, LibVaipakam.KYCTier tier);

    /// @notice Emitted when trade allowance between two countries is updated.
    /// @param countryA ISO code for country A.
    /// @param countryB ISO code for country B.
    /// @param allowed Whether trade is permitted between the two countries.
    event TradeAllowanceSet(string countryA, string countryB, bool allowed);

    /// @notice Emitted when KYC thresholds are updated.
    /// @param tier0ThresholdUSD New Tier0 ceiling (USD, 1e18-scaled).
    /// @param tier1ThresholdUSD New Tier1 ceiling (USD, 1e18-scaled).
    event KYCThresholdsUpdated(uint256 tier0ThresholdUSD, uint256 tier1ThresholdUSD);

    // Facet-specific errors (CrossFacetCallFailed inherited from IVaipakamErrors)
    error InvalidCountry();
    error NotOwner();
    error AlreadyRegistered();
    error InvalidThresholds();
    // Mirrored from OfferFacet for the setOfferKeeperAccess entry point —
    // Solidity scopes errors per-contract, so each facet that needs to
    // revert with these must declare them locally. The 4-byte selectors
    // are identical because the signatures are, so callers decode the
    // revert the same way regardless of which facet raised it.
    error InvalidOffer();
    error OfferAlreadyAccepted();

    /**
     * @notice Sets the user's country for sanctions compliance.
     * @dev Callable by anyone for their own address. Validates non-empty string (ISO code assumed off-chain).
     *      Reverts if paused or already set (to prevent changes; adjustable in Phase 2).
     *      Emits UserCountrySet.
     * @param country The ISO country code (e.g., "US").
     */
    function setUserCountry(string calldata country) external whenNotPaused {
        if (bytes(country).length == 0) revert InvalidCountry();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (bytes(s.userCountry[msg.sender]).length > 0)
            revert AlreadyRegistered();

        s.userCountry[msg.sender] = country;

        emit UserCountrySet(msg.sender, country);
    }

    /**
     * @notice Deprecated. Use updateKYCTier instead, which keeps kycVerified in sync.
     * @dev Kept for backward compatibility of the selector but reverts unconditionally.
     */
    function updateKYCStatus(address, bool) external pure {
        revert("Deprecated: use updateKYCTier");
    }

    // /**
    //  * @notice Sets a user's country.
    //  * @dev View function; returns empty string if not set.
    //  * @param country The user's country.
    //  */
    // function setUserCountry(string memory country) external view {
    //     LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
    //     s.userCountry[msg.sender] = country;
    // }

    /**
     * @notice Gets a user's country.
     * @dev View function; returns empty string if not set.
     * @param user The user's address.
     * @return country The ISO country code.
     */
    function getUserCountry(
        address user
    ) external view returns (string memory country) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.userCountry[user];
    }

    /**
     * @notice Checks if a user is KYC verified.
     * @dev View function. Per README §16 Phase 1 pass-through, returns true
     *      unconditionally while `kycEnforcementEnabled` is false so that
     *      legacy callers never gate behaviour on KYC. The stored flag is
     *      still returned once enforcement is re-enabled in a later phase.
     * @param user The user's address.
     * @return verified True if KYC verified (or if Phase 1 pass-through is active).
     */
    function isKYCVerified(address user) external view returns (bool verified) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.kycEnforcementEnabled) return true;
        return s.kycVerified[user];
    }

    /**
     * @notice Sets trade allowance between two countries.
     * @dev Owner-only (multi-sig). Calls LibVaipakam.setTradeAllowance.
     *      Callable when not paused.
     * @param countryA ISO code for country A.
     * @param countryB ISO code for country B.
     * @param allowed True to allow, false to block.
     */
    function setTradeAllowance(
        string calldata countryA,
        string calldata countryB,
        bool allowed
    ) external whenNotPaused onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.setTradeAllowance(countryA, countryB, allowed);
        emit TradeAllowanceSet(countryA, countryB, allowed);
    }

    /**
     * @notice Updates a user's KYC tier (tiered compliance per README Section 16).
     * @dev Owner-only (admin/multi-sig). Used after off-chain KYC verification.
     *      Also updates the legacy kycVerified flag: Tier1+ sets it to true, Tier0 sets it to false.
     *      Emits KYCTierUpdated and KYCStatusUpdated for backward compatibility.
     * @param user The user's address.
     * @param tier The new KYC tier (Tier0 = no KYC, Tier1 = limited, Tier2 = full).
     */
    function updateKYCTier(
        address user,
        LibVaipakam.KYCTier tier
    ) external whenNotPaused onlyRole(LibAccessControl.KYC_ADMIN_ROLE) {

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.kycTier[user] = tier;
        // Keep legacy flag in sync: any tier above Tier0 counts as "verified"
        bool verified = (tier >= LibVaipakam.KYCTier.Tier1);
        s.kycVerified[user] = verified;

        emit KYCTierUpdated(user, tier);
        emit KYCStatusUpdated(user, verified);
    }

    /**
     * @notice Returns a user's KYC tier level.
     * @param user The user's address.
     * @return tier The KYC tier (Tier0, Tier1, or Tier2).
     */
    function getKYCTier(
        address user
    ) external view returns (LibVaipakam.KYCTier tier) {
        return LibVaipakam.storageSlot().kycTier[user];
    }

    /**
     * @notice Checks whether a user meets the KYC requirement for a given USD transaction value.
     * @dev Implements the three-tier KYC model:
     *        < $1,000 USD  → Tier0 required (always passes)
     *        $1k–$9,999    → Tier1 required
     *        $10,000+      → Tier2 required
     *      USD values are scaled to 1e18 (matching Chainlink price feed precision used elsewhere).
     *      Used by OfferFacet, DefaultedFacet, and RiskFacet for transaction-level compliance.
     * @param user The user's address.
     * @param valueUSD The transaction value in USD scaled to 1e18 (e.g., $2,000 = 2000 * 1e18).
     * @return meetsRequirement True if the user's KYC tier is sufficient for the given value.
     */
    function meetsKYCRequirement(
        address user,
        uint256 valueUSD
    ) external view returns (bool meetsRequirement) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // README §16 Phase 1 pass-through: when enforcement is disabled the
        // KYC check is a no-op so OfferFacet/LibCompliance/RiskFacet callers
        // never block. The tier math below remains intact for the moment
        // governance re-enables enforcement.
        if (!s.kycEnforcementEnabled) return true;

        LibVaipakam.KYCTier tier = s.kycTier[user];
        uint256 tier0Threshold = LibVaipakam.getKycTier0Threshold();
        uint256 tier1Threshold = LibVaipakam.getKycTier1Threshold();

        if (valueUSD < tier0Threshold) {
            // Below Tier0 threshold: no KYC required
            return true;
        } else if (valueUSD < tier1Threshold) {
            // Between Tier0 and Tier1 threshold: Tier1 minimum required
            return tier >= LibVaipakam.KYCTier.Tier1;
        } else {
            // Above Tier1 threshold: Tier2 full KYC required
            return tier >= LibVaipakam.KYCTier.Tier2;
        }
    }

    /**
     * @notice Updates the KYC tier thresholds (USD values scaled to 1e18).
     * @dev Admin-only. Tier0 must be < Tier1. Values of 0 revert to compile-time defaults.
     * @param tier0ThresholdUSD Max USD value for no-KYC tier (e.g., 1000 * 1e18).
     * @param tier1ThresholdUSD Max USD value for limited-KYC tier (e.g., 10000 * 1e18).
     */
    function updateKYCThresholds(
        uint256 tier0ThresholdUSD,
        uint256 tier1ThresholdUSD
    ) external whenNotPaused onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (tier0ThresholdUSD >= tier1ThresholdUSD) revert InvalidThresholds();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.kycTier0ThresholdUSD = tier0ThresholdUSD;
        s.kycTier1ThresholdUSD = tier1ThresholdUSD;

        emit KYCThresholdsUpdated(tier0ThresholdUSD, tier1ThresholdUSD);
    }

    /**
     * @notice Returns the current KYC tier thresholds.
     * @return tier0 The Tier0 threshold in USD (scaled 1e18).
     * @return tier1 The Tier1 threshold in USD (scaled 1e18).
     */
    function getKYCThresholds() external view returns (uint256 tier0, uint256 tier1) {
        tier0 = LibVaipakam.getKycTier0Threshold();
        tier1 = LibVaipakam.getKycTier1Threshold();
    }

    // ─── Keeper / Third-Party Execution Preference ───────────────────────

    /// @notice Emitted when a user updates their keeper/third-party execution preference.
    /// @param user The user's address.
    /// @param enabled Whether keeper access is enabled (opt-in) or disabled (default).
    event KeeperAccessUpdated(address indexed user, bool enabled);

    /**
     * @notice Sets the caller's default keeper/third-party execution preference.
     * @dev Per README §3: non-liquidation third-party execution is off by default.
     *      Users must explicitly opt-in. This preference is auditable at the user level.
     *      The preference is also propagated to offers and loans at creation time.
     * @param enabled True to opt-in to keeper/third-party execution, false to disable.
     */
    function setKeeperAccess(bool enabled) external whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.keeperAccessEnabled[msg.sender] = enabled;
        emit KeeperAccessUpdated(msg.sender, enabled);
    }

    /**
     * @notice Returns whether a user has opted in to keeper/third-party execution.
     * @param user The user's address.
     * @return enabled True if keeper access is enabled.
     */
    function getKeeperAccess(address user) external view returns (bool enabled) {
        return LibVaipakam.storageSlot().keeperAccessEnabled[user];
    }

    /// @notice Emitted when a party toggles the per-loan keeper flag for their own side.
    /// @param loanId The loan whose flag was updated.
    /// @param side True if the lender side toggled, false if the borrower side.
    /// @param enabled New flag value.
    event LoanKeeperAccessUpdated(uint256 indexed loanId, bool side, bool enabled);

    /**
     * @notice Toggles the caller's per-side keeper flag on an existing loan.
     * @dev Post-initiation control over per-loan keeper execution. Authority
     *      follows the current Vaipakam position NFT owner (README §3 lines
     *      190–191: "Ownership-sensitive logic for Vaipakam position
     *      authority should rely on the current `ownerOf(tokenId)` result
     *      for the relevant lender-side or borrower-side Vaipakam NFT"),
     *      not the latched `loan.lender` / `loan.borrower` — so if the
     *      position NFT has been transferred, the new holder controls the
     *      flag, matching the keeper-authority model enforced at the call
     *      sites (`requireLenderNFTOwnerOrKeeper` /
     *      `requireBorrowerNFTOwnerOrKeeper`).
     *      Each side controls its own flag — the lender-NFT owner toggles
     *      `lenderKeeperAccessEnabled`, the borrower-NFT owner toggles
     *      `borrowerKeeperAccessEnabled`. The counterparty's flag is never
     *      touched. Keeper execution still additionally requires the
     *      holder's profile opt-in (`setKeeperAccess`) and the keeper being
     *      on the holder's whitelist (`approveKeeper`).
     * @param loanId The loan to update.
     * @param enabled True to permit keepers on the caller's side, false to
     *        disable.
     */
    function setLoanKeeperAccess(uint256 loanId, bool enabled) external whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        IERC721 positionNFT = IERC721(address(this));
        // Resolve authority against the current NFT holders so a mid-flow
        // position transfer correctly carries the toggle right with the NFT.
        // ownerOf reverts for a burnt / unminted token — catch so a burnt
        // counterparty NFT doesn't revert a caller that owns the other side.
        address lenderHolder;
        try positionNFT.ownerOf(loan.lenderTokenId) returns (address h) { lenderHolder = h; } catch {}
        address borrowerHolder;
        try positionNFT.ownerOf(loan.borrowerTokenId) returns (address h) { borrowerHolder = h; } catch {}

        bool side;
        if (lenderHolder != address(0) && msg.sender == lenderHolder) {
            loan.lenderKeeperAccessEnabled = enabled;
            side = true;
        } else if (borrowerHolder != address(0) && msg.sender == borrowerHolder) {
            loan.borrowerKeeperAccessEnabled = enabled;
            side = false;
        } else {
            revert NotNFTOwner();
        }
        emit LoanKeeperAccessUpdated(loanId, side, enabled);
    }

    /// @notice Emitted when an offer creator toggles the per-offer keeper flag.
    /// @param offerId The offer whose flag was updated.
    /// @param enabled New flag value.
    event OfferKeeperAccessUpdated(uint256 indexed offerId, bool enabled);

    /**
     * @notice Toggles the keeper-access flag on an offer the caller created.
     * @dev Symmetric to {setLoanKeeperAccess} for the pre-acceptance
     *      phase. `keeperAccessEnabled` can already be set at creation via
     *      {OfferFacet.createOffer}, but creators have had no way to adjust
     *      it after posting — forcing a cancel + re-post to change their
     *      mind. This entry point closes that gap so keeper delegation can
     *      be enabled or disabled freely while the offer is still open.
     *
     *      Authority: the current offer `creator` only. An offer that has
     *      already been accepted reverts with {OfferAlreadyAccepted} — the
     *      loan now governs keeper authority via {setLoanKeeperAccess}.
     *      An offer with no `creator` set (never-created / storage-empty
     *      slot) reverts with {InvalidOffer}.
     *
     * @param offerId The offer to update.
     * @param enabled True to permit keepers on this offer, false to disable.
     */
    function setOfferKeeperAccess(uint256 offerId, bool enabled) external whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.creator == address(0)) revert InvalidOffer();
        if (offer.accepted) revert OfferAlreadyAccepted();
        if (msg.sender != offer.creator) revert NotNFTOwner();
        offer.keeperAccessEnabled = enabled;
        emit OfferKeeperAccessUpdated(offerId, enabled);
    }

    // ─── Keeper Whitelist (README §3/§9) ──────────────────────────────────
    //
    // Each user maintains a small whitelist of keeper addresses they trust
    // to drive non-liquidation third-party execution on their loans. Per
    // README §3 lines 176–179, keeper authority is role-scoped: a keeper
    // authorizes only the entitled side's actions on a given loan — a
    // lender's whitelist covers lender-entitled keeper actions (e.g.
    // completeLoanSale), and a borrower's whitelist covers borrower-
    // entitled keeper actions (e.g. completeOffset). The two sides do
    // not need to approve each other. The list is capped at
    // `MAX_APPROVED_KEEPERS` per user to bound gas on list reads and
    // keep the whitelist intentionally curated.

    /// @notice Emitted when `user` adds `keeper` to their whitelist.
    /// @param user The whitelist owner (lender or borrower).
    /// @param keeper The address granted keeper authority for `user`'s side
    ///        of any loan they participate in.
    event KeeperApproved(address indexed user, address indexed keeper);

    /// @notice Emitted when `user` removes `keeper` from their whitelist.
    /// @param user The whitelist owner.
    /// @param keeper The keeper that lost authority.
    event KeeperRevoked(address indexed user, address indexed keeper);

    /**
     * @notice Adds `keeper` to the caller's whitelist of approved keepers.
     * @dev Reverts InvalidAddress if `keeper` is zero, KeeperAlreadyApproved
     *      if already on the list, or KeeperWhitelistFull when the list is
     *      at `LibVaipakam.MAX_APPROVED_KEEPERS`. Adding a keeper only
     *      authorizes the caller's side of any loan (README §3); the
     *      counterparty's whitelist is independent.
     * @param keeper The keeper address to whitelist (non-zero).
     */
    function approveKeeper(address keeper) external whenNotPaused {
        if (keeper == address(0)) revert InvalidAddress();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.approvedKeepers[msg.sender][keeper]) revert KeeperAlreadyApproved();
        if (s.approvedKeepersList[msg.sender].length >= LibVaipakam.MAX_APPROVED_KEEPERS)
            revert KeeperWhitelistFull();
        s.approvedKeepers[msg.sender][keeper] = true;
        s.approvedKeepersList[msg.sender].push(keeper);
        emit KeeperApproved(msg.sender, keeper);
    }

    /**
     * @notice Removes `keeper` from the caller's whitelist.
     * @dev Reverts KeeperNotApproved if `keeper` isn't currently on the list.
     *      Uses swap-and-pop so removal is O(list length) but avoids leaving
     *      gaps. In-flight keeper-driven calls may still see the old flag
     *      for the current block; re-check the flag inside LibAuth on every
     *      call (already enforced).
     * @param keeper The keeper address to remove.
     */
    function revokeKeeper(address keeper) external whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.approvedKeepers[msg.sender][keeper]) revert KeeperNotApproved();
        s.approvedKeepers[msg.sender][keeper] = false;
        address[] storage list = s.approvedKeepersList[msg.sender];
        uint256 len = list.length;
        for (uint256 i; i < len; ) {
            if (list[i] == keeper) {
                list[i] = list[len - 1];
                list.pop();
                break;
            }
            unchecked { ++i; }
        }
        emit KeeperRevoked(msg.sender, keeper);
    }

    /**
     * @notice Returns whether `keeper` is on `user`'s whitelist.
     * @param user The whitelist owner.
     * @param keeper The keeper address to check.
     * @return True iff `keeper` is currently approved for `user`.
     */
    function isApprovedKeeper(address user, address keeper) external view returns (bool) {
        return LibVaipakam.storageSlot().approvedKeepers[user][keeper];
    }

    /**
     * @notice Returns the full list of `user`'s approved keepers.
     * @dev Bounded by `LibVaipakam.MAX_APPROVED_KEEPERS`, so the return
     *      array is always small enough to consume in a single call.
     * @param user The whitelist owner.
     * @return The array of whitelisted keeper addresses (possibly empty).
     */
    function getApprovedKeepers(address user) external view returns (address[] memory) {
        return LibVaipakam.storageSlot().approvedKeepersList[user];
    }
}
