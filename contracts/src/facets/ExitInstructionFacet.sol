// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibTerms} from "../libraries/LibTerms.sol";
import {LibPriceRead} from "../libraries/LibPriceRead.sol";
import {LibPairCalm} from "../libraries/LibPairCalm.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibSaleSizing} from "../libraries/LibSaleSizing.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibStandingInstructions} from "../libraries/LibStandingInstructions.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {SwapToRepayFacet} from "./SwapToRepayFacet.sol";
import {SwapToRepayPartialFacet} from "./SwapToRepayPartialFacet.sol";

/**
 * @title ExitInstructionFacet — sell and repay before liquidation (#3752).
 * @notice The fourth standing instruction on a loan. The holder of the
 *         borrower position chooses a health-factor LEVEL, a price TOLERANCE
 *         and one of two forms:
 *
 *         - CLOSE: when the health factor is below the level, sell the least
 *           collateral that repays the whole debt and close the loan
 *           ({runExit}). The manual full "repay with collateral" route does
 *           the sale and the settlement.
 *         - REDUCE: sell the least collateral that brings the health factor to
 *           the higher of the holder's target and the loan's opening
 *           loan-to-value limit, and keep the loan open ({runReduce}). The
 *           manual partial route does the sale and the settlement.
 *
 *         Anyone may run either. The caller supplies only the swap routes to
 *         try; the amount, the price floor and the settlement are fixed by
 *         the loan and the holder's settings, and the caller receives
 *         nothing: no bonus, no fee, no share of the sale. The sale must
 *         deliver at least the oracle value of what it sells less the
 *         holder's tolerance, which is never looser than the manual route's
 *         cap. Unless the holder switched the calm-market wait off, the run
 *         also waits until the pair is calm against the last two hourly price
 *         checkpoints (`LibPairCalm`, the forced-sale floor's bound); with the
 *         wait off the same read is still made and recorded, and the floor,
 *         the health test and the price guard's refusals still apply.
 *
 *         Everything the borrower side is left with is held for the borrower
 *         position exactly as the manual routes leave it (the unsold
 *         collateral on the borrower claim, proceeds above the debt on the
 *         position's surplus), for its holder to collect into their vault.
 *
 *         On a protected account a change that can sell more collateral or
 *         at a worse price (setting it, a higher level or target, a looser
 *         tolerance, the fast-market switch on, a different form) waits the
 *         account's delay, and the old settings run until it ends; a change
 *         that can only lessen either is immediate.
 *
 *         When it cannot run for a reason the holder should hear about, the
 *         executor emits `StandingInstructionSkipped` (instruction
 *         {INSTRUCTION_EXIT}) with a reason from `LibStandingInstructions`
 *         and changes nothing. When it is simply not time (not set, health
 *         at or above the level, too soon after the last reduction, past the
 *         end of grace), it reverts by name.
 *
 * @dev    Design: `docs/DesignsAndPlans/ExitBeforeLiquidationDesign.md`.
 *         Its own facet: it compiles to about 20 KB, and
 *         `StandingInstructionFacet` has about 5 KB of EIP-170 room. The sale and settlement are the manual routes' own bodies,
 *         reached through `SwapToRepayFacet.swapToRepayFullByInstruction` and
 *         `SwapToRepayPartialFacet.swapToRepayPartialByInstruction`
 *         (`address(this)`-gated). **Refreshed together with both
 *         swap-to-repay facets and StandingInstructionFacet** (the shared
 *         skip rule and the top-up ordering).
 */
