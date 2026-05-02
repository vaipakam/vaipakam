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
     * @notice Updates the KYC tier thresholds (NUMERAIRE values scaled to 1e18).
     * @dev Admin-only. Tier0 must be < Tier1. Values of 0 revert to
     *      compile-time defaults. USD-Sweep Phase 2 — values are now
     *      stored in numeraire-units; the comparison-site getters
     *      (`getKycTier0Threshold` / `getKycTier1Threshold`) convert
     *      numeraire→USD via the global `numeraireOracle` so callers
     *      stay USD-typed.
     * @param tier0ThresholdNumeraire Max numeraire value for no-KYC tier (default 1000 * 1e18).
     * @param tier1ThresholdNumeraire Max numeraire value for limited-KYC tier (default 10000 * 1e18).
     */
    function updateKYCThresholds(
        uint256 tier0ThresholdNumeraire,
        uint256 tier1ThresholdNumeraire
    ) external whenNotPaused onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (tier0ThresholdNumeraire >= tier1ThresholdNumeraire) revert InvalidThresholds();
        // Setter-range audit (2026-05-02): added absolute floor +
        // ceiling on both tiers. KYC is OFF on the retail deploy
        // (per CLAUDE.md), so these are belt-and-suspenders there;
        // on the industrial fork they cap the tunable to a
        // credible per-tier numeraire window.
        if (
            tier0ThresholdNumeraire < LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR ||
            tier0ThresholdNumeraire > LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "kycTier0ThresholdNumeraire",
                tier0ThresholdNumeraire,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            );
        }
        if (
            tier1ThresholdNumeraire < LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR ||
            tier1ThresholdNumeraire > LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "kycTier1ThresholdNumeraire",
                tier1ThresholdNumeraire,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            );
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.kycTier0ThresholdNumeraire = tier0ThresholdNumeraire;
        s.kycTier1ThresholdNumeraire = tier1ThresholdNumeraire;

        emit KYCThresholdsUpdated(tier0ThresholdNumeraire, tier1ThresholdNumeraire);
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

    /// @notice Emitted when an NFT holder toggles a per-loan keeper enable.
    /// @param loanId The loan whose flag was updated.
    /// @param keeper The specific keeper being enabled or disabled.
    /// @param enabled New flag value.
    event LoanKeeperEnabled(uint256 indexed loanId, address indexed keeper, bool enabled);

    /**
     * @notice Enable or disable a specific `keeper` for `loanId` (Phase 6).
     *
     * @dev Per-loan keeper selection. Authority follows the current
     *      Vaipakam position NFT owner on either side (lender NFT holder
     *      for lender-entitled actions, borrower NFT holder for borrower-
     *      entitled actions). The same `loanKeeperEnabled[loanId][keeper]`
     *      mapping backs both sides — per-side authority at call time is
     *      enforced by the NFT-holder-specific `approvedKeeperActions`
     *      bitmask, which is independent per user.
     *
     *      Callers must own EITHER the lender or borrower NFT for this
     *      loan. Reverts with {NotNFTOwner} otherwise. A burnt counterparty
     *      NFT does not block the live side.
     *
     *      Keeper execution still additionally requires the NFT holder's
     *      master `setKeeperAccess(true)` and the keeper being approved
     *      globally for the relevant action via {approveKeeper}.
     *
     * @param loanId  The loan to update.
     * @param keeper  Keeper address to enable or disable for this loan.
     * @param enabled True to enable, false to disable.
     */
    function setLoanKeeperEnabled(
        uint256 loanId,
        address keeper,
        bool enabled
    ) external whenNotPaused {
        if (keeper == address(0)) revert InvalidAddress();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        IERC721 positionNFT = IERC721(address(this));
        address lenderHolder;
        try positionNFT.ownerOf(loan.lenderTokenId) returns (address h) { lenderHolder = h; } catch {}
        address borrowerHolder;
        try positionNFT.ownerOf(loan.borrowerTokenId) returns (address h) { borrowerHolder = h; } catch {}

        if (
            (lenderHolder == address(0) || msg.sender != lenderHolder) &&
            (borrowerHolder == address(0) || msg.sender != borrowerHolder)
        ) revert NotNFTOwner();

        s.loanKeeperEnabled[loanId][keeper] = enabled;
        emit LoanKeeperEnabled(loanId, keeper, enabled);
    }

    /// @notice Emitted when an offer creator toggles a per-offer keeper enable.
    /// @param offerId The offer whose flag was updated.
    /// @param keeper The specific keeper being enabled or disabled.
    /// @param enabled New flag value.
    event OfferKeeperEnabled(uint256 indexed offerId, address indexed keeper, bool enabled);

    /**
     * @notice Enable or disable a specific `keeper` for `offerId` (Phase 6).
     *
     * @dev Pre-acceptance counterpart to {setLoanKeeperEnabled}. Creator-
     *      only; reverts {InvalidOffer} / {OfferAlreadyAccepted} /
     *      {NotNFTOwner} as applicable. Flags latch into
     *      `loanKeeperEnabled[loanId][keeper]` at {OfferFacet.acceptOffer}
     *      via the creator's approved-keepers list; post-acceptance each
     *      NFT holder edits the loan-level flag via {setLoanKeeperEnabled}.
     *
     * @param offerId The offer to update.
     * @param keeper  Keeper address to enable or disable for this offer.
     * @param enabled True to enable, false to disable.
     */
    function setOfferKeeperEnabled(
        uint256 offerId,
        address keeper,
        bool enabled
    ) external whenNotPaused {
        if (keeper == address(0)) revert InvalidAddress();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.creator == address(0)) revert InvalidOffer();
        if (offer.accepted) revert OfferAlreadyAccepted();
        if (msg.sender != offer.creator) revert NotNFTOwner();
        s.offerKeeperEnabled[offerId][keeper] = enabled;
        emit OfferKeeperEnabled(offerId, keeper, enabled);
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

    /// @notice Emitted when `user` adds `keeper` to their whitelist or
    ///         updates the keeper's authorised action set.
    /// @param user The whitelist owner (lender or borrower side, per user).
    /// @param keeper The keeper address.
    /// @param actions New action bitmask (see `LibVaipakam.KEEPER_ACTION_*`).
    event KeeperActionsUpdated(
        address indexed user,
        address indexed keeper,
        uint8 actions
    );

    /// @notice Emitted when `user` removes `keeper` from their whitelist.
    /// @param user The whitelist owner.
    /// @param keeper The keeper that lost authority.
    event KeeperRevoked(address indexed user, address indexed keeper);

    /**
     * @notice Adds `keeper` to the caller's whitelist with the given
     *         per-action authorisation bitmask (Phase 6).
     *
     * @dev Reverts:
     *      - {InvalidAddress} if `keeper` is zero.
     *      - {InvalidKeeperActions} if `actions == 0` or sets bits outside
     *        `LibVaipakam.KEEPER_ACTION_ALL`.
     *      - {KeeperAlreadyApproved} if `keeper` is already on the list
     *        (use {setKeeperActions} to modify bits for an existing entry).
     *      - {KeeperWhitelistFull} when the list is at
     *        `LibVaipakam.MAX_APPROVED_KEEPERS`.
     *
     *      Adding a keeper only authorises the caller's side of any loan;
     *      the counterparty's whitelist is independent.
     *
     * @param keeper  Keeper address to whitelist (non-zero).
     * @param actions Bitmask of `LibVaipakam.KEEPER_ACTION_*` bits.
     */
    function approveKeeper(address keeper, uint8 actions) external whenNotPaused {
        if (keeper == address(0)) revert InvalidAddress();
        _requireValidKeeperActions(actions);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.approvedKeeperActions[msg.sender][keeper] != 0)
            revert KeeperAlreadyApproved();
        if (s.approvedKeepersList[msg.sender].length >= LibVaipakam.MAX_APPROVED_KEEPERS)
            revert KeeperWhitelistFull();
        s.approvedKeeperActions[msg.sender][keeper] = actions;
        s.approvedKeepersList[msg.sender].push(keeper);
        emit KeeperActionsUpdated(msg.sender, keeper, actions);
    }

    /**
     * @notice Update the action bitmask for an existing whitelisted keeper.
     *
     * @dev Reverts:
     *      - {KeeperNotApproved} if `keeper` is not currently on the list.
     *      - {InvalidKeeperActions} if `actions == 0` (use {revokeKeeper}
     *        to remove the keeper entirely) or sets bits outside
     *        `LibVaipakam.KEEPER_ACTION_ALL`.
     *
     * @param keeper  Keeper to update.
     * @param actions New action bitmask.
     */
    function setKeeperActions(address keeper, uint8 actions) external whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.approvedKeeperActions[msg.sender][keeper] == 0)
            revert KeeperNotApproved();
        _requireValidKeeperActions(actions);
        s.approvedKeeperActions[msg.sender][keeper] = actions;
        emit KeeperActionsUpdated(msg.sender, keeper, actions);
    }

    /**
     * @notice Removes `keeper` from the caller's whitelist (clears their
     *         action bitmask to zero).
     *
     * @dev Reverts {KeeperNotApproved} if `keeper` isn't currently on the
     *      list. Uses swap-and-pop on the enumerated list so removal is
     *      O(list length) but avoids leaving gaps. In-flight keeper-driven
     *      calls may still see the old flag for the current block; re-
     *      checked inside LibAuth on every call.
     *
     * @param keeper The keeper address to remove.
     */
    function revokeKeeper(address keeper) external whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.approvedKeeperActions[msg.sender][keeper] == 0)
            revert KeeperNotApproved();
        s.approvedKeeperActions[msg.sender][keeper] = 0;
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
     * @notice Returns the current action bitmask authorising `keeper` on
     *         behalf of `user`. Zero means not approved.
     * @param user   The whitelist owner.
     * @param keeper The keeper address to check.
     * @return actions Bitmask of `LibVaipakam.KEEPER_ACTION_*` bits.
     */
    function getKeeperActions(address user, address keeper)
        external
        view
        returns (uint8 actions)
    {
        return LibVaipakam.storageSlot().approvedKeeperActions[user][keeper];
    }

    /**
     * @notice Backwards-friendly view: whether `keeper` is approved at
     *         all (any action bit set) on `user`'s whitelist.
     * @param user   The whitelist owner.
     * @param keeper The keeper address to check.
     * @return True iff the keeper has any authorised action.
     */
    function isApprovedKeeper(address user, address keeper) external view returns (bool) {
        return LibVaipakam.storageSlot().approvedKeeperActions[user][keeper] != 0;
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

    /**
     * @notice Returns whether a specific `keeper` is enabled for `loanId`.
     *         Complements {getKeeperActions} — a keeper must be both
     *         globally authorised AND enabled for the specific loan.
     * @param loanId Loan to query.
     * @param keeper Keeper address to check.
     * @return True iff the keeper is enabled for this loan.
     */
    function isLoanKeeperEnabled(uint256 loanId, address keeper)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().loanKeeperEnabled[loanId][keeper];
    }

    /**
     * @notice Returns whether a specific `keeper` is enabled for `offerId`
     *         (pre-acceptance). Latches into loan-level at acceptance.
     * @param offerId Offer to query.
     * @param keeper  Keeper address to check.
     * @return True iff the keeper is enabled for this offer.
     */
    function isOfferKeeperEnabled(uint256 offerId, address keeper)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().offerKeeperEnabled[offerId][keeper];
    }

    /// @dev Require `actions` is non-zero and only sets bits within the
    ///      configured action space. Reverts {InvalidKeeperActions}.
    function _requireValidKeeperActions(uint8 actions) private pure {
        if (actions == 0 || (actions & ~LibVaipakam.KEEPER_ACTION_ALL) != 0)
            revert InvalidKeeperActions();
    }

    // ─── Address-level sanctions (Phase 4.3) ──────────────────────────────
    //
    // Country-level sanctions already live above (setUserCountry +
    // tradeAllowance). Phase 4.3 layers in address-level screening via a
    // Chainalysis-style on-chain oracle. The check is a read-through to
    // the configured oracle contract; on chains where no oracle is
    // deployed (some L2 testnets), governance leaves the oracle address
    // zero and the check becomes a no-op.
    //
    // Integration points: `OfferFacet.createOffer` and
    // `OfferFacet.acceptOffer` — i.e. the "entering a new business
    // relationship" path. Ongoing actions (`repay`, `claim`) are left
    // unrestricted so a counterparty is never stranded if the other
    // side lands on a sanctions list mid-loan.

    /**
     * @notice Reverts when a call from `who` is blocked because the
     *         Chainalysis oracle has them flagged. Also fires when an
     *         `acceptOffer` call would pair the acceptor with a
     *         now-flagged offer creator — the offer author may have
     *         been clean when they posted but is sanctioned now.
     */
    error SanctionedAddress(address who);

    /**
     * @notice Installs the Chainalysis-style sanctions oracle address
     *         for this chain. Pass `address(0)` to disable screening
     *         entirely (correct on chains where Chainalysis has not
     *         deployed an oracle).
     * @dev Owner-only (enforced inside `LibVaipakam.setSanctionsOracle`),
     *      so timelock-gated after the governance handover. Emits
     *      `LibVaipakam.SanctionsOracleSet`.
     * @param oracle The Chainalysis oracle contract address, or zero.
     */
    function setSanctionsOracle(address oracle) external {
        LibVaipakam.setSanctionsOracle(oracle);
    }

    /// @notice Returns the currently-configured sanctions oracle address.
    ///         Zero means screening is disabled on this chain.
    function getSanctionsOracle() external view returns (address) {
        return LibVaipakam.storageSlot().sanctionsOracle;
    }

    /**
     * @notice Returns true iff the configured sanctions oracle reports
     *         `who` as currently flagged. Returns false when no oracle
     *         is configured (screening disabled) or when the oracle
     *         call itself reverts — fail-open on infrastructure
     *         failure, since the alternative would brick every
     *         interaction whenever the oracle has an outage.
     *
     *         Intended for UI pre-flight checks so a wallet sees a
     *         clear "you are on a sanctions list; this action will
     *         revert" message before signing — rather than a raw
     *         revert from the subsequent tx.
     * @param who The address to query.
     */
    function isSanctionedAddress(address who) external view returns (bool) {
        return LibVaipakam.isSanctionedAddress(who);
    }
}
