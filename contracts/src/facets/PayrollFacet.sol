// src/facets/PayrollFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title PayrollFacet
 * @author Vaipakam Developer Team
 * @notice Founder / contributor salary streams (T-600). A salary is a
 *         continuous per-second accrual paid from treasury funds — the
 *         beneficiary withdraws accrued-and-funded amounts at will.
 * @dev Part of the Diamond Standard (EIP-2535). Uses shared LibVaipakam
 *      storage (`payrollStreams` / `payrollStreamCount`).
 *
 *      **Why a stream and not a per-fee auto-route** — see
 *      docs/DesignsAndPlans/TreasuryAndFounderDistribution.md. A salary
 *      stream is *compensation for services*: a fixed, governance-set
 *      rate, revisable, pausable. It is structurally distinct from the
 *      rejected pattern of auto-routing a percentage of user fees to an
 *      insider address (a Howey-test / securities-revenue-share risk).
 *      The load-bearing guarantees enforced here:
 *        1. A stream is funded ONLY by an explicit `fundPayrollStream`
 *           governance top-up. There is NO code path from a fee accrual
 *           or a treasury conversion into a stream's `funded` balance.
 *        2. Withdrawals are clamped to `funded` — the stream dries up
 *           unless governance deliberately tops it up. It is a salary,
 *           not a perpetual claim on protocol revenue.
 *
 *      Accrual math (per `LibVaipakam.PayrollStream`):
 *        accrued      = accruedAtAnchor
 *                       + (paused ? 0 : (now - lastRateChangeAt) * ratePerSecond)
 *        withdrawable = min(accrued, funded) - withdrawn
 *
 *      Phasing: `create` / `fund` / `setRate` / `pause` are ADMIN_ROLE
 *      (routed through the 48h Timelock post-handover); `withdrawSalary`
 *      stays beneficiary-callable with no delay — earned wages should
 *      not sit behind a governance timer.
 */
