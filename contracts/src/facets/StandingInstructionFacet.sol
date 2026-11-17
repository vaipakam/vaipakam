// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {LibLoanCollateral} from "../libraries/LibLoanCollateral.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibPriceRead} from "../libraries/LibPriceRead.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibRefinanceRequest} from "../libraries/LibRefinanceRequest.sol";
import {LibStandingInstructions} from "../libraries/LibStandingInstructions.sol";
import {LibInterestPayment, IInterestPaymentHost} from "../libraries/LibInterestPayment.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {CollateralLienFacet} from "./CollateralLienFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";

/**
 * @title StandingInstructionFacet — standing instructions from your own vault (#3681).
 * @notice The holder of a loan's borrower position may place a LOAN RESERVE
 *         in their own vault and switch on up to three instructions, which
 *         anyone may then run:
 *
 *         1. Keep my loan healthy ({runCollateralTopUp}): below the holder's
 *            trigger health factor, move collateral from the collateral
 *            reserve into the loan's lien until the health factor is back at
 *            the holder's target (or the reserve is used up).
 *         2. Pay my interest ({runInterestPayment}): from a period's end, pay
 *            the period's unpaid interest from the payment reserve.
 *         3. Repay at the due date ({runDueRepayment}): from the holder's
 *            chosen time before the due date until grace ends, repay the
 *            loan in full from the payment reserve, all or nothing.
 *
 *         The reserve is the limit: an instruction spends only what its
 *         holder placed in that loan's reserve, and only on that loan. Every
 *         amount is fixed by the loan, the setting and the reserve; the
 *         caller chooses nothing and receives nothing, so no keeper
 *         permission guards these steps.
 *
 *         The reserve is two balances per loan and depositor, both in the
 *         depositor's own vault and encumbered there (`LibEncumbrance` is
 *         their one writer): the PAYMENT reserve in the lending asset (also
 *         drawn by an automatic extension's charge, #2814), and the
 *         COLLATERAL reserve in the collateral asset. The collateral reserve
 *         is not collateral: no liquidation or default takes it and the
 *         health factor does not count it until instruction 1 moves it into
 *         the lien. The reserve follows the DEPOSITOR, not the position: an
 *         instruction runs only while its owner still holds the position.
 *
 *         When an instruction cannot run for a reason its holder should hear
 *         about (the position moved, the reserve is empty or short, a
 *         competing close-out is live, the price is unavailable, the asset or
 *         platform is paused, the account is locked), the executor emits
 *         {StandingInstructionSkipped} and changes nothing. When it is simply
 *         not time yet (not set, not due, healthy, too soon after the last
 *         top-up, nothing owed), it reverts by name.
 *
 * @dev    Design: `docs/DesignsAndPlans/StandingInstructionsDesign.md`.
 *         Interest is booked through `LibInterestPayment`, hosted on
 *         `RepayPeriodicFacet.bookInterestPayment`, which the periodic forced
 *         sale also uses. The full repayment runs through
 *         `RepayFacet.repayLoan` (bound to the reserve), the ordinary repayment with the
 *         holder's payment reserve as the payer.
 */
