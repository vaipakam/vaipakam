// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";

/**
 * @title AutoLifecycleFacet
 * @author Vaipakam Developer Team
 * @notice T-092 Phase 1 — consent surface for auto-lend / auto-refinance /
 *         auto-extend.
 *
 *         This facet holds the SETTER + READER surface for the auto-
 *         lifecycle consent flags. The actual executors live elsewhere:
 *
 *           - Auto-refinance: the existing
 *             `RefinanceFacet.refinanceLoan` path already supports
 *             keeper-driven invocation via `LibAuth.requireKeeperFor`
 *             with `KEEPER_ACTION_REFINANCE`. A follow-up PR (T-092
 *             Phase 2) wires the per-loan caps stored here into
 *             `refinanceLoan` so a keeper can't route the borrower
 *             into a worse rate than they pre-approved.
 *
 *           - Auto-extend: `extendLoanInPlace` is the new selector,
 *             introduced in a Phase 3 follow-up. It will read the
 *             per-loan + per-side caps stored here, deduct interest
 *             via `LibEntitlement.proRataInterest`, update the loan's
 *             `endTime` / `interestRateBps` in place (no NFT churn),
 *             and pay the keeper via `LibKeeperReward.payVpfiReward`.
 *
 *           - Auto-lend: pure dapp-side. The single boolean
 *             `autoLendConsent[user]` is an opt-in marker the dapp
 *             reads to decide whether to auto-post a standing offer
 *             when a vault deposit lands. No contract enforcement —
 *             the user posts offers manually if not consented; the
 *             dapp posts on their behalf if consented. Keepers pick up
 *             the standing offers via the existing
 *             `OfferMatchFacet.matchOffers` matcher.
 *
 * @dev    Sanctions gating: every setter is a state-mutating user-
 *         initiated entry point with no fund flow. Per the retail-
 *         deploy policy (CLAUDE.md "Tier-1 / Tier-2 split"), Tier-1
 *         hard-revert on `msg.sender`. Matches the gate already used
 *         on the parallel `VPFIDiscountFacet.setVPFIDiscountConsent`
 *         setter.
 */
