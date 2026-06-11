// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibKeeperReward} from "../libraries/LibKeeperReward.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

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
    /// @notice T-092 Phase 3 (#503) — extendLoanInPlace called on a
    ///         loan with a non-None periodic-interest cadence. Same
    ///         reasoning as `RefinanceFacet`'s settle-first guard:
    ///         the executor must NOT roll the start time forward
    ///         while an unsettled periodic obligation exists.
    error PeriodicCadenceMustSettleFirst();
    /// @notice T-092 Phase 3 — extendLoanInPlace can only modify
    ///         ERC20 loans (NFT rental extension would require NFT
    ///         custody changes; out of scope for Phase 3).
    error UnsupportedAssetTypeForExtend();
    /// @notice T-092 Phase 3 — neither side has consented to auto-
    ///         extend, or the cap was set by a non-current NFT
    ///         holder (staleness fence). The new NFT owner must
    ///         explicitly re-set caps before a keeper can extend.
    error BothSideAutoExtendRequired();
    /// @notice T-092 Phase 3 — the keeper-proposed rate falls
    ///         outside `[lender.minRateBps, min(lender.maxRateBps,
    ///         borrower.maxRateBps)]`.
    error AutoExtendRateOutOfBand();
    /// @notice T-092 Phase 3 — the new loan end time exceeds the
    ///         intersection of `borrower.maxNewExpiry` and
    ///         `lender.maxNewExpiry`.
    error AutoExtendExpiryExceedsCap();
    /// @notice T-092 Phase 3 — `newDurationDays` is zero or exceeds the
    ///         protocol's `cfgMaxOfferDurationDays` ceiling. Mirrors
    ///         the duration bound `OfferCreateFacet` enforces on
    ///         fresh offers; without this an extension could bypass
    ///         the long-duration interest-formula invariant that the
    ///         duration cap exists to protect.
    error AutoExtendDurationOutOfRange();
    /// @notice T-092 Phase 3 — extend called before at least one
    ///         full day has elapsed since `loan.startTime`. Codex
    ///         round-1 P1 — without this guard, `accruedInterestToTime`
    ///         (which floors to whole days) returns 0 and the post-
    ///         extension `startTime` reset would let a borrower
    ///         repeatedly extend just before the daily boundary to
    ///         erase all accrual.
    error AutoExtendTooSoonAfterStart();
    /// @notice T-092 Phase 3 — `block.timestamp + newDurationDays *
    ///         1 days` overflows `uint64`. Without this check the
    ///         explicit cast would silently truncate, letting a
    ///         keeper-proposed duration wrap past the cap.
    error AutoExtendEndTimeOverflow();
    /// @notice Codex round-4 P1 — loan is past its
    ///         `oldEndTime + gracePeriod(durationDays)` window, which
    ///         is the point at which `DefaultedFacet.triggerDefault`
    ///         is the intended resolution. Extension at this point
    ///         would let an authorised keeper undo a defaultable
    ///         state and salvage a loan the lender is owed a default
    ///         payout on.
    error ExtensionGraceExpired();
    /// @notice Codex round-4 P2 — proposed `newEndTime` is not
    ///         strictly after `oldEndTime`. An "extension" that
    ///         shortens the loan would let a compromised keeper turn
    ///         an extend consent into an early-maturity / default
    ///         vector.
    error ExtensionMustExtend();

    /// @notice T-092 Phase 3 — emitted on a successful in-place
    ///         loan extension. The position NFTs are untouched; only
    ///         the loan row's `startTime`, `interestRateBps`, and
    ///         `durationDays` change. `accruedInterest` is the
    ///         interest charged for the just-elapsed window (paid
    ///         from the borrower's vault to the lender's vault, with
    ///         the configured treasury cut applied).
    /// @dev    `caller` is the address that initiated the extension
    ///         (the keeper, or the borrower-NFT owner when extending
    ///         directly). Indexed so per-keeper / per-borrower
    ///         activity filters work without per-row args parsing.
    ///         Added in Codex round-4 P2 — without this field the
    ///         indexer can't denormalise an `actor` for the
    ///         `?actor=...` activity filter on direct extensions.
    /// @custom:event-category state-change/loan-mutation
    event LoanExtended(
        uint256 indexed loanId,
        address indexed caller,
        uint256 oldRateBps,
        uint256 newRateBps,
        uint64 oldStartTime,
        uint64 newStartTime,
        uint256 oldDurationDays,
        uint256 newDurationDays,
        uint256 accruedInterest
    );

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
        LibAuth.requireBorrowerNftOwner(loan);

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
        LibAuth.requireLenderNftOwner(loan);

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

    // ─── extendLoanInPlace — T-092 Phase 3 (#503) executor ───────────

    /// @notice Extend an active loan in place: roll `startTime` forward
    ///         to `block.timestamp`, replace `interestRateBps` with
    ///         `newRateBps`, and replace `durationDays` with
    ///         `newDurationDays`. No NFT mint / burn — both position
    ///         NFTs continue to represent the same loanId.
    /// @dev    Auth: Tier-1 sanctions check on the keeper AND on both
    ///         current NFT owners. `KEEPER_ACTION_EXTEND` bit gates
    ///         the borrower-side call; the lender-side consent is
    ///         carried by the lender's per-loan caps (a keeper-driven
    ///         extend doesn't directly require a lender-side keeper
    ///         bit since the lender's `autoExtendLenderCaps[loanId]`
    ///         enablement IS their consent surface).
    ///
    ///         Fund flow: accrued interest from `loan.startTime` to
    ///         `block.timestamp` is computed via
    ///         {LibEntitlement.proRataInterest}, withdrawn from the
    ///         current borrower-NFT-owner's vault (so the keeper-
    ///         driven path doesn't require any allowance from the
    ///         borrower's wallet), then split 99% / 1% to the lender
    ///         vault / treasury per the standard interest accrual
    ///         policy.
    ///
    ///         Keeper reward: paid via
    ///         {LibKeeperReward.payVpfiReward} on the gas-based
    ///         housekeeping path. No matcher-style LIF kickback —
    ///         this isn't a "match" event, it's a lifecycle update.
    function extendLoanInPlace(
        uint256 loanId,
        uint16 newRateBps,
        uint256 newDurationDays
    ) external nonReentrant whenNotPaused {
        uint256 gasStart = gasleft();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert LoanNotActive();
        }
        // ERC20 principal only — NFT rentals would need a custody
        // change conversation; out of scope for Phase 3.
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedAssetTypeForExtend();
        }
        // Mirrors RefinanceFacet's settle-first guard. A loan with an
        // unsettled periodic interest cadence can't have its start
        // time rolled forward without erasing the old lender's
        // outstanding period claim.
        if (loan.periodicInterestCadence !=
            LibVaipakam.PeriodicInterestCadence.None) {
            revert PeriodicCadenceMustSettleFirst();
        }
        // Codex round-1 P2 — block extension while a swap-to-repay
        // intent has the loan's collateral committed. Mirrors the
        // same guard used by RepayFacet / RefinanceFacet / PrecloseFacet
        // / collateral-mutation paths.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        // Codex round-1 P2 — duration must be in
        // `[1, cfgMaxOfferDurationDays()]`. Otherwise extension could
        // bypass the long-duration interest-formula invariant that
        // the duration cap exists to protect (OfferCreateFacet
        // enforces the same bound on fresh offers).
        uint256 maxDurationDays = LibVaipakam.cfgMaxOfferDurationDays();
        if (
            newDurationDays == 0 ||
            (maxDurationDays != 0 && newDurationDays > maxDurationDays)
        ) {
            revert AutoExtendDurationOutOfRange();
        }
        // Codex round-1 P1 — the executor resets `loan.startTime` to
        // `block.timestamp` at the end. If less than a full day has
        // elapsed since the previous start, `accruedInterestToTime`
        // floors to zero accrued interest and a borrower could
        // repeatedly extend just before the daily boundary to roll
        // the obligation forward without ever paying interest. Refuse
        // extension within the first day so accrual always lands.
        if (block.timestamp < uint256(loan.startTime) + LibVaipakam.ONE_DAY) {
            revert AutoExtendTooSoonAfterStart();
        }

        // ── Auth: keeper-side bit + Tier-1 sanctions on all parties ──
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_EXTEND,
            loan,
            /* lenderSide */ false
        );
        LibVaipakam._assertNotSanctioned(msg.sender);
        address borrowerNftOwner = LibERC721.ownerOf(loan.borrowerTokenId);
        address lenderNftOwner = LibERC721.ownerOf(loan.lenderTokenId);
        LibVaipakam._assertNotSanctioned(borrowerNftOwner);
        LibVaipakam._assertNotSanctioned(lenderNftOwner);

        // ── Both-side cap consent + staleness fence ──────────────────
        LibVaipakam.AutoExtendCaps storage borrowerCaps =
            s.autoExtendBorrowerCaps[loanId];
        LibVaipakam.AutoExtendCaps storage lenderCaps =
            s.autoExtendLenderCaps[loanId];
        bool borrowerFresh = borrowerCaps.setter == address(0) ||
            borrowerCaps.setter == borrowerNftOwner;
        bool lenderFresh = lenderCaps.setter == address(0) ||
            lenderCaps.setter == lenderNftOwner;
        if (
            !borrowerCaps.enabled || !lenderCaps.enabled ||
            !borrowerFresh || !lenderFresh
        ) {
            revert BothSideAutoExtendRequired();
        }

        // ── Cap intersection check ───────────────────────────────────
        // Rate must satisfy `lender.minRateBps <= newRate <=
        // min(lender.maxRateBps, borrower.maxRateBps)`. The lender's
        // floor protects them from a keeper accepting a 0% extension;
        // the borrower's ceiling protects them from a keeper
        // accepting an above-market rate. The intersection guarantees
        // both halves of consent bind.
        uint16 ceiling = lenderCaps.maxRateBps < borrowerCaps.maxRateBps
            ? lenderCaps.maxRateBps
            : borrowerCaps.maxRateBps;
        if (newRateBps < lenderCaps.minRateBps || newRateBps > ceiling) {
            revert AutoExtendRateOutOfBand();
        }
        // Codex round-1 P1 — compare expiry as uint256 BEFORE casting
        // down to uint64. Otherwise an arithmetically-overflowing
        // `block.timestamp + newDurationDays * 1 days` would silently
        // wrap past the cap.
        uint256 newEndTimeUint = block.timestamp + newDurationDays * 1 days;
        if (newEndTimeUint > type(uint64).max) {
            revert AutoExtendEndTimeOverflow();
        }
        uint64 expiryCap = lenderCaps.maxNewExpiry < borrowerCaps.maxNewExpiry
            ? lenderCaps.maxNewExpiry
            : borrowerCaps.maxNewExpiry;
        if (expiryCap != 0 && newEndTimeUint > uint256(expiryCap)) {
            revert AutoExtendExpiryExceedsCap();
        }
        // Codex round-4 P2 — refuse to SHORTEN the loan. Without
        // this, a compromised keeper could pass `newDurationDays = 1`
        // and turn the borrower's auto-extend consent into an early-
        // maturity / default vector. An "extension" must strictly
        // extend the loan's end time.
        uint256 oldEndTime = uint256(loan.startTime) + loan.durationDays * 1 days;
        if (newEndTimeUint <= oldEndTime) revert ExtensionMustExtend();
        // Codex round-4 P1 — refuse extension once the loan is past
        // its default grace window. At that point
        // `DefaultedFacet.triggerDefault` is the lender's intended
        // resolution and extension would let an authorised keeper
        // salvage a defaultable state. Mirrors the late-fee check
        // below but using the grace-aware threshold.
        if (
            block.timestamp >
            oldEndTime + LibVaipakam.gracePeriod(loan.durationDays)
        ) {
            revert ExtensionGraceExpired();
        }

        // ── Accrued-interest math + treasury / lender split ──────────
        // Codex round-1 P1 — honor `loan.useFullTermInterest`. When
        // the loan was contracted with the full-term coupon, that's
        // what the lender is owed even at mid-loan settlement.
        // Otherwise (the common pro-rata case) Codex round-2 P2 needs
        // SECONDS-based accrual rather than the days-flooring used by
        // `LibEntitlement.accruedInterestToTime`: extension at
        // `startTime + 1d + 23h` should pay the full 1d23h, not just 1d
        // (otherwise a borrower-controlled keeper could repeatedly
        // extend just before the daily boundary and erase ~23h of
        // accrual on every cycle).
        uint256 accruedInterest;
        if (loan.useFullTermInterest) {
            accruedInterest = LibEntitlement.fullTermInterest(
                loan.principal,
                loan.interestRateBps,
                loan.durationDays
            );
        } else {
            uint256 elapsedSeconds = block.timestamp - uint256(loan.startTime);
            accruedInterest =
                (loan.principal * loan.interestRateBps * elapsedSeconds) /
                (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        }
        // Codex round-2 P1 — if the loan is past its end time, a
        // borrower extending is morally a late-rescue. The late fee
        // that `RepayFacet` charges via `LibVaipakam.calculateLateFee`
        // must apply here too — otherwise a keeper-driven extension
        // becomes a way to escape both the late fee AND the default
        // path. Late fees go 100% to the lender (no treasury cut),
        // matching RepayFacet. (`oldEndTime` is shadowed-removed
        // here — the same value computed at the cap-intersection
        // block above.)
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, oldEndTime);
        if (accruedInterest + lateFee > 0) {
            // Codex round-1 P2 — use the protocol's
            // `cfgTreasuryFeeBps` (resolved via `splitTreasury`)
            // rather than the hardcoded `TREASURY_FEE_BPS`.
            (uint256 treasuryShare, uint256 lenderInterestShare) =
                LibEntitlement.splitTreasury(accruedInterest);
            // Codex round-4 P2 — if the original lender has VPFI yield-
            // fee consent + sufficient vault VPFI, pay the treasury cut
            // in VPFI from the lender's vault and route 100% of the
            // interest to the lender in the lending asset. Mirrors the
            // RepayFacet / PrecloseFacet / RefinanceFacet pattern.
            // `tryApplyYieldFee` is a silent fallback — if the lender
            // doesn't have enough VPFI, the standard 1% split applies.
            // Codex round-5 P1 — guard on `s.vpfiDiscountConsent[lender]`
            // exactly like the sibling settlement paths do.
            // `tryApplyYieldFee` itself does NOT check consent — it
            // would silently withdraw VPFI from any lender with a
            // quoteable tier whose vault has enough VPFI, even if
            // they never consented.
            if (treasuryShare > 0 && s.vpfiDiscountConsent[loan.lender]) {
                (bool yieldApplied, ) =
                    LibVPFIDiscount.tryApplyYieldFee(loan, accruedInterest);
                if (yieldApplied) {
                    lenderInterestShare = accruedInterest;
                    treasuryShare = 0;
                }
            }
            uint256 lenderShare = lenderInterestShare + lateFee;
            _routeInterest(
                loan.principalAsset,
                borrowerNftOwner,
                lenderNftOwner,
                lenderShare,
                treasuryShare
            );
        }
        // Codex round-2 P1 — clear any active prepay-collateral
        // Seaport listing BEFORE the loan row is mutated. Mirrors
        // RefinanceFacet's `LibPrepayCleanup.clearActiveListing` call
        // pattern. Without this, an old listing could still be filled
        // at the post-extension state where the executor's zone
        // would re-pay an already-settled interest leg.
        LibPrepayCleanup.clearActiveListing(loan, loanId);

        // ── Update the loan row IN PLACE ─────────────────────────────
        uint256 oldRateBps = loan.interestRateBps;
        uint64 oldStartTime = loan.startTime;
        uint256 oldDurationDays = loan.durationDays;
        loan.startTime = uint64(block.timestamp);
        loan.interestRateBps = newRateBps;
        loan.durationDays = newDurationDays;

        emit LoanExtended(
            loanId,
            msg.sender,
            oldRateBps,
            uint256(newRateBps),
            oldStartTime,
            uint64(block.timestamp),
            oldDurationDays,
            newDurationDays,
            accruedInterest
        );

        // ── Keeper reward ────────────────────────────────────────────
        // Gas-based housekeeping reward — sanctions soft-skip applies
        // via the #494 audit's `LibKeeperReward.payVpfiReward` gate.
        // Never reverts; if the keeper is sanctioned the loan extends
        // but no payout lands.
        //
        // Codex round-3 P2 — skip the payout when the caller IS the
        // borrower-NFT owner extending their own loan. The keeper
        // reward exists to compensate THIRD-PARTY housekeeping; a
        // self-extension isn't a keeper service and would otherwise
        // let a borrower drain the 2x gas multiplier in VPFI on every
        // self-driven extend.
        if (msg.sender != borrowerNftOwner) {
            LibKeeperReward.payVpfiReward(
                msg.sender,
                keccak256("extendLoanInPlace"),
                gasStart - gasleft()
            );
        }
    }

    /// @dev Moves accrued interest from the borrower-NFT owner's vault
    ///      to the lender-NFT owner's vault + treasury. Factored out
    ///      so {extendLoanInPlace} stays under viaIR's stack budget.
    function _routeInterest(
        address principalAsset,
        address borrowerNftOwner,
        address lenderNftOwner,
        uint256 lenderShare,
        uint256 treasuryShare
    ) internal {
        // 1. Withdraw the full accrued interest from the borrower's
        //    vault to the diamond itself.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                borrowerNftOwner,
                principalAsset,
                address(this),
                lenderShare + treasuryShare
            ),
            IVaipakamErrors.VaultWithdrawFailed.selector
        );
        // 2. Forward treasury share + record accrual.
        if (treasuryShare > 0) {
            SafeERC20.safeTransfer(
                IERC20(principalAsset),
                LibFacet.getTreasury(),
                treasuryShare
            );
            LibFacet.recordTreasuryAccrual(principalAsset, treasuryShare);
        }
        // 3. Push lender share into the lender's vault.
        address lenderVault = LibFacet.getOrCreateVault(lenderNftOwner);
        if (lenderShare > 0) {
            SafeERC20.safeTransfer(
                IERC20(principalAsset),
                lenderVault,
                lenderShare
            );
            LibVaipakam.recordVaultDeposit(
                lenderNftOwner,
                principalAsset,
                lenderShare
            );
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
        address current = LibERC721._ownerOfRaw(loan.borrowerTokenId);
        return current != address(0) && current == setter;
    }

    function _isCurrentLenderNft(
        LibVaipakam.Loan storage loan,
        address setter
    ) internal view returns (bool) {
        if (setter == address(0)) return true;
        address current = LibERC721._ownerOfRaw(loan.lenderTokenId);
        return current != address(0) && current == setter;
    }
}