contract StandingInstructionFacet is DiamondAccessControl, DiamondReentrancyGuard {
    // ─── Types ───────────────────────────────────────────────────────

    /// @notice The holder's settings, as {setStandingInstructions} takes them.
    /// @param topUpTriggerHf   1e18 health factor below which instruction 1
    ///                         runs; 0 switches it off.
    /// @param topUpTargetHf    1e18 health factor instruction 1 restores.
    /// @param payInterest      Instruction 2 on.
    /// @param repayAtDue       Instruction 3 on.
    /// @param repayLeadSeconds How long before the due date instruction 3 may
    ///                         run (0 = at the due date; at most one day).
    struct InstructionInput {
        uint64 topUpTriggerHf;
        uint64 topUpTargetHf;
        bool payInterest;
        bool repayAtDue;
        uint32 repayLeadSeconds;
    }

    /// @notice One loan's reserve and instructions as `holder` sees them.
    /// @param paymentAsset      The lending asset.
    /// @param paymentReserve    `holder`'s payment reserve for the loan.
    /// @param collateralAsset   The collateral asset.
    /// @param collateralReserve `holder`'s collateral reserve for the loan.
    /// @param instructions      The loan's stored instructions.
    /// @param ownerHoldsPosition True when the instructions' owner still holds
    ///                          the borrower position, so they can run.
    /// @param topUpNow          What instruction 1 would move now (0 when it
    ///                          would not run).
    /// @param priceKnown        False when the health factor could not be
    ///                          read; `topUpNow` is then unknown and reads 0.
    /// @param interestShortfall The current period's unpaid interest.
    /// @param interestNow       What instruction 2 would pay now (0 before the
    ///                          period's end).
    /// @param repayDue          The full repayment amount now.
    /// @param repayShortBy      How much the payment reserve lacks for it.
    struct ReserveView {
        address paymentAsset;
        uint256 paymentReserve;
        address collateralAsset;
        uint256 collateralReserve;
        LibVaipakam.StandingInstructions instructions;
        bool ownerHoldsPosition;
        uint256 topUpNow;
        bool priceKnown;
        uint256 interestShortfall;
        uint256 interestNow;
        uint256 repayDue;
        uint256 repayShortBy;
        /// @dev The SKIP_* reason a collateral top-up would be skipped for
        ///      right now on the loan- and account-level checks every run
        ///      makes (holder, pause, account lock, loan busy); 0 = none.
        ///      The reserve and price checks are the fields above.
        uint8 topUpSkipNow;
        /// @dev The same for the interest payment and the due repayment
        ///      (both pay in the loan's principal asset, so one reason).
        uint8 paymentSkipNow;
        /// @dev True when the borrower position has moved and a top-up must
        ///      first consolidate it into the holder's vault; a top-up run
        ///      tries that and is skipped (NOT_CONSOLIDATED) if it cannot.
        bool consolidationPending;
    }

    // ─── Events ──────────────────────────────────────────────────────

    /// @notice `holder` placed `amount` from their wallet into their own
    ///         vault, reserved for `loanId` (`kind`: 0 payment, 1 collateral).
    /// @param reserved What the holder has in that reserve after it.
    /// @custom:event-category state-change/vault-mutation
    event LoanReserveFunded(
        uint256 indexed loanId,
        address indexed holder,
        uint8 kind,
        address asset,
        uint256 amount,
        uint256 reserved
    );

    /// @notice A depositor withdrew `amount` of their unused reserve.
    /// @param reserved What is left in that reserve.
    /// @custom:event-category state-change/vault-mutation
    event LoanReserveWithdrawn(
        uint256 indexed loanId,
        address indexed holder,
        uint8 kind,
        address asset,
        uint256 amount,
        uint256 reserved
    );

    /// @notice The instructions for `loanId` were set by `setBy` for the
    ///         position holder `owner`.
    /// @custom:event-category state-change/loan-mutation
    event StandingInstructionsSet(
        uint256 indexed loanId,
        address indexed owner,
        address setBy,
        uint64 topUpTriggerHf,
        uint64 topUpTargetHf,
        bool payInterest,
        bool repayAtDue,
        uint32 repayLeadSeconds
    );

    /// @notice The instructions for `loanId` were cleared.
    /// @custom:event-category state-change/loan-mutation
    event StandingInstructionsCleared(uint256 indexed loanId, address indexed owner, address by);

    /// @notice Instruction 1 ran: `amount` moved from `holder`'s collateral
    ///         reserve into the loan's collateral, in the same vault.
    /// @param hfBefore    The health factor before (1e18).
    /// @param hfAfter     The health factor after (1e18; 0 if unreadable).
    /// @param reserveLeft What is left in the collateral reserve.
    /// @custom:event-category state-change/loan-mutation
    event CollateralTopUpRun(
        uint256 indexed loanId,
        address indexed holder,
        uint256 amount,
        uint256 hfBefore,
        uint256 hfAfter,
        uint256 reserveLeft,
        address caller
    );

    /// @notice Instruction 2 ran: `amount` of the period's `shortfall` was
    ///         paid from `holder`'s payment reserve. The lender, seller and
    ///         treasury split is in `LibInterestPayment.InterestPaymentBooked`
    ///         in the same transaction.
    /// @param periodClosed True when the payment closed the period.
    /// @param reserveLeft  What is left in the payment reserve.
    /// @custom:event-category state-change/loan-mutation
    event InterestPaidFromReserve(
        uint256 indexed loanId,
        address indexed holder,
        uint256 amount,
        uint256 shortfall,
        bool periodClosed,
        uint256 reserveLeft,
        address caller
    );

    /// @notice Instruction 3 ran: the loan was repaid in full from
    ///         `holder`'s payment reserve (`RepayFacet`'s `LoanRepaid` and
    ///         `LoanSettlementBreakdown` carry the split).
    /// @custom:event-category state-change/loan-mutation
    event DueRepaymentRun(
        uint256 indexed loanId,
        address indexed holder,
        uint256 amount,
        uint256 reserveLeft,
        address caller
    );

    /// @notice An instruction could not run and changed nothing. `missing`
    ///         is how much the reserve lacks for a repayment (`reason`
    ///         {SKIP_RESERVE_SHORT}), else 0.
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
    event StandingInstructionConfigSet(
        uint64 triggerMinHf,
        uint64 triggerMaxHf,
        uint64 targetMaxHf,
        uint64 minMarginHf,
        uint32 topUpIntervalSeconds
    );

    // ─── Constants ───────────────────────────────────────────────────

    uint8 internal constant RESERVE_PAYMENT = 0;
    uint8 internal constant RESERVE_COLLATERAL = 1;

    uint8 internal constant INSTRUCTION_TOP_UP = 1;
    uint8 internal constant INSTRUCTION_PAY_INTEREST = 2;
    uint8 internal constant INSTRUCTION_REPAY_AT_DUE = 3;

    /// @notice The position is no longer held by the instructions' owner.
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

    // ─── Errors ──────────────────────────────────────────────────────

    error LoanReserveZeroAmount();
    error LoanReserveNotOffered(uint256 loanId, uint8 kind);
    error StandingInstructionNotOffered(uint256 loanId, uint8 instruction);
    error TopUpBoundsInvalid(uint64 triggerHf, uint64 targetHf);
    error RepayLeadTooLong(uint32 leadSeconds, uint32 max);
    /// @notice The due date already has a plan (automatic extension or
    ///         automatic refinance limits, or the repay instruction).
    error DueDatePlanExists(uint256 loanId);
    error StandingInstructionNotSet(uint256 loanId, uint8 instruction);
    error StandingInstructionNotDue(uint256 loanId, uint8 instruction, uint256 from);
    error StandingInstructionWindowClosed(uint256 loanId, uint8 instruction);
    error LoanHealthAboveTrigger(uint256 loanId, uint256 hf, uint256 trigger);
    error TopUpTooSoon(uint256 loanId, uint256 nextAt);
    error NothingOwed(uint256 loanId);
    error StandingInstructionConfigInvalid();

    // ─── The loan reserve ────────────────────────────────────────────

    /// @notice Place `amount` from the caller's wallet into their own vault,
    ///         reserved for `loanId`: kind 0 the lending asset (payment
    ///         reserve), kind 1 the collateral asset (collateral reserve).
    /// @dev    Only the current borrower-position holder, acting as its own
    ///         manager, may fund. Refused for a loan that is not Active or not
    ///         an ERC-20 loan, for a paused asset and for a sanctioned wallet
    ///         (Tier-1). The collateral reserve is offered only for a liquid,
    ///         priced ERC-20 collateral, since instruction 1 has no trigger
    ///         without a health factor. The caller approves the Diamond for
    ///         exactly `amount` first.
    function fundLoanReserve(uint256 loanId, uint8 kind, uint256 amount) external nonReentrant {
        LibPausable.requireNotPaused();
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibProtectedAccount.requireManager(msg.sender);
        if (amount == 0) revert LoanReserveZeroAmount();
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (loan.startTime == 0 || loan.status != LibVaipakam.LoanStatus.Active) {
            revert IVaipakamErrors.LoanNotActive();
        }
        if (loan.assetType != LibVaipakam.AssetType.ERC20) revert LoanReserveNotOffered(loanId, kind);
        if (LibPositionNFT.ownerOf(loan.borrowerTokenId) != msg.sender) {
            revert IVaipakamErrors.NotNFTOwner();
        }
        address asset = _reserveAsset(loan, kind);
        if (kind == RESERVE_COLLATERAL && !_collateralPriced(loan)) {
            revert LoanReserveNotOffered(loanId, kind);
        }
        LibFacet.requireAssetNotPaused(asset);
        // Wallet -> the caller's own vault through the protocol chokepoint,
        // which records the tracked balance and refuses a short arrival.
        LibFacet.crossFacetCall(
            abi.encodeCall(VaultFactoryFacet.vaultDepositERC20, (msg.sender, asset, amount)),
            IVaipakamErrors.VaultDepositFailed.selector
        );
        uint256 reserved = LibEncumbrance.lienLoanReserve(loanId, msg.sender, kind, asset, amount);
        emit LoanReserveFunded(loanId, msg.sender, kind, asset, amount, reserved);
    }

    /// @notice Withdraw `amount` of `account`'s unused reserve of `kind` for
    ///         `loanId` to the caller, who must be the account's manager (its
    ///         own wallet, or its controller once a replacement retired it).
    /// @dev    Open whatever the loan's state and whoever holds the position:
    ///         the reserve is the depositor's own money. An ordinary vault
    ///         payout under the outflow policy (a protected account's payout
    ///         queues behind its delay). Tier-1 sanctions-gated.
    function withdrawLoanReserve(address account, uint256 loanId, uint8 kind, uint256 amount) external nonReentrant {
        LibPausable.requireNotPaused();
        LibProtectedAccount.requireManager(account);
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (amount == 0) revert LoanReserveZeroAmount();
        address asset = _reserveAsset(LibVaipakam.storageSlot().loans[loanId], kind);
        // Released BEFORE the withdraw, so the chokepoint's guard sees it free.
        uint256 left = LibEncumbrance.unlienLoanReserve(loanId, account, kind, asset, amount);
        if (msg.sender == account) {
            LibVaultOutflow.toOwner(account, LibVaultOutflow.ERC20, asset, 0, amount, OutflowReason.WITHDRAW);
        } else {
            LibVaultOutflow.toAllowlisted(
                account, LibVaultOutflow.ERC20, asset, 0, amount, msg.sender, OutflowReason.WITHDRAW
            );
        }
        emit LoanReserveWithdrawn(loanId, account, kind, asset, amount, left);
    }

    // ─── Settings ────────────────────────────────────────────────────

    /// @notice Set `loanId`'s standing instructions for its current
    ///         borrower-position holder. The caller is that holder's manager.
    /// @dev    Each instruction is refused where it could not run on the
    ///         loan: the top-up on a loan without a health factor (not both
    ///         legs liquid ERC-20s), the interest payment on a loan without a
    ///         periodic cadence, and the due-date repayment while automatic
    ///         extension or automatic refinance limits stand (one plan for
    ///         the due date). Trigger and target are checked against the
    ///         governed bounds. Replaces any earlier setting.
    function setStandingInstructions(uint256 loanId, InstructionInput calldata cfg) external nonReentrant {
        LibPausable.requireNotPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        LibAuth.requirePositionManager(loan.borrowerTokenId);
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert StandingInstructionNotOffered(loanId, INSTRUCTION_REPAY_AT_DUE);
        }
        if (cfg.topUpTriggerHf != 0) {
            if (
                loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
                loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
                loan.collateralAssetType != LibVaipakam.AssetType.ERC20
            ) revert StandingInstructionNotOffered(loanId, INSTRUCTION_TOP_UP);
            _checkTopUpBounds(cfg.topUpTriggerHf, cfg.topUpTargetHf);
        }
        if (cfg.payInterest && loan.periodicInterestCadence == LibVaipakam.PeriodicInterestCadence.None) {
            revert StandingInstructionNotOffered(loanId, INSTRUCTION_PAY_INTEREST);
        }
        if (cfg.repayAtDue) {
            if (cfg.repayLeadSeconds > LibVaipakam.STANDING_REPAY_LEAD_MAX) {
                revert RepayLeadTooLong(cfg.repayLeadSeconds, LibVaipakam.STANDING_REPAY_LEAD_MAX);
            }
            if (LibStandingInstructions.autoDueDatePlanLive(s, loan)) revert DueDatePlanExists(loanId);
        }
        address owner = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        // The interval between two top-ups survives a re-set by the same
        // owner, so re-setting cannot shorten it.
        uint64 last = si.owner == owner ? si.lastTopUpAt : 0;
        s.standingInstructions[loanId] = LibVaipakam.StandingInstructions({
            owner: owner,
            topUpTriggerHf: cfg.topUpTriggerHf,
            topUpTargetHf: cfg.topUpTriggerHf == 0 ? 0 : cfg.topUpTargetHf,
            lastTopUpAt: last,
            payInterest: cfg.payInterest,
            repayAtDue: cfg.repayAtDue,
            repayLeadSeconds: cfg.repayAtDue ? cfg.repayLeadSeconds : 0
        });
        emit StandingInstructionsSet(
            loanId,
            owner,
            msg.sender,
            cfg.topUpTriggerHf,
            cfg.topUpTriggerHf == 0 ? 0 : cfg.topUpTargetHf,
            cfg.payInterest,
            cfg.repayAtDue,
            cfg.repayAtDue ? cfg.repayLeadSeconds : 0
        );
    }

    /// @notice Clear `loanId`'s standing instructions. The caller is the
    ///         manager of the instructions' owner or of the current
    ///         borrower-position holder.
    function clearStandingInstructions(uint256 loanId) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address owner = s.standingInstructions[loanId].owner;
        if (owner == address(0)) revert StandingInstructionNotSet(loanId, 0);
        if (msg.sender != LibProtectedAccount.manager(owner)) {
            LibAuth.requirePositionManager(s.loans[loanId].borrowerTokenId);
        }
        delete s.standingInstructions[loanId];
        emit StandingInstructionsCleared(loanId, owner, msg.sender);
    }

    // ─── Executors (permissionless) ──────────────────────────────────

    /// @notice Instruction 1: move collateral from the holder's collateral
    ///         reserve into the loan's lien, the least that brings the health
    ///         factor back to the holder's target, or the whole reserve if
    ///         that is less. Runs only below the trigger, at most once per
    ///         configured interval.
    function runCollateralTopUp(uint256 loanId) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        if (si.topUpTriggerHf == 0) revert StandingInstructionNotSet(loanId, INSTRUCTION_TOP_UP);
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        uint256 nextAt = uint256(si.lastTopUpAt) + _cfgInterval(s);
        if (si.lastTopUpAt != 0 && block.timestamp < nextAt) revert TopUpTooSoon(loanId, nextAt);

        address holder = si.owner;
        uint8 skip = _commonSkip(s, loanId, loan, holder, loan.collateralAsset);
        if (skip == 0) skip = _consolidated(loanId, loan, holder);
        uint256 reserve = s.collateralReserve[loanId][holder];
        if (skip == 0 && reserve == 0) skip = SKIP_RESERVE_EMPTY;
        (bool ok, uint256 hf) = _healthFactor(loanId);
        if (skip == 0 && !ok) skip = SKIP_PRICE_UNAVAILABLE;
        if (skip != 0) {
            _skip(loanId, INSTRUCTION_TOP_UP, skip, 0);
            return;
        }
        if (hf >= si.topUpTriggerHf) revert LoanHealthAboveTrigger(loanId, hf, si.topUpTriggerHf);

        uint256 amount = _topUpAmount(loan.collateralAmount, hf, si.topUpTargetHf);
        if (amount > reserve) amount = reserve;
        si.lastTopUpAt = uint64(block.timestamp);
        // The reserve leaves the encumbrance and joins the loan's collateral
        // lien, in the same vault: no tokens move.
        LibEncumbrance.unlienLoanReserve(loanId, holder, RESERVE_COLLATERAL, loan.collateralAsset, amount);
        LibLoanCollateral.add(loan, amount);
        LibFacet.crossFacetCall(
            abi.encodeCall(CollateralLienFacet.incrementCollateralLien, (loanId, amount)),
            bytes4(0)
        );
        (, uint256 hfAfter) = _healthFactor(loanId);
        emit CollateralTopUpRun(loanId, holder, amount, hf, hfAfter, reserve - amount, msg.sender);
    }

    /// @notice Instruction 2: from the current period's end, pay its unpaid
    ///         interest from the holder's payment reserve (all of it, or as
    ///         much as the reserve holds). A payment that brings the period to
    ///         fully paid closes it in the same transaction; after a part
    ///         payment the periodic settlement sells only for the rest.
    function runInterestPayment(uint256 loanId) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        if (!si.payInterest) revert StandingInstructionNotSet(loanId, INSTRUCTION_PAY_INTEREST);
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        uint256 periodEnd = LibPeriodicInterest.periodEndAt(loan);
        if (block.timestamp < periodEnd) {
            revert StandingInstructionNotDue(loanId, INSTRUCTION_PAY_INTEREST, periodEnd);
        }
        uint256 shortfall = LibPeriodicInterest.currentShortfall(loan);
        if (shortfall == 0) revert NothingOwed(loanId);

        address holder = si.owner;
        address asset = loan.principalAsset;
        uint8 skip = _commonSkip(s, loanId, loan, holder, asset);
        uint256 reserve = s.paymentReserve[loanId][holder];
        if (skip == 0 && reserve == 0) skip = SKIP_RESERVE_EMPTY;
        if (skip != 0) {
            _skip(loanId, INSTRUCTION_PAY_INTEREST, skip, 0);
            return;
        }
        uint256 amount = shortfall < reserve ? shortfall : reserve;
        _drawPayment(loanId, holder, asset, amount);
        // The one interest booking, shared with the periodic forced sale.
        LibFacet.crossFacetCallReturn(
            abi.encodeCall(
                IInterestPaymentHost.bookInterestPayment,
                (loanId, amount, amount, LibInterestPayment.SOURCE_PAYMENT_RESERVE)
            ),
            bytes4(0)
        );
        // The period's credit, through its one crediting function, which
        // closes the period inline once it is paid and over.
        uint64 checkpoint = loan.lastPeriodicInterestSettledAt;
        LibPeriodicInterest.creditInterestPaid(loan, loanId, amount);
        emit InterestPaidFromReserve(
            loanId,
            holder,
            amount,
            shortfall,
            loan.lastPeriodicInterestSettledAt != checkpoint,
            reserve - amount,
            msg.sender
        );
    }

    /// @notice Instruction 3: repay the loan in full from the holder's
    ///         payment reserve, from `repayLeadSeconds` before the due date
    ///         until grace ends, exactly as a manual repayment would (the same
    ///         amounts, the late fee if past the due date, the collateral
    ///         back to the borrower side). All or nothing: a reserve short of
    ///         the full amount changes nothing and says how much is missing.
    /// @dev Holds no reentrancy guard of its own: it makes no external call
    ///      before the repayment, and the repayment it self-calls takes the
    ///      Diamond's guard for the whole movement of funds.
    function runDueRepayment(uint256 loanId) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loanId];
        if (!si.repayAtDue) revert StandingInstructionNotSet(loanId, INSTRUCTION_REPAY_AT_DUE);
        if (loan.status != LibVaipakam.LoanStatus.Active) revert IVaipakamErrors.LoanNotActive();
        uint256 maturity = LibLoanClock.maturity(loan);
        uint256 from = maturity > si.repayLeadSeconds ? maturity - si.repayLeadSeconds : 0;
        if (block.timestamp < from) revert StandingInstructionNotDue(loanId, INSTRUCTION_REPAY_AT_DUE, from);
        if (block.timestamp > LibLoanClock.graceEnd(loan)) {
            revert StandingInstructionWindowClosed(loanId, INSTRUCTION_REPAY_AT_DUE);
        }

        address holder = si.owner;
        uint8 skip = _commonSkip(s, loanId, loan, holder, loan.principalAsset);
        uint256 reserve = s.paymentReserve[loanId][holder];
        uint256 due = _repaymentDue(loan, loanId);
        uint256 missing;
        if (skip == 0 && reserve == 0) skip = SKIP_RESERVE_EMPTY;
        if (skip == 0 && reserve < due) {
            skip = SKIP_RESERVE_SHORT;
            missing = due - reserve;
        }
        if (skip != 0) {
            _skip(loanId, INSTRUCTION_REPAY_AT_DUE, skip, missing);
            return;
        }
        // The ordinary repayment, bound to the holder's payment reserve as
        // payer; it draws exactly what it charges.
        LibStandingInstructions.bindReserveRepayer(loanId, holder);
        LibFacet.crossFacetCall(abi.encodeWithSignature("repayLoan(uint256)", loanId), bytes4(0));
        emit DueRepaymentRun(loanId, holder, due, s.paymentReserve[loanId][holder], msg.sender);
    }

    /// @notice The reserve-paid legs of the due repayment: `holder`'s
    ///         payment reserve for `loanId` is released and drawn into the
    ///         Diamond for exactly `treasuryShare + lenderDue` (refused unless
    ///         all of it arrives), then the treasury share goes through the
    ///         fee host and the lender's due into the stored lender's vault,
    ///         refused unless it all arrives, as from a wallet.
    /// @dev    Reached only by self-call from `RepayFacet.repayLoan` on the reserve path
    ///         (so under {runDueRepayment}'s guard), which has computed both
    ///         amounts and books the repayment. It lives here, beside the
    ///         reserve, because RepayFacet has no EIP-170 room for it.
    function payRepaymentFromReserve(uint256 loanId, address holder, uint256 treasuryShare, uint256 lenderDue)
        external
    {
        if (msg.sender != address(this)) revert IVaipakamErrors.UnauthorizedCrossFacetCall();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address asset = loan.principalAsset;
        uint256 total = treasuryShare + lenderDue;
        LibEncumbrance.unlienLoanReserve(loanId, holder, RESERVE_PAYMENT, asset, total);
        LibVaultOutflow.toDiamondExact(holder, asset, total, loanId, OutflowReason.STANDING_INSTRUCTION);
        LibFacet.transferToTreasury(asset, treasuryShare);
        LibSanctionedLock.depositLockedInFull(s, loan.lender, loanId, asset, lenderDue);
    }

    // ─── Views ───────────────────────────────────────────────────────

    /// @notice `holder`'s reserve for `loanId`, the loan's instructions, and
    ///         what each instruction would move if run now.
    function getLoanReserve(uint256 loanId, address holder) external view returns (ReserveView memory v) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        v.paymentAsset = loan.principalAsset;
        v.paymentReserve = s.paymentReserve[loanId][holder];
        v.collateralAsset = loan.collateralAsset;
        v.collateralReserve = s.collateralReserve[loanId][holder];
        v.instructions = s.standingInstructions[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) return v;
        address holderNow = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        v.ownerHoldsPosition = v.instructions.owner != address(0) && holderNow == v.instructions.owner;
        v.consolidationPending = loan.borrower != holderNow;
        if (v.instructions.owner != address(0)) {
            v.topUpSkipNow = _commonSkip(s, loanId, loan, v.instructions.owner, loan.collateralAsset);
            v.paymentSkipNow = _commonSkip(s, loanId, loan, v.instructions.owner, loan.principalAsset);
        }
        uint256 hf;
        (v.priceKnown, hf) = _healthFactor(loanId);
        if (v.priceKnown && v.instructions.topUpTriggerHf != 0 && hf < v.instructions.topUpTriggerHf) {
            uint256 want = _topUpAmount(loan.collateralAmount, hf, v.instructions.topUpTargetHf);
            v.topUpNow = want < v.collateralReserve ? want : v.collateralReserve;
        }
        if (loan.periodicInterestCadence != LibVaipakam.PeriodicInterestCadence.None) {
            v.interestShortfall = LibPeriodicInterest.currentShortfall(loan);
            if (block.timestamp >= LibPeriodicInterest.periodEndAt(loan)) {
                v.interestNow = v.interestShortfall < v.paymentReserve ? v.interestShortfall : v.paymentReserve;
            }
        }
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            v.repayDue = _repaymentDue(loan, loanId);
            v.repayShortBy = v.repayDue > v.paymentReserve ? v.repayDue - v.paymentReserve : 0;
        }
    }

    /// @notice The governed bounds in force (defaults filled in).
    function getStandingInstructionConfig()
        external
        view
        returns (LibVaipakam.StandingInstructionConfig memory c)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        c = LibVaipakam.StandingInstructionConfig({
            triggerMinHf: _cfgTriggerMin(s),
            triggerMaxHf: _cfgTriggerMax(s),
            targetMaxHf: _cfgTargetMax(s),
            minMarginHf: _cfgMargin(s),
            topUpIntervalSeconds: uint32(_cfgInterval(s))
        });
    }

    // ─── Governance ──────────────────────────────────────────────────

    /// @notice Set the bounds for the top-up instruction, platform-wide.
    ///         Zero keeps a field's default.
    /// @dev    Outer bounds: triggers above 1.0, a target ceiling at most
    ///         3.0 and above the highest trigger by at least the margin, a
    ///         margin of 0.01 to 0.5, an interval of 5 minutes to 1 day.
    ///         Existing settings are not re-checked; the new bounds apply to
    ///         the next set.
    function setStandingInstructionConfig(LibVaipakam.StandingInstructionConfig calldata c)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.standingInstructionCfg = c;
        uint64 tMin = _cfgTriggerMin(s);
        uint64 tMax = _cfgTriggerMax(s);
        uint64 target = _cfgTargetMax(s);
        uint64 margin = _cfgMargin(s);
        uint256 interval = _cfgInterval(s);
        if (
            tMin <= LibVaipakam.STANDING_HF_FLOOR ||
            tMax < tMin ||
            margin < LibVaipakam.STANDING_MIN_MARGIN_FLOOR ||
            margin > LibVaipakam.STANDING_MIN_MARGIN_CEILING ||
            target > LibVaipakam.STANDING_TARGET_CEILING ||
            uint256(target) < uint256(tMax) + margin ||
            interval < LibVaipakam.STANDING_TOPUP_INTERVAL_MIN ||
            interval > LibVaipakam.STANDING_TOPUP_INTERVAL_MAX
        ) revert StandingInstructionConfigInvalid();
        emit StandingInstructionConfigSet(tMin, tMax, target, margin, uint32(interval));
    }

    // ─── Internals ───────────────────────────────────────────────────

    function _reserveAsset(LibVaipakam.Loan storage loan, uint8 kind) private view returns (address) {
        if (kind == RESERVE_PAYMENT) return loan.principalAsset;
        if (kind == RESERVE_COLLATERAL) return loan.collateralAsset;
        revert LibEncumbrance.LoanReserveKindUnknown(kind);
    }

    function _collateralPriced(LibVaipakam.Loan storage loan) private view returns (bool) {
        if (loan.collateralAssetType != LibVaipakam.AssetType.ERC20) return false;
        (bool ok, bytes memory ret) = LibPriceRead.trySelfRead(
            abi.encodeCall(OracleFacet.checkLiquidity, (loan.collateralAsset))
        );
        return ok && ret.length >= 32 &&
            abi.decode(ret, (LibVaipakam.LiquidityStatus)) == LibVaipakam.LiquidityStatus.Liquid;
    }

    /// @dev The skip reasons every instruction shares (design §4.4), in
    ///      order; 0 when none applies.
    function _commonSkip(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address holder,
        address asset
    ) private view returns (uint8) {
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

    /// @dev The collateral lien sits in the STORED borrower's vault; a moved
    ///      position is consolidated into the new holder's vault first (skip-
    ///      not-block), and a top-up waits until it is.
    function _consolidated(uint256 loanId, LibVaipakam.Loan storage loan, address holder)
        private
        returns (uint8)
    {
        if (loan.borrower == holder) return 0;
        LibFacet.crossFacetCall(
            abi.encodeCall(ConsolidationFacet.eagerConsolidateBothSides, (loanId)),
            bytes4(0)
        );
        return loan.borrower == holder ? 0 : SKIP_NOT_CONSOLIDATED;
    }

    function _healthFactor(uint256 loanId) private view returns (bool ok, uint256 hf) {
        bytes memory ret;
        (ok, ret) = LibPriceRead.trySelfRead(abi.encodeCall(RiskFacet.calculateHealthFactor, (loanId)));
        if (ok && ret.length >= 32) hf = abi.decode(ret, (uint256));
        else ok = false;
    }

    /// @dev The health factor is proportional to the collateral amount (one
    ///      collateral asset, one price), so the least top-up to `target` is
    ///      `collateral * (target - hf) / hf`, rounded up.
    function _topUpAmount(uint256 collateral, uint256 hf, uint256 target) private pure returns (uint256) {
        if (hf == 0 || target <= hf) return 0;
        return (collateral * (target - hf) + hf - 1) / hf;
    }

    /// @dev What a full repayment charges now: the same plan `RepayFacet`
    ///      settles (principal, interest net of what is settled, late fee).
    function _repaymentDue(LibVaipakam.Loan storage loan, uint256 loanId) private view returns (uint256) {
        LibSettlement.ERC20Settlement memory plan =
            LibSettlement.computeRepayment(loan, LibVaipakam.calculateLateFee(loanId), block.timestamp);
        return plan.lenderDue + plan.treasuryShare;
    }

    /// @dev The payment reserve's draw for an interest payment: released from
    ///      the reserve, then out of the holder's vault to the Diamond, refused
    ///      unless all of it arrives.
    function _drawPayment(uint256 loanId, address holder, address asset, uint256 amount) private {
        LibEncumbrance.unlienLoanReserve(loanId, holder, RESERVE_PAYMENT, asset, amount);
        LibVaultOutflow.toDiamondExact(holder, asset, amount, loanId, OutflowReason.STANDING_INSTRUCTION);
    }

    function _skip(uint256 loanId, uint8 instruction, uint8 reason, uint256 missing) private {
        emit StandingInstructionSkipped(loanId, instruction, reason, missing, msg.sender);
    }

    function _checkTopUpBounds(uint64 trigger, uint64 target) private view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (
            trigger < _cfgTriggerMin(s) ||
            trigger > _cfgTriggerMax(s) ||
            uint256(target) < uint256(trigger) + _cfgMargin(s) ||
            target > _cfgTargetMax(s)
        ) revert TopUpBoundsInvalid(trigger, target);
    }

    function _cfgTriggerMin(LibVaipakam.Storage storage s) private view returns (uint64 v) {
        v = s.standingInstructionCfg.triggerMinHf;
        if (v == 0) v = LibVaipakam.STANDING_TRIGGER_MIN_HF_DEFAULT;
    }

    function _cfgTriggerMax(LibVaipakam.Storage storage s) private view returns (uint64 v) {
        v = s.standingInstructionCfg.triggerMaxHf;
        if (v == 0) v = LibVaipakam.STANDING_TRIGGER_MAX_HF_DEFAULT;
    }

    function _cfgTargetMax(LibVaipakam.Storage storage s) private view returns (uint64 v) {
        v = s.standingInstructionCfg.targetMaxHf;
        if (v == 0) v = LibVaipakam.STANDING_TARGET_MAX_HF_DEFAULT;
    }

    function _cfgMargin(LibVaipakam.Storage storage s) private view returns (uint64 v) {
        v = s.standingInstructionCfg.minMarginHf;
        if (v == 0) v = LibVaipakam.STANDING_MIN_MARGIN_HF_DEFAULT;
    }

    function _cfgInterval(LibVaipakam.Storage storage s) private view returns (uint256 v) {
        v = s.standingInstructionCfg.topUpIntervalSeconds;
        if (v == 0) v = LibVaipakam.STANDING_TOPUP_INTERVAL_DEFAULT;
    }
}