contract AutoLifecycleFacet is DiamondReentrancyGuard, DiamondPausable {
    // ─── Events ──────────────────────────────────────────────────────

    /// @notice Emitted when a user toggles their auto-lend opt-in.
    /// @custom:event-category state-change/consent
    event AutoLendConsentChanged(address indexed user, bool enabled);

    /// @notice Emitted when a borrower toggles the "auto-populate
    ///         refinance caps on every new loan" convenience flag.
    /// @custom:event-category state-change/consent
    event AutoOptInOnNewLoanChanged(address indexed user, bool enabled);

    /// @notice Emitted when a user updates their default per-loan
    ///         refinance caps. These are copied into a loan's
    ///         `autoRefinanceCaps[loanId]` at init time when the user
    ///         has `autoOptInOnNewLoan` enabled.
    /// @custom:event-category state-change/consent
    event DefaultAutoRefinanceCapsChanged(
        address indexed user,
        bool enabled,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    );

    /// @notice Emitted when a borrower updates per-loan refinance caps.
    /// @custom:event-category state-change/consent
    event AutoRefinanceCapsChanged(
        uint256 indexed loanId,
        address indexed borrower,
        bool enabled,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    );

    /// @notice Emitted when the borrower side updates per-loan extend caps.
    /// @custom:event-category state-change/consent
    event AutoExtendBorrowerCapsChanged(
        uint256 indexed loanId,
        address indexed borrower,
        bool enabled,
        uint16 minRateBps,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    );

    /// @notice Emitted when the lender side updates per-loan extend caps.
    /// @custom:event-category state-change/consent
    event AutoExtendLenderCapsChanged(
        uint256 indexed loanId,
        address indexed lender,
        bool enabled,
        uint16 minRateBps,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    );

    // ─── Errors ──────────────────────────────────────────────────────

    /// @notice Returned when the caller is not the borrower-NFT owner.
    error NotBorrowerNftOwner();
    /// @notice Returned when the caller is not the lender-NFT owner.
    error NotLenderNftOwner();
    /// @notice Returned when caps are nonsensical (min > max, expiry in past, etc.).
    error InvalidCaps();
    /// @notice Returned when the loan isn't Active.
    error LoanNotActive();

    // ─── Auto-lend (per-user flag; no contract enforcement) ──────────

    /// @notice Toggle whether the dapp may auto-post standing offers on
    ///         the caller's behalf when vault deposits land.
    /// @dev    Single boolean opt-in marker. The contract itself does
    ///         NOT auto-post; the dapp reads this flag to decide.
    ///         Keepers pick up the resulting offers via the existing
    ///         `OfferMatchFacet.matchOffers` matcher.
    function setAutoLendConsent(bool enabled)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.storageSlot().autoLendConsent[msg.sender] = enabled;
        emit AutoLendConsentChanged(msg.sender, enabled);
    }

    function getAutoLendConsent(address user) external view returns (bool) {
        return LibVaipakam.storageSlot().autoLendConsent[user];
    }

    // ─── Auto-refinance (per-user convenience + per-loan caps) ───────

    /// @notice Toggle the borrower convenience flag: when true, every
    ///         loan the user originates as borrower has its per-loan
    ///         `autoRefinanceCaps` auto-populated from
    ///         `defaultAutoRefinanceCaps[user]` at init time.
    function setAutoOptInOnNewLoan(bool enabled)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.storageSlot().autoOptInOnNewLoan[msg.sender] = enabled;
        emit AutoOptInOnNewLoanChanged(msg.sender, enabled);
    }

    function getAutoOptInOnNewLoan(address user) external view returns (bool) {
        return LibVaipakam.storageSlot().autoOptInOnNewLoan[user];
    }

    /// @notice Set the per-user default refinance caps copied into
    ///         every new loan when `autoOptInOnNewLoan` is set.
    function setDefaultAutoRefinanceCaps(
        bool enabled,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (enabled) {
            // Cap sanity. maxNewExpiry == 0 is allowed when disabled
            // (it's just a marker); when enabled, it must be a future
            // timestamp.
            if (maxRateBps == 0 || maxNewExpiry <= block.timestamp) {
                revert InvalidCaps();
            }
        }
        LibVaipakam.storageSlot().defaultAutoRefinanceCaps[msg.sender] =
            LibVaipakam.AutoRefinanceCaps({
                enabled: enabled,
                maxRateBps: maxRateBps,
                maxNewExpiry: maxNewExpiry
            });
        emit DefaultAutoRefinanceCapsChanged(
            msg.sender, enabled, maxRateBps, maxNewExpiry
        );
    }

    function getDefaultAutoRefinanceCaps(address user)
        external
        view
        returns (LibVaipakam.AutoRefinanceCaps memory)
    {
        return LibVaipakam.storageSlot().defaultAutoRefinanceCaps[user];
    }

    /// @notice Set the per-loan refinance caps for a specific loan.
    ///         Only the current borrower-NFT owner may call this.
    /// @dev    Per-loan caps override any defaults set via
    ///         `setDefaultAutoRefinanceCaps`. The keeper-driven
    ///         `RefinanceFacet.refinanceLoan` path enforces these caps
    ///         (Phase 2 wiring). Borrower-NFT-owner direct calls to
    ///         `refinanceLoan` ignore caps — they're acting in their
    ///         own interest.
    function setAutoRefinanceCaps(
        uint256 loanId,
        bool enabled,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert LoanNotActive();
        // Borrower-NFT ownership check, mirroring the LibAuth pattern
        // used at every other borrower-side entry point.
        LibAuth.requireBorrowerNftOwner(loan);

        if (enabled) {
            if (maxRateBps == 0 || maxNewExpiry <= block.timestamp) {
                revert InvalidCaps();
            }
        }
        s.autoRefinanceCaps[loanId] = LibVaipakam.AutoRefinanceCaps({
            enabled: enabled,
            maxRateBps: maxRateBps,
            maxNewExpiry: maxNewExpiry
        });
        emit AutoRefinanceCapsChanged(
            loanId, msg.sender, enabled, maxRateBps, maxNewExpiry
        );
    }

    function getAutoRefinanceCaps(uint256 loanId)
        external
        view
        returns (LibVaipakam.AutoRefinanceCaps memory)
    {
        return LibVaipakam.storageSlot().autoRefinanceCaps[loanId];
    }

    // ─── Auto-extend (BOTH-side per-loan caps) ───────────────────────

    /// @notice Borrower side: set per-loan extend caps.
    /// @dev    Both borrower AND lender must have `enabled = true` for
    ///         a keeper to invoke `extendLoanInPlace` (Phase 3 follow-
    ///         up). When enabled, the executor picks `newRateBps` in
    ///         `[lender.minRateBps, borrower.maxRateBps]` and
    ///         `newEndTime ≤ min(borrower.maxNewExpiry,
    ///         lender.maxNewExpiry)`.
    function setAutoExtendBorrowerCaps(
        uint256 loanId,
        bool enabled,
        uint16 minRateBps,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert LoanNotActive();
        LibAuth.requireBorrowerNftOwner(loan);

        _validateExtendCaps(enabled, minRateBps, maxRateBps, maxNewExpiry);

        s.autoExtendBorrowerCaps[loanId] = LibVaipakam.AutoExtendCaps({
            enabled: enabled,
            minRateBps: minRateBps,
            maxRateBps: maxRateBps,
            maxNewExpiry: maxNewExpiry
        });
        emit AutoExtendBorrowerCapsChanged(
            loanId, msg.sender, enabled, minRateBps, maxRateBps, maxNewExpiry
        );
    }

    function getAutoExtendBorrowerCaps(uint256 loanId)
        external
        view
        returns (LibVaipakam.AutoExtendCaps memory)
    {
        return LibVaipakam.storageSlot().autoExtendBorrowerCaps[loanId];
    }

    /// @notice Lender side: set per-loan extend caps. Only the current
    ///         lender-NFT owner may call this.
    function setAutoExtendLenderCaps(
        uint256 loanId,
        bool enabled,
        uint16 minRateBps,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert LoanNotActive();
        LibAuth.requireLenderNftOwner(loan);

        _validateExtendCaps(enabled, minRateBps, maxRateBps, maxNewExpiry);

        s.autoExtendLenderCaps[loanId] = LibVaipakam.AutoExtendCaps({
            enabled: enabled,
            minRateBps: minRateBps,
            maxRateBps: maxRateBps,
            maxNewExpiry: maxNewExpiry
        });
        emit AutoExtendLenderCapsChanged(
            loanId, msg.sender, enabled, minRateBps, maxRateBps, maxNewExpiry
        );
    }

    function getAutoExtendLenderCaps(uint256 loanId)
        external
        view
        returns (LibVaipakam.AutoExtendCaps memory)
    {
        return LibVaipakam.storageSlot().autoExtendLenderCaps[loanId];
    }

    function _validateExtendCaps(
        bool enabled,
        uint16 minRateBps,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    ) internal view {
        if (!enabled) return; // disabled caps don't need to be sensible
        if (
            minRateBps == 0 ||
            maxRateBps == 0 ||
            minRateBps > maxRateBps ||
            maxNewExpiry <= block.timestamp
        ) {
            revert InvalidCaps();
        }
    }
}
