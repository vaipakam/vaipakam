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

    /// @dev Phase 0 fixed rate: 1 VPFI (in 18-dec base units) costs
    ///      0.001 ETH = 1e15 wei. So `vpfiUnits = weiAmount * 1e18 /
    ///      RATE`. Same rate as `cfgVpfiBuyRate` for parity with the
    ///      buy flow.
    uint256 internal constant FIXED_VPFI_PER_ETH_RATE_WEI = 1e15;
    /// @dev Codex round-1 P1 — VPFI scaling factor (18 decimals). The
    ///      conversion `(wei * VPFI_DECIMALS_SCALE) / RATE` produces
    ///      raw VPFI base units (1e18 per VPFI).
    uint256 internal constant VPFI_DECIMALS_SCALE = 1e18;
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
    /// @dev Codex round-2 P2 #3 — TWAP max-age range. Lower bound
    ///      ensures observations aren't stale-fresh; upper bound
    ///      prevents an admin typo (`type(uint32).max`) from
    ///      silently making Phase-1 TWAP pricing accept years-old
    ///      observations.
    uint32 internal constant MIN_TWAP_MAX_AGE_SEC = 600;     // 10 min
    uint32 internal constant MAX_TWAP_MAX_AGE_SEC = 86_400;  // 24 h

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
        // Codex round-2 P2 #2 — reject non-contract VPFI address.
        // setVPFIToken does NOT enforce `code.length > 0`, so an
        // admin typo can set vpfiToken to an EOA. The low-level
        // transfer call below would succeed with empty return data
        // and our code would think the transfer worked — burning
        // the budget without paying anything.
        if (s.vpfiToken.code.length == 0) {
            emit KeeperRewardSkipped(keeper, actionKind, "vpfi-not-contract");
            return 0;
        }

        uint32 multBps = s.cfgKeeperRewardMultBps == 0
            ? DEFAULT_KEEPER_REWARD_MULT_BPS
            : s.cfgKeeperRewardMultBps;
        // ETH-equivalent value of the gas cost, then bumped by the
        // multiplier (e.g., 2x). The multiplier is bounded to
        // [1x, 10x] by the setter, so no risk of catastrophic overpay.
        uint256 ethEquivalent = (gasUsed * tx.gasprice * uint256(multBps)) / uint256(BPS_DENOM);
        // Codex round-1 P1 — scale by 1e18 so VPFI ends up in raw
        // 18-decimal units. Without the scale, a 0.012-ETH gas cost
        // (1.2e16 wei) divided by 1e15 = 12 raw units instead of the
        // intended 12e18 (12 VPFI tokens).
        uint256 vpfiAmount = (ethEquivalent * VPFI_DECIMALS_SCALE) / FIXED_VPFI_PER_ETH_RATE_WEI;
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

        // Codex round-1 P2 — defensive transfer. The library is
        // documented as never reverting, but `safeTransfer` can
        // bubble a revert if VPFI is paused, the diamond's actual
        // balance is below the accounted budget, or the token
        // rejects the destination. In those states a housekeeping
        // facet that calls us at the end would revert the whole
        // tx, breaking the no-revert contract. Use a low-level call
        // and on failure: restore the budget, emit Skipped, return 0.
        (bool ok, bytes memory ret) = s.vpfiToken.call(
            abi.encodeWithSelector(IERC20.transfer.selector, keeper, vpfiAmount)
        );
        // Codex round-2 P2 #1 — guard against malformed return data
        // (non-standard tokens / proxies returning < 32 bytes).
        // `abi.decode(ret, (bool))` would itself revert on a
        // short response, defeating the no-revert contract.
        bool returnedTrue = ret.length == 0
            || (ret.length >= 32 && abi.decode(ret, (bool)));
        if (!ok || !returnedTrue) {
            s.keeperRewardBudget = budget; // restore the debit
            emit KeeperRewardSkipped(keeper, actionKind, "transfer-failed");
            return 0;
        }

        emit KeeperRewardPaid(keeper, actionKind, gasUsed, ethEquivalent, vpfiAmount);
        return vpfiAmount;
    }
}
