// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  LibDelivery
 * @author Vaipakam Developer Team
 * @notice #2440 / #667 / #1281-011 — the one rule for what a token move
 *         delivered: the protocol books only what actually arrived.
 *
 *         A token can deliver less than it sends (a fee on transfer, share
 *         rounding, a rebase). The protocol does not support such tokens
 *         (FunctionalSpecs/WebsiteReadme: "the protocol's vault accounting
 *         cannot absorb fee-on-transfer tokens"), and this library is the
 *         on-chain half of that rule. Every move the protocol books is
 *         measured at the receiving end, and the measurement decides one of
 *         three outcomes by who is acting:
 *
 *         1. A payment or deposit funded from a WALLET (offer funding,
 *            repayment, preclose, refinance, a liquidator's payment, a
 *            treasury fee) is refused by name unless it arrived in full
 *            ({pullExact}). The books around it (offer amount, collateral
 *            lien, the lender's claim) are set at the requested figure, so a
 *            short arrival would leave a counterparty owed more than exists.
 *         2. A move out of a VAULT into the protocol is refused the same way
 *            when the owner chose to act now (a voluntary flow), and is acted
 *            on as it arrived when the protocol must complete it (a forced
 *            close-out: liquidation, default, the fallback retry). A forced
 *            close-out never stalls on a short arrival: the shortfall reduces
 *            that loan's own figures and is never drawn from tokens the
 *            protocol holds for anyone else, so the lender is still made
 *            whole as far as the position allows. A fee drawn from a vault
 *            into the TREASURY is accrued as it arrived in either case
 *            (`TreasuryFeeFacet.collectFeeFromVault`): no party is booked as
 *            paid by that leg, so the treasury bears the charge.
 *         3. A CREDIT into a vault records what the vault received, and the
 *            ledger written beside it (a custody row, a lien, a claim) uses
 *            that same figure ({pushMeasured}).
 *
 *         A delivery above the requested amount (a token that mints on
 *         transfer) is counted as the requested amount; the excess stays
 *         as unsolicited dust, outside every ledger.
 *
 * @dev    Measuring costs two `balanceOf` reads per move. For an ordinary
 *         ERC-20 the measured figure always equals the requested one, so
 *         every outcome above is identical to an unmeasured move.
 */
library LibDelivery {
    using SafeERC20 for IERC20;

    /// @dev What `who`'s balance of `token` rose by since `before`, never
    ///      more than `cap` (and zero when it did not rise).
    function measured(address token, address who, uint256 before, uint256 cap)
        internal
        view
        returns (uint256 received)
    {
        uint256 balanceNow = IERC20(token).balanceOf(who);
        received = balanceNow > before ? balanceNow - before : 0;
        if (received > cap) received = cap;
    }

    /// @dev Refuse a delivery that fell short of what was requested.
    function requireFull(address token, uint256 requested, uint256 received) internal pure {
        if (received < requested) {
            revert IVaipakamErrors.TokenDeliveryShort(token, requested, received);
        }
    }

    /// @dev Outcome 1: a wallet-funded pull, `from` -> `to`, on the allowance
    ///      `from` granted the Diamond. Refused unless `to` received all of
    ///      `amount`. A zero amount still runs the transfer, as the
    ///      unmeasured call it replaces did.
    function pullExact(address token, address from, address to, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(to);
        // Every caller pulls from a party that approved the Diamond for this
        // move (the payer named by the calling flow). Not an arbitrary send.
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(token).safeTransferFrom(from, to, amount);
        requireFull(token, amount, measured(token, to, before, amount));
    }

    /// @dev Outcome 3: the Diamond pushes `amount` to `to` and learns what
    ///      `to` received, never more than `amount`.
    function pushMeasured(address token, address to, uint256 amount)
        internal
        returns (uint256 delivered)
    {
        uint256 before = IERC20(token).balanceOf(to);
        IERC20(token).safeTransfer(to, amount);
        delivered = measured(token, to, before, amount);
    }
}
