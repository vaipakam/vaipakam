// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LibKeeperReward — T-087 Sub 3 add-on #474
 *
 * Phase-0 keeper reward payment: a housekeeping facet (sweep, force-
 * resend, periodic interest accrual, mirror cache catchup, etc.)
 * calls `payVpfiReward(keeper, gasUsedEstimate)` at the end of its
 * work. The library computes the ETH-equivalent value of the keeper's
 * gas cost times the configured multiplier, converts to VPFI at the
 * Phase-0 fixed rate (1 VPFI = 0.001 ETH = 1e15 wei), debits the
 * keeper reward budget, and transfers VPFI to the keeper.
 *
 * Phase 0 deliberately uses a FIXED rate. Phase 1 wires the VPFI/ETH
 * LP TWAP path with the `cfgKeeperRewardTwapMaxAgeSec` staleness
 * fallback to fixed-rate.
 *
 * No-revert path: if the kill-switch is off, the budget is exhausted,
 * or the gas is negligible, the function returns 0 without reverting.
 * Housekeeping must continue — the keeper just runs at a loss until
 * the budget refills.
 */
library LibKeeperReward {
    using SafeERC20 for IERC20;

    /// @dev Phase 0 fixed rate: 1 VPFI = 0.001 ETH (1e15 wei).
    ///      Same rate as `cfgVpfiBuyRate` for parity with the buy flow.
    uint256 internal constant FIXED_VPFI_PER_ETH_RATE_WEI = 1e15;
    /// @dev Default multiplier: 2x gas (20000 bps). uint32 because
    ///      the 100000-bps upper bound exceeds uint16 max.
    uint32 internal constant DEFAULT_KEEPER_REWARD_MULT_BPS = 20_000;
    /// @dev Lower bound: 1x (10000 bps) — keeper at least breaks even on gas.
    uint32 internal constant MIN_KEEPER_REWARD_MULT_BPS = 10_000;
    /// @dev Upper bound: 10x (100000 bps) — anti-fat-finger.
    uint32 internal constant MAX_KEEPER_REWARD_MULT_BPS = 100_000;
    /// @dev Default cash-out spread: 5% (500 bps).
    uint16 internal constant DEFAULT_CASH_OUT_SPREAD_BPS = 500;
    /// @dev Lower bound: 1% (100 bps).
    uint16 internal constant MIN_CASH_OUT_SPREAD_BPS = 100;
    /// @dev Upper bound: 20% (2000 bps).
    uint16 internal constant MAX_CASH_OUT_SPREAD_BPS = 2_000;
    /// @dev Basis points denominator.
    uint16 internal constant BPS_DENOM = 10_000;

    /// @custom:event-category state-change/keeper-reward
    event KeeperRewardPaid(
        address indexed keeper,
        bytes32 indexed actionKind,
        uint256 gasUsed,
        uint256 ethEquivalent,
        uint256 vpfiPaid
    );
    /// @custom:event-category informational/keeper-reward
    event KeeperRewardSkipped(
        address indexed keeper,
        bytes32 indexed actionKind,
        string reason
    );

    /**
     * @dev Pay the keeper a VPFI reward for `gasUsed` at `tx.gasprice`.
     *      Returns the VPFI amount paid (zero if skipped). Never
     *      reverts — housekeeping must complete regardless.
     *
     *      `actionKind` is a discriminator (e.g.,
     *      `keccak256("sweep")`) the indexer uses to attribute
     *      reward spend by housekeeping category.
     */
    function payVpfiReward(
        address keeper,
        bytes32 actionKind,
        uint256 gasUsed
    ) internal returns (uint256 vpfiPaid) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (!s.cfgKeeperRewardEnabled) {
            emit KeeperRewardSkipped(keeper, actionKind, "disabled");
            return 0;
        }
        if (gasUsed == 0 || tx.gasprice == 0) {
            emit KeeperRewardSkipped(keeper, actionKind, "no-gas");
            return 0;
        }
        if (s.vpfiToken == address(0)) {
            emit KeeperRewardSkipped(keeper, actionKind, "no-vpfi-token");
            return 0;
        }

        uint32 multBps = s.cfgKeeperRewardMultBps == 0
            ? DEFAULT_KEEPER_REWARD_MULT_BPS
            : s.cfgKeeperRewardMultBps;
        // ETH-equivalent value of the gas cost, then bumped by the
        // multiplier (e.g., 2x). The multiplier is bounded to
        // [1x, 10x] by the setter, so no risk of catastrophic overpay.
        uint256 ethEquivalent = (gasUsed * tx.gasprice * uint256(multBps)) / uint256(BPS_DENOM);
        // Phase 0 fixed-rate conversion: VPFI = ethEquivalent / rate.
        // rate is `wei per VPFI`, so VPFI count = wei / rate.
        uint256 vpfiAmount = ethEquivalent / FIXED_VPFI_PER_ETH_RATE_WEI;
        if (vpfiAmount == 0) {
            emit KeeperRewardSkipped(keeper, actionKind, "below-min-vpfi");
            return 0;
        }

        // Bound payout by available budget. If budget < computed reward,
        // pay what we can (partial). Housekeeping continues regardless.
        uint256 budget = s.keeperRewardBudget;
        if (budget == 0) {
            emit KeeperRewardSkipped(keeper, actionKind, "budget-empty");
            return 0;
        }
        if (vpfiAmount > budget) {
            vpfiAmount = budget;
        }

        s.keeperRewardBudget = budget - vpfiAmount;
        IERC20(s.vpfiToken).safeTransfer(keeper, vpfiAmount);

        emit KeeperRewardPaid(keeper, actionKind, gasUsed, ethEquivalent, vpfiAmount);
        return vpfiAmount;
    }
}
