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
 *         measured at the receiving end, and what a short arrival means is
 *         decided by the FLOW the move belongs to, never by the move alone:
 *
 *         1. A VOLUNTARY flow (someone chose to act now and could choose not
 *            to: a repayment, a preclose, a refinance, a swap-to-repay, a
 *            sale of a position, an offer acceptance, a rental day, an
 *            extension, a marketplace sale) refuses ANY short arrival by
 *            name, at every hop: the wallet pull ({pullExact}), the vault
 *            withdrawal (`LibFacet.vaultWithdrawExact`), the Diamond's own
 *            push onward ({pushExact}) and the credit into the receiving
 *            vault (`LibSanctionedLock.depositLockedInFull`). The party such a
 *            flow pays is booked as paid in full, and a token can charge one
 *            hop and not another, so measuring only the first hop is not
 *            enough. Refusing costs the actor nothing they cannot avoid by
 *            not acting.
 *         2. A FORCED close-out (liquidation, default, the periodic
 *            auto-liquidation, the fallback entry and retry) never stalls on a
 *            short arrival: it acts on what arrived ({pushMeasured},
 *            `LibFacet.vaultWithdrawDelivered`, `LibSanctionedLock.depositLocked`),
 *            and the ledger written beside a credit (a custody row, a lien, a
 *            claim) records that same figure. The shortfall reduces only that
 *            loan's own figures and is never drawn from tokens the protocol
 *            holds for anyone else, so the lender is still made whole as far
 *            as the position allows.
 *         3. Moves that book no counterparty as paid act on what arrived in
 *            EITHER flow, because refusing them protects nobody:
 *            - a fee drawn from a vault for the treasury
 *              (`TreasuryFeeFacet.collectFeeFromVault`, accrued as it arrived)
 *              or for a matcher: the fee's recipient bears the charge;
 *            - a payout of a user's own balance, or of a recorded claim to the
 *              claimant: refusing it would trap the recipient's own funds;
 *            - a position's backing following a transferred position NFT
 *              between the vaults of the SAME side of the loan
 *              (`LibConsolidation`): that side bears its own token's charge,
 *              its figures (collateral and lien, or the parked proceeds and
 *              their reservations) fall to what arrived, and the calling
 *              flow's own checks then run on those true figures. The
 *              counterparty is never recorded as holding more than exists.
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

    /// @dev What a move of `cap` of `token` from `from` delivered to `to`,
    ///      given `to`'s balance `before` the move: what that balance rose by,
    ///      never more than `cap` (and zero when it did not rise).
    ///
    ///      A move whose source IS its recipient (`from == to`: a vault-to-
    ///      vault move between two positions one user holds, a payer who is
    ///      also the payee) cannot raise the balance it starts from, so a
    ///      rise would read zero although nothing was lost. Such a holder
    ///      kept the whole amount less anything the move cost it (a token's
    ///      own charge), and that is what it delivered — `cap` for an
    ///      ordinary token. Every measurement goes through here, so the rule
    ///      holds for every outcome above.
    function measured(address token, address from, address to, uint256 before, uint256 cap)
        internal
        view
        returns (uint256 received)
    {
        uint256 balanceNow = IERC20(token).balanceOf(to);
        if (from == to) {
            uint256 cost = before > balanceNow ? before - balanceNow : 0;
            return cost < cap ? cap - cost : 0;
        }
        received = balanceNow > before ? balanceNow - before : 0;
        if (received > cap) received = cap;
    }

    /// @dev Refuse a delivery that fell short of what was requested.
    function requireFull(address token, uint256 requested, uint256 received) internal pure {
        if (received < requested) {
            revert IVaipakamErrors.TokenDeliveryShort(token, requested, received);
        }
    }

    /// @dev A wallet-funded pull, `from` -> `to`, on the allowance `from`
    ///      granted the Diamond. Refused unless `to` received all of `amount`,
    ///      in every flow: whoever pays from a wallet chose to pay (a
    ///      liquidator's payment in a forced flow included), and the books
    ///      around the pull are set at the requested figure. A zero amount
    ///      still runs the transfer, as the unmeasured call it replaces did.
    function pullExact(address token, address from, address to, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(to);
        // Every caller pulls from a party that approved the Diamond for this
        // move (the payer named by the calling flow). Not an arbitrary send.
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(token).safeTransferFrom(from, to, amount);
        requireFull(token, amount, measured(token, from, to, before, amount));
    }

    /// @dev A FORCED flow's push (outcome 2): the Diamond pushes `amount` to
    ///      `to` and learns what `to` received, never more than `amount`.
    function pushMeasured(address token, address to, uint256 amount)
        internal
        returns (uint256 delivered)
    {
        uint256 before = IERC20(token).balanceOf(to);
        IERC20(token).safeTransfer(to, amount);
        delivered = measured(token, address(this), to, before, amount);
    }

    /// @dev A VOLUNTARY flow's push (outcome 1): the Diamond pushes `amount`
    ///      to `to`, refused unless `to` received all of it.
    function pushExact(address token, address to, uint256 amount) internal {
        requireFull(token, amount, pushMeasured(token, to, amount));
    }
}