contract ExitInstructionFacet is DiamondAccessControl, DiamondReentrancyGuard {
    // ─── Types ───────────────────────────────────────────────────────

    /// @notice The holder's settings, as {setExitInstruction} takes them.
    /// @param form            `EXIT_FORM_CLOSE` (1) or `EXIT_FORM_REDUCE` (2).
    /// @param actInFastMarket Switch the calm-market wait off (off by default).
    /// @param toleranceBps    How far below the oracle value the sale may fill;
    ///                        0 takes the default (1%).
    /// @param levelHf         1e18 health factor below which it runs.
    /// @param targetHf        1e18 health factor a reduction restores; ignored
    ///                        for a close.
    struct ExitInput {
        uint8 form;
        bool actInFastMarket;
        uint16 toleranceBps;
        uint64 levelHf;
        uint64 targetHf;
    }

    /// @notice What a run would do now, as {previewExit} reports it.
    /// @param set            An instruction is in force on the loan.
    /// @param due            It would run now (the run reverts or skips
    ///                       otherwise).
    /// @param skip           The reason it would be skipped now (0 = none).
    /// @param form           The form that would run: a reduction that would
    ///                       retire the whole principal closes the loan instead.
    /// @param healthFactor   The health factor now (0 when unreadable).
    /// @param collateralToSell The collateral the sale would sell (0 when
    ///                       skipped).
    /// @param minProceeds    The least a route must deliver for it.
    /// @param debtToPay      A close: the whole debt. A reduction: the accrued
    ///                       interest plus the least principal the floor
    ///                       retires.
    /// @param calm           The calm rule's answer now: 0 calm, 1 a checkpoint
    ///                       missing, 2 moving, 3 not read (a price missing).
    /// @param waitOff        The holder switched the calm-market wait off.
    /// @param targetUsed     A reduction: the health factor it sizes to.
    /// @param targetIsLtvCap A reduction: true when that figure is the health
    ///                       factor at the loan's opening loan-to-value limit
    ///                       rather than the holder's target.
    /// @param toleranceBps   The tolerance the run uses (the holder's, never
    ///                       above the manual route's cap).
    /// @param notBefore      A reduction: the earliest time the next one may
    ///                       run (0 = no wait).
    struct ExitPreview {
        bool set;
        bool due;
        uint8 skip;
        uint8 form;
        uint256 healthFactor;
        uint256 collateralToSell;
        uint256 minProceeds;
        uint256 debtToPay;
        uint8 calm;
        bool waitOff;
        uint64 targetUsed;
        bool targetIsLtvCap;
        uint16 toleranceBps;
        uint64 notBefore;
    }

    /// @notice One loan's exit instruction as stored, with the settings in
    ///         force now (a waiting change whose time has come counts).
    struct ExitInstructionView {
        LibVaipakam.ExitInstruction record;
        LibVaipakam.ExitSettings inForce;
        bool ownerHoldsPosition;
    }

    /// @notice The governed bounds, resolved (0 fields read as defaults).
    struct ExitConfigView {
        uint64 levelMinHf;
        uint64 levelMaxHf;
        uint16 toleranceMinBps;
        uint16 toleranceMaxBps;
        uint16 toleranceDefaultBps;
        uint64 targetMaxHf;
        uint64 minMarginHf;
        uint256 reduceIntervalSeconds;
    }

    /// @dev The figures a run is decided on, read once.
    struct Plan {
        uint8 skip;
        uint8 form;
        uint8 calm;
        uint256 hf;
        uint256 sell;
        uint256 floor;
        uint256 debt;
        uint64 targetUsed;
        bool targetIsLtvCap;
        uint16 tolerance;
    }

    // ─── Events ──────────────────────────────────────────────────────

    /// @notice The exit instruction for `loanId` now in force for `owner`.
    /// @custom:event-category state-change/loan-mutation
    event ExitInstructionSet(
        uint256 indexed loanId, address indexed owner, address setBy, LibVaipakam.ExitSettings settings
    );

    /// @notice A change that waits out `owner`'s protected delay: `settings`
    ///         replace the ones in force from `effectiveAt`. The settings in
    ///         force run until then.
    /// @custom:event-category state-change/loan-mutation
    event ExitInstructionChangeQueued(
        uint256 indexed loanId,
        address indexed owner,
        address setBy,
        LibVaipakam.ExitSettings settings,
        uint64 effectiveAt
    );

    /// @notice The exit instruction for `loanId` was cleared, with any change
    ///         that was waiting.
    /// @custom:event-category state-change/loan-mutation
    event ExitInstructionCleared(uint256 indexed loanId, address indexed owner, address by);

    /// @notice A close ran: the loan was repaid in full from its collateral
    ///         and closed. The manual full route's `SwapToRepayExecuted`,
    ///         `LoanRepaid` and claim events carry the settlement.
    /// @param hfBefore           The health factor before (1e18).
    /// @param levelHf            The holder's level.
    /// @param collateralSold     Collateral the sale consumed.
    /// @param proceeds           What the sale delivered.
    /// @param debtPaid           The debt repaid.
    /// @param surplus            Proceeds above the debt, held for the
    ///                           borrower position.
    /// @param collateralReleased Collateral left, held for the borrower
    ///                           position.
    /// @param waitOff            The holder had switched the calm wait off.
    /// @param calm               The calm rule's answer as read: 0 calm, 1 a
    ///                           checkpoint missing, 2 moving.
    /// @custom:event-category state-change/loan-mutation
    event ExitInstructionRun(
        uint256 indexed loanId,
        address indexed holder,
        uint256 hfBefore,
        uint64 levelHf,
        uint256 collateralSold,
        uint256 proceeds,
        uint256 debtPaid,
        uint256 surplus,
        uint256 collateralReleased,
        address caller,
        bool waitOff,
        uint8 calm
    );

    /// @notice A reduction ran: the loan stays open. The manual partial
    ///         route's `SwapToRepayPartialExecuted` carries the settlement.
    /// @param targetUsed       The health factor it was sized to.
    /// @param targetIsLtvCap   That figure was the opening loan-to-value
    ///                         limit's, not the holder's target.
    /// @param principalRetired Principal the repayment retired.
    /// @custom:event-category state-change/loan-mutation
    event ExitReductionRun(
        uint256 indexed loanId,
        address indexed holder,
        uint256 hfBefore,
        uint256 hfAfter,
        uint64 levelHf,
        uint64 targetUsed,
        bool targetIsLtvCap,
        uint256 collateralSold,
        uint256 proceeds,
        uint256 principalRetired,
        address caller,
        bool waitOff,
        uint8 calm
    );

    /// @notice Declared identically on `StandingInstructionFacet` (one topic):
    ///         an instruction could not run and changed nothing. Reasons are
    ///         the `SKIP_*` list in `LibStandingInstructions`.
    /// @custom:event-category informational/notification
    event StandingInstructionSkipped(
        uint256 indexed loanId,
        uint8 indexed instruction,
        uint8 reason,
        uint256 missing,
        address caller
    );

    /// @notice The governed bounds changed.
    /// @custom:event-category informational/config
    event ExitInstructionConfigSet(uint64 levelMinHf, uint64 levelMaxHf, uint16 toleranceMinBps);

    // ─── Constants ───────────────────────────────────────────────────

    /// @notice The instruction number in `StandingInstructionSkipped` (the
    ///         three of `StandingInstructionFacet` are 1 to 3).
    uint8 internal constant INSTRUCTION_EXIT = 4;

    uint8 private constant CALM_NOT_READ = 3;
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS_TO_WAD = 1e14;
    /// @dev How many times a reduction's sale may be stepped up (doubling
    ///      each time) before the run reports it cannot be sized.
    uint256 private constant REDUCE_STEP_LIMIT = 48;

    // ─── Errors ──────────────────────────────────────────────────────

    error ExitInstructionNotOffered(uint256 loanId);
    error ExitFormInvalid(uint8 form);
    error ExitLevelOutOfBounds(uint64 levelHf, uint64 minHf, uint64 maxHf);
    error ExitTargetOutOfBounds(uint64 targetHf, uint64 minHf, uint64 maxHf);
    error ExitToleranceOutOfBounds(uint16 toleranceBps, uint16 minBps, uint16 maxBps);
    /// @notice Setting it would let it run at once: the health factor is
    ///         already below the level. The manual routes serve that case.
    error ExitLevelAboveHealth(uint256 healthFactor, uint64 levelHf);
    error ExitHealthUnreadable(uint256 loanId);
    error ExitInstructionNotSet(uint256 loanId, uint8 form);
    error ExitHealthAtOrAboveLevel(uint256 loanId, uint256 healthFactor, uint64 levelHf);
    error ExitWindowClosed(uint256 loanId);
    error ExitReduceTooSoon(uint256 loanId, uint256 nextAt);
    error ExitInstructionConfigInvalid();

    // ─── Settings ────────────────────────────────────────────────────

    /// @notice Set `loanId`'s exit instruction for its current borrower-
    ///         position holder. The caller is that holder's manager.
    /// @dev    Refused where the matching manual route could not run on the
    ///         loan (not ERC-20 on both legs, not both liquid; a reduction
    ///         where the loan does not allow partial repayment), for a holder
    ///         on the lender side of the loan, for a flagged caller or holder,
    ///         while the health factor is already below the level, and while
    ///         the holder's collateral top-up would not act first. On a
    ///         protected account a change that loosens (see the contract
    ///         notice) waits the account's delay; one that does not applies
    ///         now and drops any change that was waiting.
    function setExitInstruction(uint256 loanId, ExitInput calldata cfg) external nonReentrant {
        LibPausable.requireNotPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        LibAuth.requirePositionManager(loan.borrowerTokenId);
        // #3734 — a standing instruction is a standing commitment.
        LibTerms.requireCurrent(msg.sender);
        address owner = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam._assertNotSanctioned(owner);
        LibAuth.requireNotLenderSide(loan, owner);

        LibVaipakam.ExitSettings memory next = _validated(s, loanId, loan, cfg);
        (bool ok, uint256 hf) = _healthFactor(loanId);
        if (!ok) revert ExitHealthUnreadable(loanId);
        if (hf < next.levelHf) revert ExitLevelAboveHealth(hf, next.levelHf);
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        if (si.owner == owner) {
            LibStandingInstructions.requireExitBelowTopUp(
                next.levelHf, si.topUpTriggerHf, LibStandingInstructions.cfgMargin(s)
            );
        }

        LibVaipakam.ExitInstruction storage ex = s.exitInstructions[loanId];
        _promote(ex);
        if (ex.owner != owner) {
            delete s.exitInstructions[loanId];
            ex.owner = owner;
        }
        uint32 delay = _delayOf(owner);
        if (delay != 0 && _loosens(ex.live, next)) {
            uint64 at = uint64(block.timestamp + delay);
            ex.pending = next;
            ex.pendingAt = at;
            emit ExitInstructionChangeQueued(loanId, owner, msg.sender, next, at);
        } else {
            ex.live = next;
            delete ex.pending;
            ex.pendingAt = 0;
            emit ExitInstructionSet(loanId, owner, msg.sender, next);
        }
    }

    /// @notice Clear `loanId`'s exit instruction and any change waiting.
    ///         Immediate. The caller manages the instruction's owner or the
    ///         current borrower-position holder.
    function clearExitInstruction(uint256 loanId) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address owner = s.exitInstructions[loanId].owner;
        if (owner == address(0)) revert ExitInstructionNotSet(loanId, 0);
        if (msg.sender != LibProtectedAccount.manager(owner)) {
            LibAuth.requirePositionManager(s.loans[loanId].borrowerTokenId);
        }
        delete s.exitInstructions[loanId];
        emit ExitInstructionCleared(loanId, owner, msg.sender);
    }

    // ─── Executors (permissionless) ──────────────────────────────────

    /// @notice Close the loan from its collateral on the holder's instruction:
    ///         below the level, sell the least collateral whose value less the
    ///         holder's tolerance repays the whole debt, through the first of
    ///         `adapterCalls` that delivers that floor. The caller receives
    ///         nothing.
    /// @param validUntil The caller's deadline, as on the manual route.
    function runExit(uint256 loanId, LibSwap.AdapterCall[] calldata adapterCalls, uint64 validUntil)
        external
        nonReentrant
    {
        (LibVaipakam.ExitInstruction storage ex, LibVaipakam.Loan storage loan) =
            _openForRun(loanId, LibVaipakam.EXIT_FORM_CLOSE);
        Plan memory p = _plan(loanId, loan, ex);
        if (p.skip != 0) {
            emit StandingInstructionSkipped(loanId, INSTRUCTION_EXIT, p.skip, 0, msg.sender);
            return;
        }
        if (p.hf >= ex.live.levelHf) revert ExitHealthAtOrAboveLevel(loanId, p.hf, ex.live.levelHf);
        _close(loanId, loan, ex, p, adapterCalls, validUntil);
    }

    /// @notice Reduce the loan from its collateral on the holder's
    ///         instruction: below the level, sell the least collateral that
    ///         brings the health factor to the higher of the holder's target
    ///         and the loan's opening loan-to-value limit, at least the loan's
    ///         smallest partial repayment, and keep the loan open. A
    ///         reduction that would retire the whole principal closes the loan
    ///         as {runExit} does. At most once per configured interval. The
    ///         caller receives nothing.
    function runReduce(uint256 loanId, LibSwap.AdapterCall[] calldata adapterCalls, uint64 validUntil)
        external
        nonReentrant
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (LibVaipakam.ExitInstruction storage ex, LibVaipakam.Loan storage loan) =
            _openForRun(loanId, LibVaipakam.EXIT_FORM_REDUCE);
        if (ex.lastReduceAt != 0) {
            uint256 nextAt = uint256(ex.lastReduceAt) + LibStandingInstructions.cfgInterval(s);
            if (block.timestamp < nextAt) revert ExitReduceTooSoon(loanId, nextAt);
        }
        Plan memory p = _plan(loanId, loan, ex);
        if (p.skip != 0) {
            emit StandingInstructionSkipped(loanId, INSTRUCTION_EXIT, p.skip, 0, msg.sender);
            return;
        }
        if (p.hf >= ex.live.levelHf) revert ExitHealthAtOrAboveLevel(loanId, p.hf, ex.live.levelHf);
        if (p.form == LibVaipakam.EXIT_FORM_CLOSE) {
            _close(loanId, loan, ex, p, adapterCalls, validUntil);
            return;
        }
        ex.lastReduceAt = uint64(block.timestamp);
        address holder = ex.owner;
        (uint256 sold, uint256 proceeds, uint256 retired) = abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeCall(
                    SwapToRepayPartialFacet.swapToRepayPartialByInstruction,
                    (loanId, holder, p.sell, adapterCalls, p.tolerance, validUntil)
                ),
                bytes4(0)
            ),
            (uint256, uint256, uint256)
        );
        (, uint256 hfAfter) = _healthFactor(loanId);
        emit ExitReductionRun(
            loanId,
            holder,
            p.hf,
            hfAfter,
            ex.live.levelHf,
            p.targetUsed,
            p.targetIsLtvCap,
            sold,
            proceeds,
            retired,
            msg.sender,
            ex.live.actInFastMarket,
            p.calm
        );
    }

    // ─── Views ───────────────────────────────────────────────────────

    /// @notice What a run would do on `loanId` now: whether it is due, the
    ///         skip reason, the amount to sell and the least proceeds a route
    ///         must deliver, the calm answer, and for a reduction which target
    ///         applies. The keeper quotes from it; the app shows it.
    function previewExit(uint256 loanId) external view returns (ExitPreview memory v) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.ExitInstruction memory ex = s.exitInstructions[loanId];
        LibVaipakam.ExitSettings memory st = _inForce(ex);
        if (st.form == LibVaipakam.EXIT_FORM_NONE || loan.status != LibVaipakam.LoanStatus.Active) return v;
        v.set = true;
        v.waitOff = st.actInFastMarket;
        if (st.form == LibVaipakam.EXIT_FORM_REDUCE && ex.lastReduceAt != 0) {
            v.notBefore = uint64(uint256(ex.lastReduceAt) + LibStandingInstructions.cfgInterval(s));
        }
        Plan memory p = _planFor(s, loanId, loan, ex.owner, st);
        v.skip = p.skip;
        v.form = p.form;
        v.calm = p.calm;
        v.healthFactor = p.hf;
        v.collateralToSell = p.sell;
        v.minProceeds = p.floor;
        v.debtToPay = p.debt;
        v.targetUsed = p.targetUsed;
        v.targetIsLtvCap = p.targetIsLtvCap;
        v.toleranceBps = p.tolerance;
        v.due = p.skip == 0 && p.hf != 0 && p.hf < st.levelHf && block.timestamp <= LibLoanClock.graceEnd(loan)
            && block.timestamp >= v.notBefore;
    }

    /// @notice `loanId`'s exit instruction as stored, the settings in force
    ///         now, and whether its owner still holds the borrower position.
    function getExitInstruction(uint256 loanId) external view returns (ExitInstructionView memory v) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        v.record = s.exitInstructions[loanId];
        v.inForce = _inForce(v.record);
        v.ownerHoldsPosition = v.record.owner != address(0)
            && LibPositionNFT.ownerOf(s.loans[loanId].borrowerTokenId) == v.record.owner;
    }

    /// @notice The governed bounds, resolved.
    function getExitInstructionConfig() external view returns (ExitConfigView memory c) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (c.levelMinHf, c.levelMaxHf) = _levelBounds(s);
        c.toleranceMinBps = _toleranceMin(s);
        c.toleranceMaxBps = uint16(LibVaipakam.cfgMaxSwapToRepaySlippageBps());
        c.toleranceDefaultBps = LibVaipakam.EXIT_TOLERANCE_DEFAULT_BPS;
        c.targetMaxHf = LibStandingInstructions.cfgTargetMax(s);
        c.minMarginHf = LibStandingInstructions.cfgMargin(s);
        c.reduceIntervalSeconds = LibStandingInstructions.cfgInterval(s);
    }

    /// @notice Set the governed bounds (0 = default). The level stays above
    ///         1.0 and at most 2.0, the least tolerance at least 0.1%.
    function setExitInstructionConfig(LibVaipakam.ExitInstructionConfig calldata c)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        uint64 lo = c.levelMinHf == 0 ? LibVaipakam.EXIT_LEVEL_MIN_HF_DEFAULT : c.levelMinHf;
        uint64 hi = c.levelMaxHf == 0 ? LibVaipakam.EXIT_LEVEL_MAX_HF_DEFAULT : c.levelMaxHf;
        uint16 tol = c.toleranceMinBps == 0 ? LibVaipakam.EXIT_TOLERANCE_MIN_BPS_DEFAULT : c.toleranceMinBps;
        if (
            lo <= LibVaipakam.STANDING_HF_FLOOR || hi > LibVaipakam.EXIT_LEVEL_CEILING || lo > hi
                || tol < LibVaipakam.EXIT_TOLERANCE_MIN_FLOOR_BPS || tol > LibVaipakam.EXIT_TOLERANCE_DEFAULT_BPS
        ) revert ExitInstructionConfigInvalid();
        LibVaipakam.storageSlot().exitInstructionCfg = c;
        emit ExitInstructionConfigSet(c.levelMinHf, c.levelMaxHf, c.toleranceMinBps);
    }

    // ─── Internals ───────────────────────────────────────────────────

    /// @dev The checks every run makes before it is planned: the instruction
    ///      of `form` is in force (a waiting change whose time has come is
    ///      applied first), the loan is Active and inside its repayment
    ///      window.
    function _openForRun(uint256 loanId, uint8 form)
        private
        returns (LibVaipakam.ExitInstruction storage ex, LibVaipakam.Loan storage loan)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        ex = s.exitInstructions[loanId];
        _promote(ex);
        if (ex.live.form != form) revert ExitInstructionNotSet(loanId, form);
        loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        if (block.timestamp > LibLoanClock.graceEnd(loan)) revert ExitWindowClosed(loanId);
    }

    /// @dev The close: the manual full route on the holder's instruction.
    function _close(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        LibVaipakam.ExitInstruction storage ex,
        Plan memory p,
        LibSwap.AdapterCall[] calldata adapterCalls,
        uint64 validUntil
    ) private {
        address holder = ex.owner;
        uint256 collateralBefore = loan.collateralAmount;
        (uint256 sold, uint256 proceeds, uint256 debtPaid) = abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeCall(
                    SwapToRepayFacet.swapToRepayFullByInstruction,
                    (loanId, holder, adapterCalls, p.tolerance, validUntil)
                ),
                bytes4(0)
            ),
            (uint256, uint256, uint256)
        );
        emit ExitInstructionRun(
            loanId,
            holder,
            p.hf,
            ex.live.levelHf,
            sold,
            proceeds,
            debtPaid,
            proceeds - debtPaid,
            collateralBefore - sold,
            msg.sender,
            ex.live.actInFastMarket,
            p.calm
        );
    }

    function _plan(uint256 loanId, LibVaipakam.Loan storage loan, LibVaipakam.ExitInstruction storage ex)
        private
        view
        returns (Plan memory)
    {
        return _planFor(LibVaipakam.storageSlot(), loanId, loan, ex.owner, ex.live);
    }

    /// @dev Everything a run is decided on, in the order the skip reasons
    ///      apply: the shared skip rule, the price, the calm rule, the
    ///      top-up acting first, then the sizing. The health test against the
    ///      level is the caller's (a revert, not a skip).
    function _planFor(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address holder,
        LibVaipakam.ExitSettings memory st
    ) private view returns (Plan memory p) {
        p.form = st.form;
        p.calm = CALM_NOT_READ;
        uint256 cap = LibVaipakam.cfgMaxSwapToRepaySlippageBps();
        p.tolerance = st.toleranceBps > cap ? uint16(cap) : st.toleranceBps;
        p.skip = LibStandingInstructions.commonSkip(s, loanId, loan, holder, loan.collateralAsset);
        if (p.skip == 0 && LibFacet.isAssetPaused(loan.principalAsset)) p.skip = LibStandingInstructions.SKIP_PAUSED;
        bool ok;
        (ok, p.hf) = _healthFactor(loanId);
        (bool okC, uint256 pC) = LibPairCalm.price1e18(loan.collateralAsset);
        (bool okP, uint256 pP) = LibPairCalm.price1e18(loan.principalAsset);
        if (!ok || !okC || !okP) {
            if (p.skip == 0) p.skip = LibStandingInstructions.SKIP_PRICE_UNAVAILABLE;
            return p;
        }
        LibPairCalm.Calm calm = LibPairCalm.calmNow(
            loan.collateralAsset, loan.principalAsset, pC, pP, LibVaipakam.cfgSaleFloor().calmMoveBps
        );
        p.calm = uint8(calm);
        if (p.skip == 0 && !st.actInFastMarket) {
            if (calm == LibPairCalm.Calm.Moving) p.skip = LibStandingInstructions.SKIP_NOT_CALM;
            else if (calm == LibPairCalm.Calm.NoCheckpoint) p.skip = LibStandingInstructions.SKIP_NO_CHECKPOINT;
        }
        if (p.skip == 0 && _topUpActsFirst(s, loanId, loan, holder, p.hf, st.levelHf)) {
            p.skip = LibStandingInstructions.SKIP_TOP_UP_FIRST;
        }
        if (p.skip != 0) return p;

        LibFallback.Rate memory rate = LibFallback.oracleRate(address(this), loan.collateralAsset, loan.principalAsset);
        if (p.form == LibVaipakam.EXIT_FORM_REDUCE) _sizeReduce(s, loan, st, rate, p);
        if (p.form == LibVaipakam.EXIT_FORM_CLOSE) _sizeClose(loanId, loan, rate, p);
    }

    /// @dev A close: the least collateral whose floor covers the whole debt
    ///      the manual full route charges now (`LibSettlement`, the route's
    ///      own plan), sized by the route's own rule (`LibSaleSizing`).
    function _sizeClose(uint256 loanId, LibVaipakam.Loan storage loan, LibFallback.Rate memory rate, Plan memory p)
        private
        view
    {
        LibSettlement.ERC20Settlement memory plan =
            LibSettlement.computeRepayment(loan, LibVaipakam.calculateLateFee(loanId), block.timestamp);
        p.debt = plan.lenderDue + plan.treasuryShare;
        bool covers;
        (covers, p.sell, p.floor) = LibSaleSizing.sizeSaleAtRate(rate, p.debt, loan.collateralAmount, p.tolerance);
        if (!covers) {
            (p.sell, p.floor) = (0, 0);
            p.skip = LibStandingInstructions.SKIP_CANNOT_COVER;
        }
    }

    /// @dev A reduction. With `r` the loan's debt over its collateral value,
    ///      `L` its liquidation threshold, `t` the tolerance and `H` the health
    ///      factor to reach, selling a fraction `f` of the collateral and
    ///      repaying with the floor of its value gives
    ///      `HF = L(1-f) / (r - f(1-t))`, so the least fraction is
    ///      `f = (H·r - L) / (H(1-t) - L)`. `H` is the higher of the holder's
    ///      target and `L / c`, the health factor at the opening loan-to-value
    ///      limit `c` (the partial route refuses a result above that limit).
    ///      `r` is taken as `L / hf`: the health factor rounds down, so `r`
    ///      reads high and the sale errs larger, the safe side. The sale is at
    ///      least the loan's smallest partial repayment plus the accrued
    ///      interest (paid first). Where the oracle value of the sale would
    ///      cover the interest and the whole principal, the partial route
    ///      would refuse it, so the plan becomes a close.
    function _sizeReduce(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        LibVaipakam.ExitSettings memory st,
        LibFallback.Rate memory rate,
        Plan memory p
    ) private view {
        uint256 L = uint256(loan.liquidationLtvBpsAtInit) * BPS_TO_WAD;
        uint256 c = LibVaipakam.effectiveLoanInitLtvCapBps(
            loan.initLtvCapBpsAtInit, LibVaipakam.assetInitLtvCeilingBps(loan.collateralAsset)
        ) * BPS_TO_WAD;
        uint256 h = st.targetHf;
        if (c != 0) {
            uint256 hAtCap = Math.mulDiv(L, WAD, c, Math.Rounding.Ceil);
            if (hAtCap > h) (h, p.targetIsLtvCap) = (hAtCap, true);
        }
        p.targetUsed = h > type(uint64).max ? type(uint64).max : uint64(h);
        uint256 r = Math.mulDiv(L, WAD, p.hf, Math.Rounding.Ceil);
        uint256 hr = Math.mulDiv(h, r, WAD, Math.Rounding.Ceil);
        uint256 hk = Math.mulDiv(h, WAD - uint256(p.tolerance) * BPS_TO_WAD, WAD);
        if (hk <= L) {
            p.skip = LibStandingInstructions.SKIP_CANNOT_COVER;
            return;
        }
        uint256 f = hr > L ? Math.mulDiv(hr - L, WAD, hk - L, Math.Rounding.Ceil) : 0;
        if (f >= WAD) {
            p.skip = LibStandingInstructions.SKIP_CANNOT_COVER;
            return;
        }
        uint256 sell = Math.mulDiv(loan.collateralAmount, f, WAD, Math.Rounding.Ceil);

        // The smallest partial repayment, after the interest it pays first.
        (uint256 interest,) = LibEntitlement.splitSettledInterest(
            loan, LibEntitlement.accruedInterestToTime(loan, block.timestamp)
        );
        uint256 minPartial = (loan.principal * s.assetRiskParams[loan.principalAsset].minPartialBps)
            / LibVaipakam.BASIS_POINTS;
        if (minPartial == 0) minPartial = 1;
        (bool covers, uint256 least,) =
            LibSaleSizing.sizeSaleAtRate(rate, interest + minPartial, loan.collateralAmount, p.tolerance);
        if (!covers) {
            p.skip = LibStandingInstructions.SKIP_CANNOT_COVER;
            return;
        }
        if (least > sell) sell = least;

        // The closed form works in continuous value; the route settles in
        // whole token units, flooring the oracle conversion and the
        // tolerance. Check the candidate against those rounded figures and
        // step it up until the result is back inside the opening limit.
        if (c != 0) {
            uint256 capBps = c / BPS_TO_WAD;
            uint256 step = 1;
            for (uint256 i; !_reduceWithinCap(loan, rate, sell, p.tolerance, interest, capBps); ++i) {
                if (i == REDUCE_STEP_LIMIT || sell + step >= loan.collateralAmount) {
                    p.skip = LibStandingInstructions.SKIP_CANNOT_COVER;
                    return;
                }
                sell += step;
                step <<= 1;
            }
        }

        if (LibFallback.toPrincipal(rate, sell) >= interest + loan.principal) {
            // It would retire the whole principal: close instead.
            p.form = LibVaipakam.EXIT_FORM_CLOSE;
            p.targetUsed = 0;
            p.targetIsLtvCap = false;
            _sizeClose(loan.id, loan, rate, p);
            return;
        }
        p.sell = sell;
        p.floor = LibSaleSizing.floorAtRate(rate, sell, p.tolerance);
        p.debt = p.floor > interest ? p.floor : interest;
    }

    /// @dev True when selling `sell` and repaying exactly its floor (interest
    ///      first, then principal) leaves the loan-to-value at or under
    ///      `capBps`, with every figure rounded against the holder: the floor
    ///      and the remaining collateral's value down, the ratio up. A sale
    ///      whose floor would retire the whole principal counts as within (the
    ///      caller turns it into a close).
    function _reduceWithinCap(
        LibVaipakam.Loan storage loan,
        LibFallback.Rate memory rate,
        uint256 sell,
        uint256 tolerance,
        uint256 interest,
        uint256 capBps
    ) private view returns (bool) {
        uint256 floor = LibSaleSizing.floorAtRate(rate, sell, tolerance);
        if (floor <= interest) return false;
        uint256 retired = floor - interest;
        if (retired >= loan.principal) return true;
        uint256 value = LibFallback.toPrincipal(rate, loan.collateralAmount - sell);
        if (value == 0) return false;
        return Math.mulDiv(loan.principal - retired, LibVaipakam.BASIS_POINTS, value, Math.Rounding.Ceil) <= capBps;
    }

    /// @dev True when the holder's collateral top-up could run now and would
    ///      lift the health factor to `level` or above, so it acts first.
    function _topUpActsFirst(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address holder,
        uint256 hf,
        uint64 level
    ) private view returns (bool) {
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        if (si.owner != holder || si.topUpTriggerHf == 0 || hf >= si.topUpTriggerHf || hf == 0) return false;
        if (si.lastTopUpAt != 0 && block.timestamp < uint256(si.lastTopUpAt) + LibStandingInstructions.cfgInterval(s)) {
            return false;
        }
        if (LibVaipakam.isSanctionedAddress(holder)) return false;
        uint256 reserve = s.collateralReserve[loanId][holder];
        uint256 collateral = loan.collateralAmount;
        if (reserve == 0 || collateral == 0) return false;
        // The top-up's own sizing (`StandingInstructionFacet._topUpAmount`):
        // the health factor is proportional to the collateral.
        uint256 target = si.topUpTargetHf;
        uint256 amount = target > hf ? (collateral * (target - hf) + hf - 1) / hf : 0;
        if (amount > reserve) amount = reserve;
        return Math.mulDiv(hf, collateral + amount, collateral) >= level;
    }

    /// @dev Checks a setting against the loan and the governed bounds and
    ///      returns it as stored (tolerance defaulted, a close's target 0).
    function _validated(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        ExitInput calldata cfg
    ) private view returns (LibVaipakam.ExitSettings memory n) {
        if (cfg.form != LibVaipakam.EXIT_FORM_CLOSE && cfg.form != LibVaipakam.EXIT_FORM_REDUCE) {
            revert ExitFormInvalid(cfg.form);
        }
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20
                || loan.collateralAssetType != LibVaipakam.AssetType.ERC20
                || loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid
                || loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
                || (cfg.form == LibVaipakam.EXIT_FORM_REDUCE && !loan.allowsPartialRepay)
        ) revert ExitInstructionNotOffered(loanId);
        (uint64 lo, uint64 hi) = _levelBounds(s);
        if (cfg.levelHf < lo || cfg.levelHf > hi) revert ExitLevelOutOfBounds(cfg.levelHf, lo, hi);
        uint16 cap = uint16(LibVaipakam.cfgMaxSwapToRepaySlippageBps());
        uint16 tol = cfg.toleranceBps;
        if (tol == 0) tol = LibVaipakam.EXIT_TOLERANCE_DEFAULT_BPS < cap ? LibVaipakam.EXIT_TOLERANCE_DEFAULT_BPS : cap;
        uint16 tolMin = _toleranceMin(s);
        if (tol < tolMin || tol > cap) revert ExitToleranceOutOfBounds(tol, tolMin, cap);
        n.form = cfg.form;
        n.actInFastMarket = cfg.actInFastMarket;
        n.toleranceBps = tol;
        n.levelHf = cfg.levelHf;
        if (cfg.form == LibVaipakam.EXIT_FORM_REDUCE) {
            uint64 tMin = cfg.levelHf + LibStandingInstructions.cfgMargin(s);
            uint64 tMax = LibStandingInstructions.cfgTargetMax(s);
            if (cfg.targetHf < tMin || cfg.targetHf > tMax) revert ExitTargetOutOfBounds(cfg.targetHf, tMin, tMax);
            n.targetHf = cfg.targetHf;
        }
    }

    /// @dev One rule for the protected delay (design §4.1): a change waits
    ///      when it can cause more collateral to be sold, or sold at a worse
    ///      price. From nothing, every setting does.
    function _loosens(LibVaipakam.ExitSettings memory cur, LibVaipakam.ExitSettings memory next)
        private
        pure
        returns (bool)
    {
        return cur.form == LibVaipakam.EXIT_FORM_NONE || next.form != cur.form || next.levelHf > cur.levelHf
            || next.targetHf > cur.targetHf || next.toleranceBps > cur.toleranceBps
            || (next.actInFastMarket && !cur.actInFastMarket);
    }

    /// @dev The owner's protected delay, 0 when protected mode does not
    ///      govern the account.
    function _delayOf(address owner) private view returns (uint32) {
        LibProtectedAccount.Core memory c = LibProtectedAccount.core(owner);
        return LibProtectedAccount.governs(c) ? c.delay : 0;
    }

    /// @dev Applies a waiting change whose time has come.
    function _promote(LibVaipakam.ExitInstruction storage ex) private {
        if (ex.pendingAt != 0 && block.timestamp >= ex.pendingAt) {
            ex.live = ex.pending;
            delete ex.pending;
            ex.pendingAt = 0;
        }
    }

    function _inForce(LibVaipakam.ExitInstruction memory ex)
        private
        view
        returns (LibVaipakam.ExitSettings memory)
    {
        if (ex.pendingAt != 0 && block.timestamp >= ex.pendingAt) return ex.pending;
        return ex.live;
    }

    function _healthFactor(uint256 loanId) private view returns (bool ok, uint256 hf) {
        bytes memory ret;
        (ok, ret) = LibPriceRead.trySelfRead(abi.encodeCall(RiskFacet.calculateHealthFactor, (loanId)));
        if (ok && ret.length >= 32) hf = abi.decode(ret, (uint256));
        else ok = false;
    }

    function _levelBounds(LibVaipakam.Storage storage s) private view returns (uint64 lo, uint64 hi) {
        lo = s.exitInstructionCfg.levelMinHf;
        if (lo == 0) lo = LibVaipakam.EXIT_LEVEL_MIN_HF_DEFAULT;
        hi = s.exitInstructionCfg.levelMaxHf;
        if (hi == 0) hi = LibVaipakam.EXIT_LEVEL_MAX_HF_DEFAULT;
    }

    function _toleranceMin(LibVaipakam.Storage storage s) private view returns (uint16 v) {
        v = s.exitInstructionCfg.toleranceMinBps;
        if (v == 0) v = LibVaipakam.EXIT_TOLERANCE_MIN_BPS_DEFAULT;
    }
}
