// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";

/**
 * @title AutoLifecycleSettingsFacet
 * @author Vaipakam Developer Team
 * @notice T-092 Phase 1 — the consent surface for auto-lend, auto-refinance
 *         and auto-extend: each user's and each position's settings, and the
 *         reads of them. Nothing here moves funds or changes a loan.
 *
 *         The executors read these settings elsewhere: the auto-refinance
 *         caps bind every refinance-tagged offer at create and at accept or
 *         match (`LibAutoRefinanceCheck`); `AutoLifecycleFacet`'s
 *         `extendLoanInPlace` reads both sides' extend caps; auto-lend is
 *         pure dapp-side (the flag is an opt-in marker the dapp reads to
 *         decide whether to post a standing offer when a vault deposit
 *         lands).
 *
 * @dev    Split out of `AutoLifecycleFacet` in #3410, along the settings /
 *         execution seam: that facet had reached 79 bytes under EIP-170,
 *         less than the loan clock's sequencer-outage read costs, so every
 *         queued change to the extension executor was undeployable (the
 *         #1780 / #1835 / #2416 condition again). Same storage, same
 *         Diamond, same selectors, events and errors; only the runtime
 *         bytecode is separate. The two share no behaviour across a call,
 *         so a refresh of either alone runs no half-old flow.
 *
 *         Sanctions gating: every setter is a state-mutating user-initiated
 *         entry point with no fund flow, so Tier-1 hard-reverts on
 *         `msg.sender` (CLAUDE.md "Tier-1 / Tier-2 split"), as
 *         `VPFIDiscountFacet.setVPFIDiscountConsent` does.
 */
