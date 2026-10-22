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
 *            short arrival into the protocol's custody: it acts on what
 *            arrived ({pushMeasured}, `LibFacet.vaultWithdrawDelivered`,
 *            `LibSanctionedLock.depositLocked`), and the ledger written beside
 *            a credit (a custody row, a lien, a claim) records that same
 *            figure. The shortfall reduces only that loan's own figures and is
 *            never drawn from tokens the protocol holds for anyone else, so the
 *            lender is still made whole as far as the position allows. A
 *            forced flow's payment straight to a user's wallet is the
 *            exception: it refuses a short reading (see WHERE A READING CAN BE
 *            TRUSTED), and the position is then settled by the close-out that
 *            credits custody.
 *         3. Moves that book no counterparty as paid act on what arrived in
 *            EITHER flow, because refusing them protects nobody:
 *            - a fee for the treasury, drawn from a vault
 *              (`TreasuryFeeFacet.collectFeeFromVault`) or pushed from the
 *              Diamond (`TreasuryFeeFacet.collectFeeFromDiamond`, which every
 *              Diamond-held treasury share goes through), accrued as it
 *              arrived; or a fee for a matcher: the fee's recipient bears the
 *              charge;
 *            - a payout of a user's own balance, of a recorded claim to the
 *              claimant, or of a liquidator's or keeper's bonus ({pushOut}):
 *              refusing it would trap the recipient's own funds, and nothing is
 *              left owed on it;
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
 *         WHERE A READING CAN BE TRUSTED. A balance is a sound measure only
 *         where nobody but the token can change it during the move: the
 *         protocol's own custody (the Diamond, a user's vault, the treasury).
 *         A user's wallet is not such a place: its owner can lower the
 *         reading while the move runs (a receiving hook can forward the
 *         tokens on). So a reading taken at a wallet is trusted only to
 *         REFUSE, which that owner could already force by reverting the
 *         transfer. It is never used to book less than was sent and leave
 *         the rest owed to that owner, which would let the owner be paid
 *         again. Every payment to a wallet that books a party as paid
 *         therefore refuses a short reading in every flow ({pushExact},
 *         {pullExact}), and outcome 2's "acts on what arrived" applies to
 *         credits into custody only. A payout that books nobody by what
 *         arrives (outcome 3, {pushOut}) reads no wallet at all.
 *
 *         THE SENDER SIDE. A token can also charge its SENDER on top of the
 *         move (debit the amount plus a fee, credit the amount). Taken from
 *         custody, that excess would come out of tokens custody holds for
 *         someone else (the Diamond's other balances, or the vault holder's
 *         other positions), so every move out of custody is refused in every
 *         flow when it cost the sender more than it sent
 *         ({IVaipakamErrors.TokenOverDebit}; {pushMeasured}, {pushOut}, and
 *         `VaultFactoryFacet.vaultWithdrawERC20`). Such a token cannot be
 *         moved out of custody at all, a forced close-out included. A
 *         wallet-funded pull is not checked on this side: the payer's own
 *         wallet bears its own token's charge.
 *
 * @dev    Measuring costs two `balanceOf` reads per side. For an ordinary
 *         ERC-20 the measured figure always equals the requested one and the
 *         sender loses exactly what it sent, so every outcome above is
 *         identical to an unmeasured move.
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

    /// @dev Refuse a move out of custody that cost `sender` more than
    ///      `amount`, given its balance `senderBefore` the move (see THE
    ///      SENDER SIDE above). A rise is not a cost: tokens sent INTO custody
    ///      while the move ran are unsolicited dust, and ignoring them is what
    ///      keeps a receiving hook from turning this check into a refusal.
    function requireNoOverDebit(address token, address sender, uint256 senderBefore, uint256 amount)
        internal
        view
    {
        uint256 senderNow = IERC20(token).balanceOf(sender);
        if (senderBefore > senderNow && senderBefore - senderNow > amount) {
            revert IVaipakamErrors.TokenOverDebit(token, amount, senderBefore - senderNow);
        }
    }

    /// @dev A push into CUSTODY that a forced flow books by what arrived
    ///      (outcome 2: a vault credit, the treasury): the Diamond pushes
    ///      `amount` to `to` and learns what `to` received, never more than
    ///      `amount`. Never call it with a user's wallet as `to` and book the
    ///      result (see WHERE A READING CAN BE TRUSTED); a voluntary or
    ///      wallet payment refuses through {pushExact} instead.
    function pushMeasured(address token, address to, uint256 amount)
        internal
        returns (uint256 delivered)
    {
        uint256 senderBefore = IERC20(token).balanceOf(address(this));
        uint256 before = IERC20(token).balanceOf(to);
        IERC20(token).safeTransfer(to, amount);
        requireNoOverDebit(token, address(this), senderBefore, amount);
        delivered = measured(token, address(this), to, before, amount);
    }

    /// @dev A push that books its recipient as paid in full (outcome 1, and
    ///      a payment to a user's wallet that books a party as paid, in any
    ///      flow): the Diamond pushes `amount` to `to`, refused unless `to`
    ///      received all of it.
    function pushExact(address token, address to, uint256 amount) internal {
        requireFull(token, amount, pushMeasured(token, to, amount));
    }

    /// @dev A payout that books nobody by what arrives (outcome 3: a
    ///      liquidator's or keeper's bonus, a payout of a recorded claim or
    ///      of a user's own balance). The Diamond pushes `amount` to `to`;
    ///      the recipient bears its own token's charge on this hop, so no
    ///      reading is taken there. Refused only when the move cost the
    ///      Diamond more than `amount`.
    function pushOut(address token, address to, uint256 amount) internal {
        uint256 senderBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, amount);
        requireNoOverDebit(token, address(this), senderBefore, amount);
    }
}
