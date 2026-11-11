// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibRefinanceRequest} from "../libraries/LibRefinanceRequest.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibInterestLedger} from "../libraries/LibInterestLedger.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibKeeperReward} from "../libraries/LibKeeperReward.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {FeeEntitlementFacet} from "./FeeEntitlementFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title AutoLifecycleFacet
 * @author Vaipakam Developer Team
 * @notice T-092 — the in-place loan extension (`extendLoanInPlace`), its
 *         extension window and its extension reserve. The consent surface
 *         (auto-lend, auto-refinance and auto-extend settings and their
 *         reads) moved to `AutoLifecycleSettingsFacet` in #3410, along the
 *         settings / execution seam, because this facet had reached EIP-170.
 *
 *         Where each auto-lifecycle flow executes:
 *
 *           - Auto-refinance: a refinance-tagged borrower offer,
 *             completed atomically by its accept or matched fill
 *             (`RefinanceFacet`). The per-loan caps (set through
 *             `AutoLifecycleSettingsFacet`) bind
 *             every such offer at create and at accept or match
 *             (`LibAutoRefinanceCheck`), so no route can take the
 *             borrower to a worse rate than they pre-approved.
 *
 *           - Auto-extend: `extendLoanInPlace`, here. It reads both
 *             sides' per-loan extend caps, charges the elapsed interest,
 *             updates the loan's term and rate in place (no NFT churn),
 *             and pays the keeper via `LibKeeperReward.payVpfiReward`.
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
 * @dev    Sanctions gating: the extension screens the caller and both
 *         position holders (Tier-1). The settings facet gates its setters
 *         the same way.
 */
