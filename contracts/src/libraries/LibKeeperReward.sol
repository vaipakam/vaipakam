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

        // Codex round-1..4 P2 — defensive transfer with balance-
        // delta as the authoritative success signal. The library is
        // documented as never reverting; safeTransfer could bubble a
        // revert; high-level balanceOf could revert on malformed
        // tokens; abi.decode of return data could revert on quirky
        // proxies; short truthy returns could falsely register as
        // failure. The simplest robust approach: snapshot keeper's
        // balance via LOW-LEVEL staticcall, attempt the transfer via
        // LOW-LEVEL call, snapshot again, success ⇔ balance moved by
        // ≥ vpfiAmount. We don't decode the boolean return at all —
        // the balance-delta is the only signal that survives all the
        // failure modes Codex enumerated.
        uint256 keeperBalanceBefore = _safeBalanceOf(s.vpfiToken, keeper);
        // Codex round-6 P2 #3 — fire-and-check transfer with bounded
        // return data (retSize=0; we ignore the return). A hostile
        // token returning oversized data can't OOG us — assembly's
        // call() never materialises returndata that we didn't ask
        // for into memory.
        bool ok = _safeTransfer(s.vpfiToken, keeper, vpfiAmount);
        uint256 keeperBalanceAfter = _safeBalanceOf(s.vpfiToken, keeper);
        // Codex round-5 P2 #1 — overflow-safe delta. A hostile token
        // returning near-max-uint256 from balanceOf could otherwise
        // overflow `keeperBalanceBefore + vpfiAmount`.
        uint256 actuallyMoved = 0;
        if (keeperBalanceAfter > keeperBalanceBefore) {
            unchecked { actuallyMoved = keeperBalanceAfter - keeperBalanceBefore; }
        }
        // Codex round-6 P2 #2 — fee-on-transfer correctness. The
        // diamond's balance dropped by the FULL `vpfiAmount`
        // regardless of what the keeper received (the token took
        // any fee from the diamond's side). Debit the full
        // requested amount from the budget so future rewards
        // don't double-spend the missing fee. Emit Paid for what
        // the keeper actually received, so the indexer sees the
        // truth.
        if (!ok || actuallyMoved == 0) {
            s.keeperRewardBudget = budget; // nothing moved; restore
            emit KeeperRewardSkipped(keeper, actionKind, "transfer-failed");
            return 0;
        }

        // Emit Paid with `actuallyMoved` (what the keeper got) — the
        // budget was already debited by the full `vpfiAmount` above.
        emit KeeperRewardPaid(keeper, actionKind, gasUsed, ethEquivalent, actuallyMoved);
        return actuallyMoved;
    }

    /// @dev Codex round-4..6 — low-level balanceOf that never
    ///      reverts AND bounds returndata to 32 bytes.
    ///
    ///      Build calldata in Solidity (canonical
    ///      `abi.encodeWithSelector(...)`) so the selector + arg
    ///      packing is guaranteed correct regardless of compiler
    ///      bytes4-on-stack convention. Only the staticcall + the
    ///      return-data read use assembly, for the bounded retSize.
    function _safeBalanceOf(address token, address who)
        private
        view
        returns (uint256 bal)
    {
        bytes memory data = abi.encodeWithSelector(IERC20.balanceOf.selector, who);
        assembly {
            // staticcall with returnSize=32 — caps the copy
            // regardless of the callee's actual returndatasize().
            // Write the (at most 32 bytes) return to scratch slot 0.
            let ok := staticcall(
                gas(),
                token,
                add(data, 32),   // skip the 32-byte length prefix
                mload(data),     // the actual data length
                0,
                32
            )
            if and(ok, gt(returndatasize(), 31)) {
                bal := mload(0)
            }
        }
    }

    /// @dev Codex round-6 P2 #3 — low-level transfer with returndata
    ///      copy disabled (retSize=0). A hostile token returning
    ///      oversized data can't OOG the housekeeping path. We don't
    ///      read the return — the balance-delta in the caller is
    ///      the authoritative success signal.
    function _safeTransfer(address token, address to, uint256 amount)
        private
        returns (bool ok)
    {
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, to, amount);
        assembly {
            ok := call(
                gas(),
                token,
                0,               // no ETH
                add(data, 32),
                mload(data),
                0,
                0                // returnSize=0 — don't copy returndata
            )
        }
    }
}