contract PayrollFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    using SafeERC20 for IERC20;

    // ─── Events ──────────────────────────────────────────────────────────

    /// @notice Emitted when a new salary stream is created.
    /// @custom:event-category state-change/treasury-mutation
    event PayrollStreamCreated(
        uint256 indexed streamId,
        address indexed beneficiary,
        address asset,
        uint256 ratePerSecond
    );

    /// @notice Emitted on a governance top-up of a stream's funded balance.
    /// @custom:event-category state-change/treasury-mutation
    event PayrollStreamFunded(
        uint256 indexed streamId,
        uint256 amount,
        uint256 newFunded
    );

    /// @notice Emitted when a stream's accrual rate is changed. Accrual
    ///         up to the change is settled at the old rate first.
    /// @custom:event-category state-change/treasury-mutation
    event PayrollRateSet(
        uint256 indexed streamId,
        uint256 oldRatePerSecond,
        uint256 newRatePerSecond
    );

    /// @notice Emitted when the beneficiary withdraws accrued salary.
    /// @custom:event-category state-change/treasury-mutation
    event SalaryWithdrawn(
        uint256 indexed streamId,
        address indexed beneficiary,
        uint256 amount
    );

    /// @notice Emitted when a stream is paused or unpaused.
    /// @custom:event-category state-change/treasury-mutation
    event PayrollStreamPauseSet(uint256 indexed streamId, bool paused);

    // ─── Errors ──────────────────────────────────────────────────────────

    // InvalidAddress inherited from IVaipakamErrors.
    /// @notice No stream exists for the given id.
    error PayrollStreamNotFound(uint256 streamId);
    /// @notice Caller is not the stream's beneficiary.
    error NotPayrollBeneficiary();
    /// @notice Nothing is currently withdrawable on this stream.
    error NothingToWithdraw();
    /// @notice Fund amount is zero.
    error ZeroFundAmount();
    /// @notice The treasury balance of the stream's asset is below the
    ///         requested funding amount.
    error PayrollTreasuryInsufficient(
        address asset,
        uint256 requested,
        uint256 available
    );
    /// @notice Payroll requires Diamond-as-treasury mode — funding draws
    ///         from `treasuryBalances`, which is only meaningful when
    ///         `s.treasury == address(this)`.
    error PayrollTreasuryNotDiamond();

    // ─── Admin: create / fund / rate / pause ─────────────────────────────

    /**
     * @notice Create a salary stream.
     * @dev ADMIN_ROLE-only (Timelock post-handover). The stream starts
     *      unfunded and unpaused; `ratePerSecond` may be zero (a later
     *      `setPayrollRate` activates accrual). Stream ids are 1-based.
     * @param beneficiary The only address that may withdraw (non-zero).
     * @param asset The ERC-20 paid out — WETH or a stablecoin (non-zero).
     * @param ratePerSecond Accrual rate, asset-wei per second.
     * @return streamId The new stream's id.
     */
    function createPayrollStream(
        address beneficiary,
        address asset,
        uint256 ratePerSecond
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) returns (uint256 streamId) {
        if (beneficiary == address(0) || asset == address(0)) {
            revert InvalidAddress();
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        streamId = ++s.payrollStreamCount;
        s.payrollStreams[streamId] = LibVaipakam.PayrollStream({
            beneficiary: beneficiary,
            asset: asset,
            ratePerSecond: ratePerSecond,
            funded: 0,
            withdrawn: 0,
            accruedAtAnchor: 0,
            lastRateChangeAt: uint64(block.timestamp),
            paused: false,
            exists: true
        });
        emit PayrollStreamCreated(streamId, beneficiary, asset, ratePerSecond);
    }

    /**
     * @notice Top up a stream's funded balance from the treasury.
     * @dev ADMIN_ROLE-only. This is the periodic budget top-up — the
     *      ONLY way a stream's `funded` grows. Debits
     *      `treasuryBalances[asset]` (an internal earmark — the tokens
     *      were already in the Diamond; they leave only on
     *      `withdrawSalary`). Reverts if the treasury balance is short.
     * @param streamId The stream to fund.
     * @param amount Asset-wei to move from treasury into the stream.
     */
    function fundPayrollStream(uint256 streamId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (amount == 0) revert ZeroFundAmount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.treasury != address(this)) revert PayrollTreasuryNotDiamond();
        LibVaipakam.PayrollStream storage st = _stream(s, streamId);

        uint256 available = s.treasuryBalances[st.asset];
        if (available < amount) {
            revert PayrollTreasuryInsufficient(st.asset, amount, available);
        }
        s.treasuryBalances[st.asset] = available - amount;
        st.funded += amount;
        emit PayrollStreamFunded(streamId, amount, st.funded);
    }

    /**
     * @notice Change a stream's accrual rate.
     * @dev ADMIN_ROLE-only — the revisable-salary lever. Accrual up to
     *      this moment is settled into `accruedAtAnchor` at the OLD rate
     *      first, so the change is never retroactive (no over- or
     *      under-payment for the elapsed window).
     * @param streamId The stream to retune.
     * @param newRatePerSecond The new accrual rate, asset-wei per second.
     */
    function setPayrollRate(uint256 streamId, uint256 newRatePerSecond)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.PayrollStream storage st = _stream(s, streamId);
        uint256 oldRate = st.ratePerSecond;
        _settleAccrual(st);
        st.ratePerSecond = newRatePerSecond;
        emit PayrollRateSet(streamId, oldRate, newRatePerSecond);
    }

    /**
     * @notice Pause or unpause a stream's accrual.
     * @dev ADMIN_ROLE-only. Accrual is settled to the anchor first, so a
     *      paused window simply does not accrue; unpausing resumes
     *      accrual from that moment. Does not affect already-accrued or
     *      funded balances — the beneficiary can still withdraw those.
     * @param streamId The stream to pause/unpause.
     * @param paused True to freeze accrual, false to resume.
     */
    function setPayrollStreamPaused(uint256 streamId, bool paused)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.PayrollStream storage st = _stream(s, streamId);
        _settleAccrual(st);
        st.paused = paused;
        emit PayrollStreamPauseSet(streamId, paused);
    }

    // ─── Beneficiary: withdraw ───────────────────────────────────────────

    /**
     * @notice Withdraw accrued, funded salary.
     * @dev Beneficiary-only. `withdrawable = min(accrued, funded) -
     *      withdrawn` — clamped to `funded`, so a stream the treasury
     *      has stopped topping up simply dries up. CEI + nonReentrant;
     *      Tier-1 sanctions-gated (value flows out to `msg.sender`).
     * @param streamId The stream to withdraw from.
     */
    function withdrawSalary(uint256 streamId)
        external
        nonReentrant
        whenNotPaused
    {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.PayrollStream storage st = _stream(s, streamId);
        if (msg.sender != st.beneficiary) revert NotPayrollBeneficiary();

        uint256 amount = _withdrawable(st);
        if (amount == 0) revert NothingToWithdraw();

        // CEI — record the withdrawal before the transfer.
        st.withdrawn += amount;
        IERC20(st.asset).safeTransfer(st.beneficiary, amount);
        emit SalaryWithdrawn(streamId, st.beneficiary, amount);
    }

    // ─── Views ───────────────────────────────────────────────────────────

    /**
     * @notice Full state of a salary stream.
     * @param streamId The stream to query.
     */
    function getPayrollStream(uint256 streamId)
        external
        view
        returns (LibVaipakam.PayrollStream memory stream)
    {
        return LibVaipakam.storageSlot().payrollStreams[streamId];
    }

    /**
     * @notice Currently-withdrawable salary on a stream.
     * @param streamId The stream to query.
     * @return amount `min(accrued, funded) - withdrawn`, in asset-wei.
     */
    function getWithdrawableSalary(uint256 streamId)
        external
        view
        returns (uint256 amount)
    {
        LibVaipakam.PayrollStream storage st =
            LibVaipakam.storageSlot().payrollStreams[streamId];
        if (!st.exists) return 0;
        return _withdrawable(st);
    }

    /// @notice Number of payroll streams ever created (ids are 1-based).
    function getPayrollStreamCount() external view returns (uint256) {
        return LibVaipakam.storageSlot().payrollStreamCount;
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    /// @dev Load a stream by id, reverting if it does not exist.
    function _stream(LibVaipakam.Storage storage s, uint256 streamId)
        private
        view
        returns (LibVaipakam.PayrollStream storage st)
    {
        st = s.payrollStreams[streamId];
        if (!st.exists) revert PayrollStreamNotFound(streamId);
    }

    /// @dev Total accrued to date: the settled anchor plus the live
    ///      window (zero while paused).
    function _accrued(LibVaipakam.PayrollStream storage st)
        private
        view
        returns (uint256)
    {
        if (st.paused) return st.accruedAtAnchor;
        return st.accruedAtAnchor
            + (block.timestamp - st.lastRateChangeAt) * st.ratePerSecond;
    }

    /// @dev Settle the live accrual window into the anchor and re-stamp
    ///      `lastRateChangeAt` — used before any rate / pause change so
    ///      the change is never retroactive.
    function _settleAccrual(LibVaipakam.PayrollStream storage st) private {
        st.accruedAtAnchor = _accrued(st);
        st.lastRateChangeAt = uint64(block.timestamp);
    }

    /// @dev Withdrawable = `min(accrued, funded) - withdrawn`. The clamp
    ///      to `funded` is the structural "salary, not perpetual claim"
    ///      guarantee.
    function _withdrawable(LibVaipakam.PayrollStream storage st)
        private
        view
        returns (uint256)
    {
        uint256 accrued = _accrued(st);
        uint256 payable_ = accrued < st.funded ? accrued : st.funded;
        // `withdrawn` can never exceed a prior `min(accrued, funded)`, and
        // both `accrued` and `funded` are monotone non-decreasing, so
        // `payable_ >= withdrawn` always holds.
        return payable_ - st.withdrawn;
    }
}