contract AutoLifecycleFacet is DiamondReentrancyGuard, DiamondPausable {
    // ─── Events ──────────────────────────────────────────────────────
    //
    // The consent events (`AutoLendConsentChanged` and the five caps events)
    // moved with their setters to `AutoLifecycleSettingsFacet` in #3410.

    /// @notice #2814 — the borrower-position holder deposited `amount` of
    ///         the loan's principal asset into their own vault, reserved for
    ///         the loan's auto-extensions.
    /// @param reserved What the holder has reserved for the loan after it.
    /// @custom:event-category state-change/vault-mutation
    event ExtendReserveFunded(
        uint256 indexed loanId,
        address indexed holder,
        address asset,
        uint256 amount,
        uint256 reserved
    );

    /// @notice #2814 — a depositor withdrew `amount` of their unused
    ///         extension reserve for the loan to their wallet.
    /// @param reserved What the depositor still has reserved for the loan.
    /// @custom:event-category state-change/vault-mutation
    event ExtendReserveWithdrawn(
        uint256 indexed loanId,
        address indexed holder,
        address asset,
        uint256 amount,
        uint256 reserved
    );

    /// @notice #2814 — an extension charged the borrower-position holder's
    ///         vault: `fromReserve` out of their reserve for the loan, and
    ///         `fromFree` out of their other free balance of the asset.
    /// @param reserved What the holder still has reserved for the loan.
    /// @custom:event-category state-change/vault-mutation
    event ExtendChargeDrawn(
        uint256 indexed loanId,
        address indexed holder,
        address asset,
        uint256 fromReserve,
        uint256 fromFree,
        uint256 reserved
    );

    // ─── Errors ──────────────────────────────────────────────────────

    /// @notice Returned when the caller is not the borrower-NFT owner.
    error NotBorrowerNftOwner();
    /// @notice Returned when the caller is not the lender-NFT owner.
    error NotLenderNftOwner();
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
    /// @notice #2738 — extend called before the loan's extension window
    ///         opens ({getAutoExtendWindow}). The window opens
    ///         {AUTO_EXTEND_WINDOW} before the loan's effective maturity, so
    ///         a loan is re-termed (interest settled, start reset, rate
    ///         moved) only near the end of the term both parties agreed,
    ///         never early in it; and never within the first day after its
    ///         start (Codex round-1 P1 on T-092: the start reset would let a
    ///         borrower roll the obligation forward without accrual landing).
    /// @param  opensAt The earliest timestamp an extension is accepted.
    error AutoExtendWindowNotOpen(uint256 opensAt);
    /// @notice #2738 — the proposed term would make the loan defaultable
    ///         sooner than it is now: its new end plus the grace its new
    ///         duration earns falls before the current grace end. A short
    ///         new duration can land in a smaller grace bucket, so a later
    ///         end alone does not protect the borrower's grace time.
    /// @param  newGraceEnd The grace end the proposed term would give.
    /// @param  graceEnd    The loan's grace end now.
    error ExtensionShortensGrace(uint256 newGraceEnd, uint256 graceEnd);
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
    /// @notice T-092 #508 — the admin auto-extend kill switch is off (the
    ///         auto-lend one moved to `AutoLifecycleSettingsFacet`, #3410).
    error AutoExtendDisabled();
    /// @notice #2814 — a reserve deposit or withdrawal of zero.
    error ExtendReserveZeroAmount();

    /// @notice #1384 — the fee-entitlement reprice cross-facet call on
    ///         extension reverted (should be unreachable: the target is a
    ///         diamond-internal storage write).
    error FeeEntitlementRepriceFailed();

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

    // ─── Extension window — #2738 ────────────────────────────────────

    /// @notice How long before a loan's effective maturity its extension
    ///         window opens (#2738). Fixed, not a governance knob: it is
    ///         part of what both parties consent to when they set their
    ///         auto-extend caps.
    uint256 internal constant AUTO_EXTEND_WINDOW = 3 days;

    /// @notice #2738 — when an active loan may be extended in place: from
    ///         `opensAt` to `closesAt`, both inclusive. `opensAt` is
    ///         {AUTO_EXTEND_WINDOW} before the loan's effective
    ///         (pause-adjusted) maturity, or one day after its start if that
    ///         is later; `closesAt` is its effective grace end, past which
    ///         the loan may be defaulted. The keeper reads this rather than
    ///         computing the window itself, so the rule lives in one place.
    /// @dev    An extension inside the window must also leave the loan
    ///         defaultable no sooner than `closesAt`: the new end plus the
    ///         grace its new duration earns must be at least `closesAt`
    ///         ({ExtensionShortensGrace}). Both parties' caps and the admin
    ///         switch still apply; this view says only WHEN.
    /// @param  loanId The loan.
    /// @return opensAt  Earliest timestamp `extendLoanInPlace` accepts.
    /// @return closesAt Latest timestamp it accepts (the grace end).
    function getAutoExtendWindow(uint256 loanId)
        external
        view
        returns (uint64 opensAt, uint64 closesAt)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        // `startTime == 0` is a loan id never opened: its zero status reads
        // as Active.
        if (loan.startTime == 0 || loan.status != LibVaipakam.LoanStatus.Active) {
            revert LoanNotActive();
        }
        (uint256 o, uint256 c) = _extendWindow(loan);
        return (uint64(o), uint64(c));
    }

    /// @dev The one statement of the extension window (#2738), read by the
    ///      executor and by {getAutoExtendWindow}. Maturity and grace end come
    ///      from {LibLoanClock}, so a pause moves the window with the loan.
    function _extendWindow(LibVaipakam.Loan storage loan)
        private
        view
        returns (uint256 opensAt, uint256 closesAt)
    {
        uint256 m = LibLoanClock.maturity(loan);
        opensAt = m > AUTO_EXTEND_WINDOW ? m - AUTO_EXTEND_WINDOW : 0;
        uint256 firstDayEnd = uint256(loan.startTime) + LibVaipakam.ONE_DAY;
        if (opensAt < firstDayEnd) opensAt = firstDayEnd;
        closesAt = LibLoanClock.graceEnd(loan);
    }

    // ─── Extension reserve — #2814 ────────────────────────────────────

    /// @notice #2814 — deposit `amount` of `loanId`'s principal asset from the
    ///         caller's wallet into their own vault, reserved for that loan's
    ///         auto-extensions. An extension charges the current
    ///         borrower-position holder's vault, and this is the route by
    ///         which that holder puts the principal asset there. The reserve
    ///         is not free balance: only an extension's charge and
    ///         {withdrawExtendReserve} take it out.
    /// @dev    Only the current borrower-position holder may fund, because an
    ///         extension draws only on that holder's vault. The reserve stays
    ///         the depositor's if the position later moves: a new holder funds
    ///         their own, and the depositor can withdraw theirs. Refused while
    ///         the loan could not be extended at all (the loan not Active, not
    ///         an ERC-20 loan, or on a periodic cadence), so no deposit sits
    ///         behind an extension that cannot run. The auto-extend switch
    ///         does not refuse it: the borrower's own direct extension stays
    ///         open while the switch is off, and draws on this reserve too
    ///         (#3175). Tier-1 sanctions-gated and refused for a paused asset (new
    ///         custody), like {LenderIntentFacet.fundLenderIntent}. The caller
    ///         approves the Diamond for exactly `amount` first.
    /// @param loanId The loan whose extensions the reserve pays.
    /// @param amount The amount of the loan's principal asset to deposit.
    function fundExtendReserve(uint256 loanId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibProtectedAccount.requireManager(msg.sender); // a retired wallet funds nothing
        if (amount == 0) revert ExtendReserveZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #3175 — no auto-extend switch check: the switch stops only the
        // keeper-driven extension, and the reserve is the borrower's own
        // money for their own direct extension too (owner decision
        // 2026-11-05, "Free borrower").
        if (loan.startTime == 0 || loan.status != LibVaipakam.LoanStatus.Active) {
            revert LoanNotActive();
        }
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert UnsupportedAssetTypeForExtend();
        }
        if (loan.periodicInterestCadence != LibVaipakam.PeriodicInterestCadence.None) {
            revert PeriodicCadenceMustSettleFirst();
        }
        if (LibPositionNFT.ownerOf(loan.borrowerTokenId) != msg.sender) revert NotBorrowerNftOwner();
        address asset = loan.principalAsset;
        LibFacet.requireAssetNotPaused(asset);
        // Wallet -> the caller's own vault through the protocol chokepoint,
        // which records the tracked balance and refuses a short arrival, then
        // reserved for this loan.
        LibFacet.crossFacetCall(
            abi.encodeCall(VaultFactoryFacet.vaultDepositERC20, (msg.sender, asset, amount)),
            IVaipakamErrors.VaultDepositFailed.selector
        );
        LibEncumbrance.lienExtendReserve(loanId, msg.sender, asset, amount);
        emit ExtendReserveFunded(loanId, msg.sender, asset, amount, s.extendReserve[loanId][msg.sender]);
    }

    /// @notice #2814 — withdraw `amount` of `account`'s unused extension
    ///         reserve for `loanId` from its vault to the caller, who must be
    ///         the account's manager (its own wallet, or its controller once
    ///         a replacement retired it).
    /// @dev    Open whatever the loan's state, and whether or not the caller
    ///         still holds the borrower position: the reserve is the
    ///         depositor's own money. Tier-1 sanctions-gated (funds leave to
    ///         the caller), like {LenderIntentFacet.withdrawLenderIntentCapital}.
    ///         Reverts {LibEncumbrance.ExtendReserveInsufficient} past what is
    ///         reserved.
    function withdrawExtendReserve(address account, uint256 loanId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        // The account's manager: its own wallet, or its controller once a
        // replacement retired it, so a recovered account's reserve is never
        // stranded behind the lost key. Paid to the manager (a protected
        // account's payout queues behind the delay).
        LibProtectedAccount.requireManager(account);
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (amount == 0) revert ExtendReserveZeroAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address asset = s.loans[loanId].principalAsset;
        // Released BEFORE the withdraw, so the chokepoint's guard sees it free.
        LibEncumbrance.unlienExtendReserve(loanId, account, asset, amount);
        // The reserve back to the account's own wallet, or to its controller
        // once a replacement retired it (#3205 part 2: the owner classes).
        if (msg.sender == account) {
            LibVaultOutflow.toOwner(account, LibVaultOutflow.ERC20, asset, 0, amount, OutflowReason.WITHDRAW);
        } else {
            LibVaultOutflow.toAllowlisted(account, LibVaultOutflow.ERC20, asset, 0, amount, msg.sender, OutflowReason.WITHDRAW);
        }
        emit ExtendReserveWithdrawn(loanId, account, asset, amount, s.extendReserve[loanId][account]);
    }

    /// @notice #2814 — what `holder` has ready for `loanId`'s next
    ///         auto-extension, and what that extension would charge.
    /// @return asset            The loan's principal asset, the charge's asset.
    /// @return reserved         `holder`'s reserve for the loan; an extension
    ///                          draws it first.
    /// @return otherFree        `holder`'s other free vault balance of the
    ///                          asset; an extension draws it after the reserve.
    /// @return chargeNow        What an extension now would charge: the
    ///                          interest since the accrual start plus any late
    ///                          fee.
    /// @return chargeAtGraceEnd What it would charge at the end of the
    ///                          extension window, the most an extension of
    ///                          the loan's current term can charge.
    /// @dev    Both charges read 0 for a loan that cannot be extended (not
    ///         Active, not an ERC-20 loan, or on a periodic cadence), and
    ///         `otherFree` reads 0 for a loan whose principal is not an ERC-20. An
    ///         extension draws only on the CURRENT borrower-position holder's
    ///         vault, so a reserve held by anyone else pays nothing until they
    ///         withdraw it. The charge is what leaves the holder's vault; the
    ///         lender and the treasury split it.
    function getExtendFunding(uint256 loanId, address holder)
        external
        view
        returns (
            address asset,
            uint256 reserved,
            uint256 otherFree,
            uint256 chargeNow,
            uint256 chargeAtGraceEnd
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        asset = loan.principalAsset;
        reserved = s.extendReserve[loanId][holder];
        // Only an ERC-20 principal has a fungible balance to read: a rental's
        // principal is the NFT contract, whose `balanceOf` takes a token id.
        bool erc20 = loan.assetType == LibVaipakam.AssetType.ERC20;
        address vault = s.userVaipakamVaults[holder];
        if (erc20 && vault != address(0) && asset != address(0)) {
            uint256 raw = IERC20(asset).balanceOf(vault);
            uint256 tracked = LibVaipakam.trackedHolding(holder, asset, 0);
            otherFree = LibEncumbrance.freeBalance(holder, asset, 0, tracked < raw ? tracked : raw);
        }
        if (
            loan.startTime != 0 &&
            loan.status == LibVaipakam.LoanStatus.Active &&
            erc20 &&
            loan.periodicInterestCadence == LibVaipakam.PeriodicInterestCadence.None
        ) {
            (uint256 i, uint256 f) = _extendChargeAt(loanId, loan, block.timestamp);
            chargeNow = i + f;
            (, uint256 closesAt) = _extendWindow(loan);
            uint256 at = closesAt > block.timestamp ? closesAt : block.timestamp;
            (i, f) = _extendChargeAt(loanId, loan, at);
            chargeAtGraceEnd = i + f;
        }
    }

    /// @dev The one statement of what an extension charges at `at` (#2814):
    ///      the interest the loan owes the lender side for the window being
    ///      closed, and the late fee. Read by the executor at `block.timestamp`
    ///      and by {getExtendFunding}.
    ///
    ///      Codex round-1 P1 — honor `loan.useFullTermInterest`: when the loan
    ///      was contracted with the full-term coupon, that is what the lender
    ///      is owed even at mid-loan settlement. Otherwise (the common
    ///      pro-rata case) Codex round-2 P2 needs SECONDS-based accrual rather
    ///      than days-flooring: extension at `startTime + 1d + 23h` pays the
    ///      full 1d23h, so a borrower-controlled keeper cannot extend just
    ///      before each daily boundary and erase ~23h of accrual every cycle.
    ///      #641 — interest reads the dedicated accrual clock (remaining term /
    ///      accrual origin), not the immutable term tuple, so a previously
    ///      partial-repaid or liquidated loan extends on its true remaining
    ///      accrual. Codex round-2 P1 — past the end time an extension is a
    ///      late rescue and owes the same late fee `RepayFacet` charges, so it
    ///      is no way to escape both the fee and the default path.
    function _extendChargeAt(uint256 loanId, LibVaipakam.Loan storage loan, uint256 at)
        private
        view
        returns (uint256 accruedInterest, uint256 lateFee)
    {
        // #3169 — the one settlement rule: per-second elapsed, with the
        // full-term minimum when the loan carries it. It priced the full-term
        // case at the minimum alone, which past maturity (the window runs to
        // the grace end) undercharged the time actually elapsed.
        accruedInterest = LibEntitlement.settlementInterest(loan, at);
        lateFee = LibVaipakam.calculateLateFeeAt(loanId, at);
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

        // `startTime == 0` is a loan id never opened: its zero status reads
        // as Active.
        if (loan.startTime == 0 || loan.status != LibVaipakam.LoanStatus.Active) {
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
        // #2407 — an extension rewrites the rate, term and accrual clock, and
        // so the payoff a standing refinance request was priced against.
        // Refused while a live request targets the loan, like the other
        // borrower-consented changes to it; the borrower cancels it first.
        LibRefinanceRequest.assertNone(loanId);
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
        // #2738 — the one extension window ({_extendWindow}): it opens
        // AUTO_EXTEND_WINDOW before the effective maturity (and never inside
        // the first day after the start, so accrual always lands before the
        // start is reset) and closes at the grace end.
        (uint256 windowOpensAt, uint256 graceEndNow) = _extendWindow(loan);
        if (block.timestamp < windowOpensAt) revert AutoExtendWindowNotOpen(windowOpensAt);
        // Codex round-4 P1 — refuse extension once the loan is past its
        // grace end. At that point `DefaultedFacet.triggerDefault` is the
        // lender's intended resolution and extension would let an
        // authorised keeper salvage a defaultable state.
        if (block.timestamp > graceEndNow) revert ExtensionGraceExpired();

        // ── Auth: keeper-side bit + Tier-1 sanctions on all parties ──
        // One verdict for "a keeper acted": it is charged here and rewarded
        // below. The holder's manager (the holder, or its controller once a
        // protected-account replacement retired it) is never a keeper.
        bool keeperActed = LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_EXTEND,
            loan,
            /* lenderSide */ false
        );
        // #3175 (owner decision 2026-11-05, "Free borrower") — the admin
        // auto-extend switch stops only the AUTOMATED extension, like the
        // auto-refinance switch: a keeper acting for the borrower is refused
        // while it is off, and the borrower-position holder extending
        // directly (within both sides' caps) is never blocked by it. A
        // defect in the extension itself is stopped by the global pause.
        if (keeperActed && !s.protocolCfg.cfgAutoExtendEnabled) revert AutoExtendDisabled();
        if (keeperActed) LibServiceCapacity.chargeKeeper(); // #1219 — one keeper action
        LibVaipakam._assertNotSanctioned(msg.sender);
        address borrowerNftOwner = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        address lenderNftOwner = LibPositionNFT.ownerOf(loan.lenderTokenId);
        LibVaipakam._assertNotSanctioned(borrowerNftOwner);
        LibVaipakam._assertNotSanctioned(lenderNftOwner);

        // ── Both-side cap consent + staleness fence ──────────────────
        LibVaipakam.AutoExtendCaps storage borrowerCaps =
            s.autoExtendBorrowerCaps[loanId];
        LibVaipakam.AutoExtendCaps storage lenderCaps =
            s.autoExtendLenderCaps[loanId];
        // A consent is fresh only while its setter still manages the holder,
        // so a replacement voids the caps the retired wallet set.
        bool borrowerFresh = borrowerCaps.setter == address(0) ||
            borrowerCaps.setter == LibProtectedAccount.manager(borrowerNftOwner);
        bool lenderFresh = lenderCaps.setter == address(0) ||
            lenderCaps.setter == LibProtectedAccount.manager(lenderNftOwner);
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
        uint256 oldEndTime = LibLoanClock.maturity(loan);
        if (newEndTimeUint <= oldEndTime) revert ExtensionMustExtend();
        // #2738 — and never make it defaultable sooner. The new term starts
        // now, so it carries no pause credit: its grace end is its end plus
        // the grace its new duration earns, and that must not fall before
        // the grace end the loan has today.
        uint256 newGraceEnd = newEndTimeUint + LibVaipakam.gracePeriod(newDurationDays);
        if (newGraceEnd < graceEndNow) revert ExtensionShortensGrace(newGraceEnd, graceEndNow);

        // ── Accrued-interest math + treasury / lender split ──────────
        // The charge is {_extendChargeAt}'s, the one rule the funding view
        // reads too: the closing window's interest plus any late fee, split
        // between the lender side and the treasury below.
        (uint256 accruedInterest, uint256 lateFee) = _extendChargeAt(loanId, loan, block.timestamp);
        if (accruedInterest + lateFee > 0) {
            // Codex round-1 P2 — use the protocol's
            // `cfgTreasuryFeeBps` (resolved via `splitTreasury`)
            // rather than the hardcoded `TREASURY_FEE_BPS`. Codex
            // round-6 P2 — split `interest + lateFee` so late fees
            // participate in the treasury cut, matching
            // `LibSettlement.computeRepayment` (`treasuryShare +
            // lenderShare == interest + lateFee`).
            uint256 totalInterestLike = accruedInterest + lateFee;
            (uint256 treasuryShare, uint256 lenderShare) =
                LibEntitlement.splitTreasury(loan, totalInterestLike);
            // Codex round-4 P2 — if the original lender has VPFI yield-
            // fee consent + sufficient vault VPFI, pay the treasury cut
            // in VPFI from the lender's vault and route 100% of the
            // interest+lateFee to the lender in the lending asset.
            // Mirrors RepayFacet / PrecloseFacet / RefinanceFacet.
            // Codex round-5 P1 — the VPFI-payment delivery must only ever debit
            // the vault of the party that RECEIVES the interest.
            //
            // #1392 — that requirement used to be met with a
            // `lenderNftOwner == loan.lender` guard, because the old resolve
            // helper keyed the consent read and the vault debit on the stored
            // `loan.lender` internally. This facet does not consolidate
            // `loan.lender`, so on a TRANSFERRED lender position the guard
            // failed and the discount was skipped entirely — meaning a lender
            // who had paid the `C*` Full tariff lost the `+10%` they bought,
            // purely because the position changed hands.
            //
            // The helper is now parameterized on an explicit settling lender, so
            // the correct fix is to key it on `lenderNftOwner` — exactly the
            // party `_routeInterest` pays below — and drop the guard. Safe on
            // both deliveries: the Full `+10%` slice is loan-scoped
            // (`feeEntitlementByLoanId[loan.id]`) and therefore holder-
            // independent, the hold tier is an instant per-address lookup so the
            // new holder's own tier applies, and any VPFI vault debit is gated
            // on THAT holder's own stored consent inside `quoteYieldFee` (a
            // non-consenting holder still receives the bump, via the
            // no-token-move direct-reduction path).
            //
            // Routed through the diamond-internal resolve host so the delivery
            // — and its analytics passthrough event, which this path previously
            // dropped — lives on one facet, matching every other settlement site
            // in the #1383 chain.
            {
                (uint256 lenderExtra, uint256 newTreasury) =
                    _hostResolveLenderYieldFee(
                        loanId,
                        lenderNftOwner,
                        totalInterestLike,
                        treasuryShare
                    );
                if (lenderExtra > 0) {
                    lenderShare += lenderExtra;
                    treasuryShare = newTreasury;
                }
            }
            _routeInterest(
                loan,
                borrowerNftOwner,
                lenderNftOwner,
                totalInterestLike,
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
        // Codex round-6 P2 — `LibInteractionRewards.registerLoan`
        // snapshots `(interestRateBps, durationDays)` into the per-
        // day reward accumulators at loan-init. Mutating them
        // without closing + re-registering would leave the old
        // accrual schedule running on a loan with new terms (wrong
        // per-day numeraire, wrong end day). Settle the old entry
        // as-of today and reopen with the new terms.
        //
        // Codex round-7 P2 — `borrowerClean` is true when extension
        // happens IN-TERM (before the original end time). In that
        // case the borrower paid all accrued interest as part of
        // this extension and keeps their accrued reward. After
        // `oldEndTime` (late but in-grace), `borrowerClean = false`
        // forfeits the borrower's accrued reward — matching the
        // `LibInteractionRewards.closeLoan` semantic for terminal
        // late-cure paths.
        //
        // Codex round-7 P2 — re-register against the CURRENT NFT
        // owners (borrowerNftOwner / lenderNftOwner), not the
        // original `loan.lender` / `loan.borrower`. After an NFT
        // transfer the new holders are the parties earning the
        // post-extension reward accrual.
        bool inTermExtension = block.timestamp <= oldEndTime;
        uint256 rewardResumeDay = LibInteractionRewards.closeLoanForContinuation(
            loanId,
            /* borrowerClean */ inTermExtension
        );
        // #1808 — the new rate goes through the ledger's single writer, which
        // checkpoints the old segment first, and BEFORE the new start time is
        // written: a ledger still unopened would otherwise open at the new start.
        LibInterestLedger.setRate(LibVaipakam.storageSlot(), loan, newRateBps);
        loan.startTime = uint64(block.timestamp);
        loan.durationDays = newDurationDays;
        // #641 — auto-refinance commits a NEW term; restart the interest-accrual
        // clock with it.
        loan.interestAccrualStart = uint64(block.timestamp);
        // Codex round-8 P2 — only re-register when the extension is
        // in-term. After `oldEndTime`, the borrower side is forfeited
        // and `loanBorrowerEntryId[loanId]` must stay pointed at the
        // closed entry so `sweepForfeitedInteractionRewards` can
        // route the abandoned rewards to treasury. `registerLoan`
        // overwrites both pointers — calling it on a late-extension
        // loan would break the sweep. Lender side is symmetric for
        // consistency (the lender wasn't forfeited, but skipping
        // the re-register simply means no extension-period rewards
        // for either side once the loan was in late territory — a
        // conservative outcome).
        if (inTermExtension) {
            // #3171 — the continuing entries resume where the closed ones
            // stopped (today, or tomorrow for a loan opened today).
            LibInteractionRewards.registerLoanFrom(
                loanId,
                lenderNftOwner,
                borrowerNftOwner,
                loan.principalAsset,
                loan.principal,
                uint256(newRateBps),
                newDurationDays,
                rewardResumeDay
            );
        }

        // #1384 — reprice the fee entitlement for the NEW term. The extension
        // pays no fresh Full `C*` tariff, so a lender who absorbed Full at
        // origination must not keep the `+10%` yield-fee bump (#1354) on the
        // un-tariffed added term — the reprice downgrades the lender Full stamp.
        // Runs UNCONDITIONALLY (not gated on `inTermExtension`): even a late
        // in-grace extension continues to accrue future interest the stale Full
        // stamp would discount. No-op on an unstamped / non-Full loan and while
        // the M2 fee package is dark. The loan-side reward-cap (lifetime,
        // per-loanId) and the borrower stamp are deliberately left intact.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                FeeEntitlementFacet.repriceFeeEntitlementOnExtension.selector,
                loanId
            ),
            FeeEntitlementRepriceFailed.selector
        );

        // #3413 — terms changed and accrued interest was paid out: the
        // loan's tokens cool down.
        LibPositionNFT.markLoanValueOut(loanId);

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
        // self-driven extend. The auth verdict above decides it, so the
        // holder's controller is excluded by the same rule as the holder.
        if (keeperActed) {
            LibKeeperReward.payVpfiReward(
                msg.sender,
                keccak256("extendLoanInPlace"),
                gasStart - gasleft()
            );
        }
    }

    /// @dev #1392 — resolve the lender yield-fee VPFI discount through the
    ///      diamond-internal `VPFIDiscountFacet.resolveLenderYieldFeeFor` host,
    ///      keyed on an explicit `settlingLender` (here: the current lender-NFT
    ///      holder, the party `_routeInterest` actually pays). The host also
    ///      emits the analytics passthrough, so indexers see this path's
    ///      discounts on the same facet as every other settlement site.
    ///
    ///      Short-circuits the ineligible/dark case with an INLINED eligibility
    ///      read (`consent OR Full`, no cross-facet routing), so an unstamped /
    ///      no-consent loan is a strict no-op that never routes to the host —
    ///      which also keeps this keeper-driven path from acquiring a routing
    ///      dependency on any loan that can't take a discount anyway.
    ///
    ///      Returns `(lenderExtra, newTreasury)`; add `lenderExtra` to the
    ///      lender share and replace the treasury share with `newTreasury`.
    function _hostResolveLenderYieldFee(
        uint256 loanId,
        address settlingLender,
        uint256 interestForQuote,
        uint256 treasuryShare
    ) private returns (uint256 lenderExtra, uint256 newTreasury) {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (
            treasuryShare == 0 ||
            !LibVPFIDiscount.lenderYieldFeeEligible(loan, settlingLender)
        ) {
            return (0, treasuryShare);
        }
        bytes memory ret = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                VPFIDiscountFacet.resolveLenderYieldFeeFor.selector,
                loanId,
                settlingLender,
                interestForQuote,
                treasuryShare
            ),
            bytes4(0)
        );
        (lenderExtra, newTreasury, ) = abi.decode(ret, (uint256, uint256, uint256));
    }

    /// @dev Moves accrued interest from the borrower-NFT owner's vault
    ///      to the lender side + treasury. Factored out so
    ///      {extendLoanInPlace} stays under viaIR's stack budget.
    ///      #1209 / #1808 — the open seller claims are paid first out of the
    ///      interest ({LibInterestLedger.paySellersFirst}); the lender-NFT
    ///      owner's vault receives the rest, recorded as paid to the holder.
    function _routeInterest(
        LibVaipakam.Loan storage loan,
        address borrowerNftOwner,
        address lenderNftOwner,
        uint256 interestGross,
        uint256 lenderShare,
        uint256 treasuryShare
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address principalAsset = loan.principalAsset;
        // 1. Withdraw the full accrued interest from the borrower's
        //    vault to the diamond itself. #2814 — the holder's reserve for
        //    this loan pays first (released here so the vault guard sees it
        //    free), then their other free balance; the event states the
        //    split. #2440 — a consented extension, not a forced close-out:
        //    refused unless all of it arrived, so the lender and the treasury
        //    are never paid out of the Diamond's other balance.
        uint256 charge = lenderShare + treasuryShare;
        {
            uint256 reserved = s.extendReserve[loan.id][borrowerNftOwner];
            uint256 fromReserve = reserved < charge ? reserved : charge;
            LibEncumbrance.unlienExtendReserve(loan.id, borrowerNftOwner, principalAsset, fromReserve);
            // The rest is the holder's other free vault balance: the depository
            // ledger (what of it they may withdraw) pays first.
            LibDepositoryLedger.spend(borrowerNftOwner, principalAsset, 0, charge - fromReserve);
            emit ExtendChargeDrawn(
                loan.id, borrowerNftOwner, principalAsset, fromReserve, charge - fromReserve, reserved - fromReserve
            );
        }
        LibVaultOutflow.toDiamondExact(borrowerNftOwner, principalAsset, charge, loan.id, OutflowReason.INTEREST);
        // 2. Forward treasury share + record accrual. #2440 — measured,
        //    accrued as it arrived (TreasuryFeeFacet).
        LibFacet.transferToTreasury(principalAsset, treasuryShare);
        // 3. Seller claims first, then the lender's vault.
        (uint256 sellersGross, uint256 sellersNet) = LibInterestLedger.paySellersFirst(
            s, loan, address(0), principalAsset, interestGross, lenderShare
        );
        uint256 holderShare = lenderShare - sellersNet;
        address lenderVault = LibFacet.getOrCreateVault(lenderNftOwner);
        if (holderShare > 0) {
            // #2440 — the extension re-terms the loan as if the lender received
            // all of `lenderShare`, and it is consented, not forced, so a short
            // arrival is refused like step 1's withdrawal.
            LibDelivery.pushExact(principalAsset, lenderVault, holderShare);
            LibVaipakam.recordVaultDeposit(lenderNftOwner, principalAsset, holderShare);
            // Paid outright to the holder (no claim row follows), so it is
            // theirs to withdraw.
            LibDepositoryLedger.credit(lenderNftOwner, principalAsset, 0, holderShare);
        }
        LibInterestLedger.holderPaid(s, loan, interestGross - sellersGross);
    }

}