contract AutoLifecycleSettingsFacet is DiamondReentrancyGuard, DiamondPausable {
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

    /// @notice Returned when caps are nonsensical (min > max, expiry in past, etc.).
    error InvalidCaps();
    /// @notice Returned when the loan isn't Active.
    error LoanNotActive();
    /// @notice T-092 #508 — the admin auto-lend kill switch is off.
    error AutoLendDisabled();

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
        // T-092 #508 — admin kill switch. While
        // `cfgAutoLendEnabled` is false, users may revoke (disable)
        // their consent but not opt IN. Existing `true` flags stay
        // in storage so re-enabling the feature doesn't force every
        // user to re-consent.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (enabled && !s.protocolCfg.cfgAutoLendEnabled) {
            revert AutoLendDisabled();
        }
        s.autoLendConsent[msg.sender] = enabled;
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
            // (it's just a marker); when enabled it must be a future
            // timestamp. maxRateBps == 0 is permitted — a borrower
            // may legitimately consent only to a 0% refinance. But
            // values above the protocol's MAX_INTEREST_BPS ceiling
            // make the cap meaningless (no valid offer can exceed
            // it), so reject them — protects against Codex round-3
            // P2 the borrower-believes-cap-binds vs. it-doesn't case.
            if (maxNewExpiry <= block.timestamp) revert InvalidCaps();
            if (uint256(maxRateBps) > LibVaipakam.MAX_INTEREST_BPS) {
                revert InvalidCaps();
            }
        }
        LibVaipakam.storageSlot().defaultAutoRefinanceCaps[msg.sender] =
            LibVaipakam.AutoRefinanceCaps({
                enabled: enabled,
                maxRateBps: maxRateBps,
                maxNewExpiry: maxNewExpiry,
                // The default-template's setter field is unused by the
                // per-loan staleness fence; the per-loan slot gets its
                // own setter stamp at copy time in LoanFacet's hook.
                setter: msg.sender
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
    ///         `setDefaultAutoRefinanceCaps`. Every refinance-tagged offer
    ///         against the loan is checked against them at create and at
    ///         accept or match (`LibAutoRefinanceCheck`).
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
            // maxRateBps == 0 permitted — borrower may consent only
            // to a 0% refinance. But values above MAX_INTEREST_BPS
            // make the cap meaningless; reject them.
            if (maxNewExpiry <= block.timestamp) revert InvalidCaps();
            if (uint256(maxRateBps) > LibVaipakam.MAX_INTEREST_BPS) {
                revert InvalidCaps();
            }
        }
        s.autoRefinanceCaps[loanId] = LibVaipakam.AutoRefinanceCaps({
            enabled: enabled,
            maxRateBps: maxRateBps,
            maxNewExpiry: maxNewExpiry,
            setter: msg.sender
        });
        emit AutoRefinanceCapsChanged(
            loanId, msg.sender, enabled, maxRateBps, maxNewExpiry
        );
    }

    function getAutoRefinanceCaps(uint256 loanId)
        external
        view
        returns (LibVaipakam.AutoRefinanceCaps memory caps)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        caps = s.autoRefinanceCaps[loanId];
        // Staleness fence: if the borrower position NFT has changed
        // hands since `setter` set these caps, treat the slot as
        // disabled. Prevents an old borrower's pre-approved terms
        // being applied to the new owner's loan obligation. The new
        // owner can explicitly re-set caps to reactivate.
        if (caps.enabled && !_isCurrentBorrowerNft(s.loans[loanId], caps.setter)) {
            caps.enabled = false;
        }
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
        LibAuth.requirePositionManager(loan.borrowerTokenId);

        _validateExtendCaps(enabled, minRateBps, maxRateBps, maxNewExpiry);

        s.autoExtendBorrowerCaps[loanId] = LibVaipakam.AutoExtendCaps({
            enabled: enabled,
            minRateBps: minRateBps,
            maxRateBps: maxRateBps,
            maxNewExpiry: maxNewExpiry,
            setter: msg.sender
        });
        emit AutoExtendBorrowerCapsChanged(
            loanId, msg.sender, enabled, minRateBps, maxRateBps, maxNewExpiry
        );
    }

    function getAutoExtendBorrowerCaps(uint256 loanId)
        external
        view
        returns (LibVaipakam.AutoExtendCaps memory caps)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        caps = s.autoExtendBorrowerCaps[loanId];
        if (caps.enabled && !_isCurrentBorrowerNft(s.loans[loanId], caps.setter)) {
            caps.enabled = false;
        }
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
        LibAuth.requirePositionManager(loan.lenderTokenId);

        _validateExtendCaps(enabled, minRateBps, maxRateBps, maxNewExpiry);

        s.autoExtendLenderCaps[loanId] = LibVaipakam.AutoExtendCaps({
            enabled: enabled,
            minRateBps: minRateBps,
            maxRateBps: maxRateBps,
            maxNewExpiry: maxNewExpiry,
            setter: msg.sender
        });
        emit AutoExtendLenderCapsChanged(
            loanId, msg.sender, enabled, minRateBps, maxRateBps, maxNewExpiry
        );
    }

    function getAutoExtendLenderCaps(uint256 loanId)
        external
        view
        returns (LibVaipakam.AutoExtendCaps memory caps)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        caps = s.autoExtendLenderCaps[loanId];
        if (caps.enabled && !_isCurrentLenderNft(s.loans[loanId], caps.setter)) {
            caps.enabled = false;
        }
    }

    function _validateExtendCaps(
        bool enabled,
        uint16 minRateBps,
        uint16 maxRateBps,
        uint64 maxNewExpiry
    ) internal view {
        if (!enabled) return; // disabled caps don't need to be sensible
        // Codex round-1 P3 — zero rate is a valid rate (OfferCreate
        // accepts 0%); both bounds may be zero so a borrower can
        // consent only to a free extension. The structural rule is
        // that min ≤ max + the expiry must be in the future + max
        // does not exceed the protocol's MAX_INTEREST_BPS ceiling
        // (Codex round-3 P2 — otherwise the cap is meaningless).
        if (minRateBps > maxRateBps || maxNewExpiry <= block.timestamp) {
            revert InvalidCaps();
        }
        if (uint256(maxRateBps) > LibVaipakam.MAX_INTEREST_BPS) {
            revert InvalidCaps();
        }
    }

    /// @dev Staleness fence helpers. The per-loan cap getters fall the
    ///      slot back to disabled when the position NFT has changed
    ///      hands since the original setter wrote it — prevents an
    ///      old owner's pre-approved terms applying to a new owner's
    ///      loan. The new owner must explicitly re-set caps. Reads
    ///      `ownerOf` via the embedded LibERC721 storage to avoid a
    ///      cross-facet hop in a view.
    function _isCurrentBorrowerNft(
        LibVaipakam.Loan storage loan,
        address setter
    ) internal view returns (bool) {
        if (setter == address(0)) return true; // default-template carry-over; no fence
        // Codex round-2 P3 — `ownerOf` reverts `ERC721NonexistentToken`
        // for a burned NFT (terminal claim path burns the position
        // NFT). Read the storage slot directly so the reader returns
        // disabled-caps cleanly instead of bubbling a revert.
        address current = LibPositionNFT.holderOrZero(loan.borrowerTokenId);
        return current != address(0) && LibProtectedAccount.manager(current) == setter;
    }

    function _isCurrentLenderNft(
        LibVaipakam.Loan storage loan,
        address setter
    ) internal view returns (bool) {
        if (setter == address(0)) return true;
        address current = LibPositionNFT.holderOrZero(loan.lenderTokenId);
        return current != address(0) && LibProtectedAccount.manager(current) == setter;
    }
}
