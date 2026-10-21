// src/facets/TreasuryFeeFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {ITreasuryFeeHost} from "../interfaces/ITreasuryFeeHost.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title TreasuryFeeFacet
 * @author Vaipakam Developer Team
 * @notice The one host of the fee legs into the treasury: a fee drawn from a
 *         payer's wallet and a fee drawn from a user's vault. Each moves the
 *         fee, measures what the treasury received, and records the accrual
 *         (#2440, #1281-011).
 * @dev Part of the Diamond Standard (EIP-2535).
 *
 *      THE RULE (see {LibDelivery}): the protocol books only what arrived.
 *      - From a WALLET the fee is refused by name
 *        ({IVaipakamErrors.TokenDeliveryShort}) unless the treasury received
 *        all of it. The payer is outside the protocol and the protocol does
 *        not support tokens that deliver less than they send, so such a token
 *        is stopped at the door.
 *      - From a VAULT the treasury accrues what reached it and the leg never
 *        refuses. The vault gives up the full amount (its tracked balance
 *        falls by exactly that); no party is booked as paid by this leg, so
 *        the treasury, the protocol's own account, bears a token's transfer
 *        charge, and a close-out is never stopped over it. This is how a fee
 *        switched on mid-loan by an upgradeable token is absorbed.
 *
 *      WHY A FACET OF ITS OWN: before #2440 each settlement facet inlined the
 *      transfer and the accrual (the accrual carries the oracle pricing of
 *      the fee-event log). Measuring the transfer pushed PrecloseFacet, which
 *      charges fees at three sites, over the EIP-170 limit. Hosting both legs
 *      here leaves each caller one self-call, the same shape as
 *      {SwapAttemptFacet} (#2472) and {OfferAcceptFeeFacet} (#1835).
 *
 *      WHO CALLS IT: `LibFacet.transferFromPayerToTreasury` (RepayFacet,
 *      PrecloseFacet, RefinanceFacet, EarlyWithdrawalFacet) and
 *      `LibFacet.vaultFeeToTreasury` (RepayFacet, RepayPeriodicFacet,
 *      PrecloseFacet, DefaultedFacet, OfferAcceptFeeFacet). A Diamond that
 *      routes any of them must route this facet too, or every fee they charge
 *      reverts `FunctionDoesNotExist` at the self-call (a hard revert, never a
 *      silently skipped fee).
 *
 *      TRUST MODEL: the `address(this)` gate is the whole of it. A wallet pull
 *      spends an allowance the payer granted the Diamond, and a vault leg
 *      moves a user's vault balance, so neither may be reachable from outside
 *      the Diamond. The treasury is read from storage, never taken from the
 *      caller. There is no reentrancy guard of its own: every caller already
 *      holds the Diamond guard and has checked pause, and a token re-entering
 *      these selectors fails the gate.
 */
contract TreasuryFeeFacet is ITreasuryFeeHost, IVaipakamErrors {
    /// @inheritdoc ITreasuryFeeHost
    function collectFeeFromPayer(address payer, address asset, uint256 amount) external {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        if (amount == 0) return;
        LibDelivery.pullExact(asset, payer, LibVaipakam.storageSlot().treasury, amount);
        LibFacet.recordTreasuryAccrual(asset, amount);
    }

    /// @inheritdoc ITreasuryFeeHost
    function collectFeeFromVault(address user, address asset, uint256 amount)
        external
        returns (uint256 accrued)
    {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        if (amount == 0) return 0;
        accrued = LibFacet.vaultWithdrawDelivered(
            user,
            asset,
            LibVaipakam.storageSlot().treasury,
            amount,
            TreasuryTransferFailed.selector
        );
        LibFacet.recordTreasuryAccrual(asset, accrued);
    }
}
