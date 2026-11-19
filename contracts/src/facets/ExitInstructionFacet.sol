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
import {LibNumeraireValue} from "../libraries/LibNumeraireValue.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
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
    /// @dev A reduction's bounds, as the sizing checks them: the tolerance,
    ///      the accrued interest (paid first), the liquidation threshold `L`
    ///      and health factor `h` (WAD), the opening limit (bps, 0 = none),
    ///      the checks the least-sale search may make, and each leg's price
    ///      as the risk read values it (`OracleFacet.getAssetPrice`, the
    ///      token's decimals), so a candidate is checked on the risk read's
    ///      own figures.
    struct Reach {
        uint256 tolerance;
        uint256 interest;
        uint256 minPartial;
        uint256 L;
        uint256 h;
        uint256 capBps;
        uint256 checks;
        uint256 cPrice;
        uint256 pPrice;
        uint8 cFeedDec;
        uint8 cDec;
        uint8 pFeedDec;
        uint8 pDec;
    }

    /// @dev The most candidate sales a reduction's sizing may check on the
    ///      route's rounded figures. The checks a reduction needs follow from
    ///      its own bounds (`_leastSaleChecks`), and a reduction needing more
    ///      is refused when it is set, so the sizing always finds the least.
    uint256 private constant LEAST_SALE_CHECKS_MAX = 256;
    /// @dev The risk read values each leg in the numeraire with its own
    ///      rounding, which can sit a few wei of the 1e18 scale under the
    ///      closed form's principal-unit figure. The closed form sizes its safe
    ///      sale for this much above the target, so that sale also passes the
    ///      exact check on the risk read's figures. Candidates are checked
    ///      against the target itself.
    uint256 private constant HF_READ_SLACK = 1e6;

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
    /// @notice The reduction's health factor sits so close to what a sale at
    ///         this tolerance can lift that its least sale needs more checks
    ///         than a run may make. A lower target or tolerance, or the close
    ///         form, is accepted.
    error ExitReductionTooFine(uint256 checks, uint256 maxChecks);

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
        // A reduction that turns into a close sizes the close itself.
        if (p.form == LibVaipakam.EXIT_FORM_REDUCE) _sizeReduce(s, loan, st, rate, p);
        else _sizeClose(loanId, loan, rate, p);
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

    /// @dev A reduction, sized in whole token units against the route's own
    ///      rounding, by a closed form that needs no search.
    ///
    ///      The plan picks the repayment `R` (principal units, interest first)
    ///      and sells the least collateral whose floor covers it, through the
    ///      manual route's own rule (`LibSaleSizing`). Write `P` for the
    ///      principal, `I` the accrued interest, `K` the tolerance's keep
    ///      (`10000 - t`, in bps) and `V` the collateral's whole value in
    ///      principal units, rounded down. Selling for `R` spends at most
    ///      `R·10000/K + 1` of value, plus less than one collateral unit
    ///      (`u`, rounded up), so what remains is worth at least
    ///      `V' - R·10000/K` with `V' = V - u - 1`, and the debt left is at
    ///      most `P + I - R`. That lower bound is LINEAR in `R`, so the least
    ///      `R` meeting each bound has a closed form:
    ///      - the health factor `h` (the higher of the holder's target and the
    ///        opening limit's own, `L / c`): `L·value >= h·debt`;
    ///      - the opening loan-to-value limit `c`: `debt·10000 <= c·value`.
    ///      `R` is also at least the interest plus the loan's smallest partial
    ///      repayment. The bound is conservative by at most one collateral
    ///      unit and one principal unit of value, so the sale is the least to
    ///      within that rounding and never short of either bound; no search
    ///      over the rounded figures (which are not monotone in the sale) is
    ///      needed. A repayment that would retire the whole principal is a
    ///      close instead, since the partial route refuses it.
    function _sizeReduce(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        LibVaipakam.ExitSettings memory st,
        LibFallback.Rate memory rate,
        Plan memory p
    ) private view {
        (uint256 L, uint256 capBps, uint256 h, bool isCap) = _reduceBounds(loan, st.targetHf);
        p.targetIsLtvCap = isCap;
        p.targetUsed = h > type(uint64).max ? type(uint64).max : uint64(h);
        // The candidates are checked against the target itself
        // (`p.targetUsed`); the closed form sizes for the slack above it.
        h += HF_READ_SLACK;

        uint256 keep = LibVaipakam.BASIS_POINTS - uint256(p.tolerance);
        (uint256 interest,) = LibEntitlement.splitSettledInterest(
            loan, LibEntitlement.accruedInterestToTime(loan, block.timestamp)
        );
        uint256 owed = loan.principal + interest;
        uint256 repay;
        {
            // V' = V - u - 1: the collateral's value less the rounding slack.
            uint256 value = LibFallback.toPrincipal(rate, loan.collateralAmount);
            uint256 slack = Math.mulDiv(1, rate.den, rate.num, Math.Rounding.Ceil) + 1;
            // Below `hk > L` (h·keep > 10000·L) selling more never reaches
            // the health factor, and a value inside the rounding slack leaves
            // no partial sale to size: only a close reaches the bounds.
            if (value <= slack || h * keep <= LibVaipakam.BASIS_POINTS * L) {
                _closeInstead(loan, rate, p);
                return;
            }
            value -= slack;
            // Health factor: R·(h·K - 10000·L) >= h·K·owed - L·K·V'.
            uint256 need = h * keep * owed;
            uint256 have = L * keep * value;
            if (need > have) repay = Math.ceilDiv(need - have, h * keep - LibVaipakam.BASIS_POINTS * L);
            // Opening limit: R·10000·(K - c) >= K·(10000·owed - c·V'). Where
            // the limit is at or above the keep (`K <= c`, as with no
            // per-asset ceiling) it gives no lower bound: a sale lowers the
            // loan-to-value only while it is under the keep, and above the
            // keep it can only cap the sale from above, which the route's own
            // figures below hold.
            if (capBps != 0 && keep > capBps && LibVaipakam.BASIS_POINTS * owed > capBps * value) {
                uint256 rCap = Math.ceilDiv(
                    keep * (LibVaipakam.BASIS_POINTS * owed - capBps * value),
                    LibVaipakam.BASIS_POINTS * (keep - capBps)
                );
                if (rCap > repay) repay = rCap;
            }
        }
        // At least the interest and the smallest partial repayment.
        uint256 minPartial = (loan.principal * s.assetRiskParams[loan.principalAsset].minPartialBps)
            / LibVaipakam.BASIS_POINTS;
        if (minPartial == 0) minPartial = 1;
        if (repay < interest + minPartial) repay = interest + minPartial;

        // The conservative bound may ask for the whole debt where a smaller
        // sale on the route's own figures would still reach both bounds, so
        // a close is chosen only when no partial candidate below it does.
        Reach memory b = _reach(loan, p, interest, minPartial, L, capBps);
        b.checks = Math.min(_leastSaleChecks(L, h, keep), LEAST_SALE_CHECKS_MAX);
        bool closeBound = repay >= owed;
        uint256 safe;
        if (closeBound) {
            (bool ok, uint256 atOwed,) = LibSaleSizing.sizeSaleAtRate(rate, owed, loan.collateralAmount, p.tolerance);
            safe = ok ? atOwed : loan.collateralAmount;
        } else {
            bool covers;
            (covers, safe,) = LibSaleSizing.sizeSaleAtRate(rate, repay, loan.collateralAmount, p.tolerance);
            // The bound guarantees both checks at the floor; the second is
            // the route's own figures, kept as a guard against any drift.
            if (!covers || !_reduceReaches(loan, rate, safe, b)) {
                _closeInstead(loan, rate, p);
                return;
            }
        }
        uint256 sell = _leastReach(loan, rate, b, safe);
        if (closeBound && sell == safe) {
            // No partial sale reaches the bounds: close instead.
            _closeInstead(loan, rate, p);
            return;
        }
        uint256 floor = LibSaleSizing.floorAtRate(rate, sell, p.tolerance);
        if (LibFallback.toPrincipal(rate, sell) >= owed) {
            // The sale's oracle value would cover the whole debt; the partial
            // route refuses that, so close instead.
            _closeInstead(loan, rate, p);
            return;
        }
        p.sell = sell;
        p.floor = floor;
        p.debt = floor > interest ? floor : interest;
    }

    /// @dev The one rule for a reduction no partial sale can carry: it closes
    ///      the loan (design 4.3, "where it would repay the whole principal,
    ///      the call closes"), and skips as "cannot cover" only when the close
    ///      itself cannot cover the debt at the floor.
    function _closeInstead(LibVaipakam.Loan storage loan, LibFallback.Rate memory rate, Plan memory p) private view {
        p.form = LibVaipakam.EXIT_FORM_CLOSE;
        p.targetUsed = 0;
        p.targetIsLtvCap = false;
        _sizeClose(loan.id, loan, rate, p);
    }

    /// @dev The reduction's bounds with each leg's price as the risk read
    ///      values it.
    function _reach(
        LibVaipakam.Loan storage loan,
        Plan memory p,
        uint256 interest,
        uint256 minPartial,
        uint256 L,
        uint256 capBps
    ) private view returns (Reach memory b) {
        (b.tolerance, b.interest, b.minPartial, b.L, b.h, b.capBps) =
            (p.tolerance, interest, minPartial, L, p.targetUsed, capBps);
        (b.cPrice, b.cFeedDec) = OracleFacet(address(this)).getAssetPrice(loan.collateralAsset);
        (b.pPrice, b.pFeedDec) = OracleFacet(address(this)).getAssetPrice(loan.principalAsset);
        b.cDec = LibNumeraireValue.tokenDecimals(loan.collateralAsset);
        b.pDec = LibNumeraireValue.tokenDecimals(loan.principalAsset);
    }

    /// @dev A reduction's bounds: the liquidation threshold `L` (WAD), the
    ///      opening limit (bps, 0 = none) and the health factor `h` it brings
    ///      the loan to, the higher of the holder's target and the limit's
    ///      own (`L / c`), and whether the limit's is the higher.
    function _reduceBounds(LibVaipakam.Loan storage loan, uint256 target)
        private
        view
        returns (uint256 L, uint256 capBps, uint256 h, bool isCap)
    {
        L = uint256(loan.liquidationLtvBpsAtInit) * BPS_TO_WAD;
        capBps = LibVaipakam.effectiveLoanInitLtvCapBps(
            loan.initLtvCapBpsAtInit, LibVaipakam.assetInitLtvCeilingBps(loan.collateralAsset)
        );
        h = target;
        if (capBps != 0) {
            uint256 hAtCap = Math.mulDiv(L, LibVaipakam.BASIS_POINTS, capBps, Math.Rounding.Ceil);
            if (hAtCap > h) (h, isCap) = (hAtCap, true);
        }
    }

    /// @dev The checks that always find a reduction's least sale. The gap
    ///      between the necessary and the safe sale is, in repayment levels,
    ///      `k·L·(u+2) / (h·k - L)` (`k` the keep as a fraction, `u` a
    ///      collateral unit's value rounded up) and, in collateral units, that
    ///      over `k·price` plus two. Where a unit is worth under one principal
    ///      unit (`u = 1`) the first is at most `3L / (h·k - L)`; otherwise
    ///      the second is at most `4L / (h·k - L) + 2`. So whatever the price,
    ///      the smaller gap fits `4L / (h·k - L) + 2` checks. Unbounded (max)
    ///      where `h·k <= L`, which no partial sale can reach.
    function _leastSaleChecks(uint256 L, uint256 h, uint256 keep) private pure returns (uint256) {
        uint256 hk = h * keep;
        uint256 l = LibVaipakam.BASIS_POINTS * L;
        if (hk <= l) return type(uint256).max;
        return Math.ceilDiv(4 * l, hk - l) + 2;
    }

    /// @dev The least sale at or below `safe` that reaches both bounds on the
    ///      route's own rounded figures. `safe` (from the conservative closed
    ///      form) always does. The rounded figures are not monotone in the
    ///      sale, so this checks candidates in order from a NECESSARY lower
    ///      bound `sLo`: no sale below it can reach the bounds even before
    ///      rounding. Where the gap is short in collateral units it checks
    ///      every sale in it; where a collateral unit is worth far less than
    ///      a principal unit it checks, per repayment level, the least sale
    ///      reaching that level (any other sale at the same level only leaves
    ///      less collateral). Either way the first that reaches is the least.
    ///      The smaller gap always fits `b.checks` (`_leastSaleChecks`, which
    ///      setting holds within `LEAST_SALE_CHECKS_MAX`), so the least is
    ///      found; `safe` is kept only as a guard if neither gap fits.
    function _leastReach(LibVaipakam.Loan storage loan, LibFallback.Rate memory rate, Reach memory b, uint256 safe)
        private
        view
        returns (uint256)
    {
        uint256 sLo = _necessarySale(loan, rate, b);
        if (sLo >= safe) return safe;

        if (safe - sLo <= b.checks) {
            for (uint256 sale = sLo; sale < safe; ++sale) {
                if (_reduceReaches(loan, rate, sale, b)) return sale;
            }
            return safe;
        }
        // Per repayment level: the least sale reaching each.
        uint256 rLo = LibSaleSizing.floorAtRate(rate, sLo, b.tolerance);
        uint256 rHi = LibSaleSizing.floorAtRate(rate, safe, b.tolerance);
        if (rLo < b.interest + b.minPartial) rLo = b.interest + b.minPartial;
        if (rHi <= rLo || rHi - rLo > b.checks) return safe;
        for (uint256 r = rLo; r < rHi; ++r) {
            (bool ok, uint256 sale,) = LibSaleSizing.sizeSaleAtRate(rate, r, loan.collateralAmount, b.tolerance);
            if (ok && sale < safe && _reduceReaches(loan, rate, sale, b)) return sale;
        }
        return safe;
    }

    /// @dev A sale below which no reduction can reach the bounds even before
    ///      rounding: the collateral's value rounded UP, the floor unrounded.
    ///      With `x` the value sold, both of
    ///      `L·(V+1-x) >= h·(owed - x·K/10000)` and
    ///      `10000·(owed - x·K/10000) <= c·(V+1-x)` are necessary.
    function _necessarySale(LibVaipakam.Loan storage loan, LibFallback.Rate memory rate, Reach memory b)
        private
        view
        returns (uint256 sLo)
    {
        uint256 keep = LibVaipakam.BASIS_POINTS - b.tolerance;
        uint256 owed = loan.principal + b.interest;
        uint256 v1 = LibFallback.toPrincipal(rate, loan.collateralAmount) + 1;
        uint256 xLo;
        {
            uint256 a = LibVaipakam.BASIS_POINTS * b.h * owed;
            uint256 c = LibVaipakam.BASIS_POINTS * b.L * v1;
            if (a > c && b.h * keep > LibVaipakam.BASIS_POINTS * b.L) {
                xLo = (a - c) / (b.h * keep - LibVaipakam.BASIS_POINTS * b.L);
            }
            if (b.capBps != 0 && keep > b.capBps && LibVaipakam.BASIS_POINTS * owed > b.capBps * v1) {
                uint256 xc = (LibVaipakam.BASIS_POINTS * owed - b.capBps * v1) / (keep - b.capBps);
                if (xc > xLo) xLo = xc;
            }
        }
        sLo = Math.mulDiv(xLo, rate.num, rate.den);
        (, uint256 sMin,) =
            LibSaleSizing.sizeSaleAtRate(rate, b.interest + b.minPartial, loan.collateralAmount, b.tolerance);
        if (sMin > sLo) sLo = sMin;
    }

    /// @dev True when selling `sell` and repaying exactly its floor (interest
    ///      first, then principal) leaves the health factor at or above `h`
    ///      and, where the loan has an opening limit (`capBps != 0`), the
    ///      loan-to-value at or under it, on the figures the risk read and
    ///      the partial route compute after the sale (`RiskFacet`'s health
    ///      factor and loan-to-value over numeraire legs, debt rounded up and
    ///      collateral down), with the floor rounded down. A sale whose floor
    ///      would retire the whole principal counts as reaching both (the
    ///      caller turns it into a close).
    function _reduceReaches(
        LibVaipakam.Loan storage loan,
        LibFallback.Rate memory rate,
        uint256 sell,
        Reach memory b
    ) private view returns (bool) {
        uint256 floor = LibSaleSizing.floorAtRate(rate, sell, b.tolerance);
        if (floor <= b.interest) return false;
        uint256 retired = floor - b.interest;
        if (retired >= loan.principal) return true;
        // The risk read's own figures: each leg in the numeraire (debt up,
        // collateral down), its health factor and loan-to-value rules.
        uint256 debtV = LibNumeraireValue.toValue(loan.principal - retired, b.pPrice, b.pFeedDec, b.pDec, true);
        uint256 collV =
            LibNumeraireValue.toValue(loan.collateralAmount - sell, b.cPrice, b.cFeedDec, b.cDec, false);
        if (collV == 0) return false;
        if (LibRiskMath.healthFactor(collV, loan.liquidationLtvBpsAtInit, debtV) < b.h) return false;
        return b.capBps == 0 || LibRiskMath.ltvBps(debtV, collV) <= b.capBps;
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
            // A reduction whose least sale needs more checks than a run may
            // make is refused; one no partial sale can reach (unbounded)
            // runs as a close and is accepted.
            (uint256 L,, uint256 h,) = _reduceBounds(loan, cfg.targetHf);
            uint256 checks = _leastSaleChecks(L, h + HF_READ_SLACK, LibVaipakam.BASIS_POINTS - tol);
            if (checks != type(uint256).max && checks > LEAST_SALE_CHECKS_MAX) {
                revert ExitReductionTooFine(checks, LEAST_SALE_CHECKS_MAX);
            }
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
