// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";
import {LibPausable} from "./LibPausable.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibProtectedAccount} from "./LibProtectedAccount.sol";
import {LibRefinanceRequest} from "./LibRefinanceRequest.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title LibStandingInstructions — the one-plan rule for a loan's due date (#3681).
 * @notice A loan's due date has at most one plan set by its borrower-position
 *         holder: the "repay at the due date" standing instruction, OR the
 *         automatic-extension / automatic-refinance limits. Whichever is set
 *         second is refused until the first is cleared. Each side asks this
 *         library about the other, so the rule is written once.
 * @dev    A setting counts only while the wallet that set it still holds the
 *         borrower position, matching the staleness fence the extension and
 *         refinance limits already apply on read.
 */
library LibStandingInstructions {
    // ─── The skip reasons every standing instruction reports ─────────
    // One list for the four instructions (#3681, #3752), so a reader of
    // `StandingInstructionSkipped` decodes `reason` the same whichever
    // facet emitted it.

    /// @notice The position is no longer held by the instruction's owner.
    uint8 internal constant SKIP_HOLDER_CHANGED = 1;
    /// @notice The reserve the instruction spends is empty.
    uint8 internal constant SKIP_RESERVE_EMPTY = 2;
    /// @notice The payment reserve is short of the full repayment.
    uint8 internal constant SKIP_RESERVE_SHORT = 3;
    /// @notice A preclose offset, a sale listing, a refinance request or a
    ///         swap-to-repay order is live on the loan.
    uint8 internal constant SKIP_LOAN_BUSY = 4;
    /// @notice The price or health factor could not be read.
    uint8 internal constant SKIP_PRICE_UNAVAILABLE = 5;
    /// @notice The platform or the asset is paused.
    uint8 internal constant SKIP_PAUSED = 6;
    /// @notice The owner's protected account is locked or was replaced.
    uint8 internal constant SKIP_ACCOUNT_LOCKED = 7;
    /// @notice The position moved and has not been consolidated into the new
    ///         holder's vault.
    uint8 internal constant SKIP_NOT_CONSOLIDATED = 8;
    /// @notice The payment's one attempt reverted, so nothing moved.
    uint8 internal constant SKIP_LEG_REFUSED = 9;
    /// @notice The reserve's owner is sanctions-flagged (the top-up only).
    uint8 internal constant SKIP_SANCTIONED = 10;
    /// @notice #3752 — the pair has moved past the calm bound against one of
    ///         the last two hourly checkpoints, and the holder kept the
    ///         calm-market wait.
    uint8 internal constant SKIP_NOT_CALM = 11;
    /// @notice #3752 — an hourly checkpoint the calm test needs is missing,
    ///         and the holder kept the calm-market wait.
    uint8 internal constant SKIP_NO_CHECKPOINT = 12;
    /// @notice #3752 — even the whole collateral, at the holder's tolerance,
    ///         cannot reach what the instruction must reach (the whole debt,
    ///         or the reduction's target).
    uint8 internal constant SKIP_CANNOT_COVER = 13;
    /// @notice #3752 — the holder's collateral top-up could run now and
    ///         would lift the health factor to the exit level, so it acts
    ///         first.
    uint8 internal constant SKIP_TOP_UP_FIRST = 14;

    /// @notice The governed least gap between two health-factor settings
    ///         (the top-up's trigger and target; the exit's level and the
    ///         top-up's trigger; the exit's level and a reduction's target).
    function cfgMargin(LibVaipakam.Storage storage s) internal view returns (uint64 v) {
        v = s.standingInstructionCfg.minMarginHf;
        if (v == 0) v = LibVaipakam.STANDING_MIN_MARGIN_HF_DEFAULT;
    }

    /// @notice The governed highest target health factor (the top-up's, and
    ///         a reduction's).
    function cfgTargetMax(LibVaipakam.Storage storage s) internal view returns (uint64 v) {
        v = s.standingInstructionCfg.targetMaxHf;
        if (v == 0) v = LibVaipakam.STANDING_TARGET_MAX_HF_DEFAULT;
    }

    /// @notice The governed least interval between two top-ups, and between
    ///         two reductions.
    function cfgInterval(LibVaipakam.Storage storage s) internal view returns (uint256 v) {
        v = s.standingInstructionCfg.topUpIntervalSeconds;
        if (v == 0) v = LibVaipakam.STANDING_TOPUP_INTERVAL_DEFAULT;
    }

    /// @notice #3752 — the order of the two health-factor instructions: a
    ///         loan carrying the collateral top-up (trigger `trigger`) and the
    ///         exit instruction (level `level`, and the level of a change
    ///         still waiting) for one holder needs `level + margin <= trigger`,
    ///         so the top-up, which keeps the position, acts first. Either
    ///         setter asks this rule of the other; 0 means "not set".
    function requireExitBelowTopUp(uint64 level, uint64 trigger, uint64 margin) internal pure {
        if (level == 0 || trigger == 0) return;
        if (uint256(level) + margin > trigger) revert IVaipakamErrors.ExitLevelNotBelowTopUp(level, trigger);
    }

    /// @notice The highest exit level `owner` has on `loanId`, live or
    ///         waiting (0 when none), for {requireExitBelowTopUp}.
    function exitLevelOf(LibVaipakam.Storage storage s, uint256 loanId, address owner)
        internal
        view
        returns (uint64 level)
    {
        LibVaipakam.ExitInstruction storage ex = s.exitInstructions[loanId];
        if (ex.owner != owner) return 0;
        if (ex.live.form != LibVaipakam.EXIT_FORM_NONE) level = ex.live.levelHf;
        if (ex.pendingAt != 0 && ex.pending.levelHf > level) level = ex.pending.levelHf;
    }

    /// @notice The skip reasons every instruction shares (StandingInstructions
    ///         design §4.4), in order; 0 when none applies.
    function commonSkip(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address holder,
        address asset
    ) internal view returns (uint8) {
        if (LibPositionNFT.ownerOf(loan.borrowerTokenId) != holder) return SKIP_HOLDER_CHANGED;
        if (LibPausable.paused() || LibFacet.isAssetPaused(asset)) return SKIP_PAUSED;
        LibProtectedAccount.Core memory c = LibProtectedAccount.core(holder);
        if (c.locked || c.retired) return SKIP_ACCOUNT_LOCKED;
        if (
            s.loanToOffsetOfferId[loanId] != 0 ||
            s.prepayListingOrderHash[loanId] != bytes32(0) ||
            s.intentCommits[loanId].orderHash != bytes32(0) ||
            LibRefinanceRequest.live(loanId) != 0
        ) return SKIP_LOAN_BUSY;
        return 0;
    }

    /// @dev Transient slots binding the next self-called repayment of one
    ///      loan to one holder's payment reserve (#3681).
    bytes32 private constant REPAY_LOAN_SLOT = keccak256("vaipakam.standingInstructions.reserveRepay.loan");
    bytes32 private constant REPAY_HOLDER_SLOT = keccak256("vaipakam.standingInstructions.reserveRepay.holder");

    /// @notice Bind the next self-called `RepayFacet.repayLoan(loanId)` in
    ///         this transaction to `holder`'s payment reserve as payer.
    /// @dev    `StandingInstructionFacet.runDueRepayment` binds, self-calls
    ///         the ordinary repayment, and the repayment consumes the binding
    ///         with {takeReserveRepayer}. One entry point and one body for
    ///         both payers: a second external entry into the repayment body
    ///         compiled the body twice and put RepayFacet over EIP-170.
    function bindReserveRepayer(uint256 loanId, address holder) internal {
        bytes32 a = REPAY_LOAN_SLOT;
        bytes32 b = REPAY_HOLDER_SLOT;
        assembly {
            tstore(a, loanId)
            tstore(b, holder)
        }
    }

    /// @notice The holder bound to repay `loanId` from its reserve, or zero
    ///         (the caller pays from its wallet). Clears the binding.
    function takeReserveRepayer(uint256 loanId) internal returns (address holder) {
        bytes32 a = REPAY_LOAN_SLOT;
        bytes32 b = REPAY_HOLDER_SLOT;
        uint256 bound;
        assembly {
            bound := tload(a)
        }
        if (bound != loanId) return address(0);
        assembly {
            holder := tload(b)
            tstore(a, 0)
            tstore(b, 0)
        }
    }

    /// @notice True when the holder's "repay at the due date" instruction
    ///         stands on `loan`.
    function repayAtDueLive(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan)
        internal
        view
        returns (bool)
    {
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loan.id];
        return si.repayAtDue && si.owner == LibPositionNFT.ownerOf(loan.borrowerTokenId);
    }

    /// @notice True when the holder's automatic-extension or
    ///         automatic-refinance limits stand on `loan`.
    function autoDueDatePlanLive(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan)
        internal
        view
        returns (bool)
    {
        address holder = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        LibVaipakam.AutoExtendCaps storage ext = s.autoExtendBorrowerCaps[loan.id];
        if (ext.enabled && ext.setter == holder) return true;
        LibVaipakam.AutoRefinanceCaps storage ref = s.autoRefinanceCaps[loan.id];
        return ref.enabled && ref.setter == holder;
    }
}
