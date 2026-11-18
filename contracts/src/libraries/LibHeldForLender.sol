// src/libraries/LibHeldForLender.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibInterestLedger} from "./LibInterestLedger.sol";
import {LibSanctionedLock} from "./LibSanctionedLock.sol";

/**
 * @title  LibHeldForLender
 * @author Vaipakam Developer Team
 * @notice #3629 — the one step that takes what is held for a lender position
 *         on an OPEN loan off the loan's books, so it can leave: to the
 *         position holder's vault (`ClaimFacet.claimHeldForLender`), or back
 *         behind the owner's standing intent (`LenderIntentFacet`'s roll and
 *         `recommitHeldToIntent`). The caller moves the funds; this library
 *         only settles the records, so every step that takes held value out
 *         settles them the same way.
 * @dev    What it settles, in order:
 *         - a recorded fail-closed claimant (a holder that was flagged when a
 *           payment was held) must read clean under the fail-closed screen,
 *           and the marker is then cleared;
 *         - the active-held reservation and, on an open loan, the
 *           lender-proceeds reservation (which there carries only the VPFI
 *           part of a held balance a sale credited, #597) are released, so
 *           the custody vault's withdraw guard sees the funds as free;
 *         - the interest ledger's parked interest is reported to the holder
 *           as paid and cleared, so a later sale cannot turn interest the
 *           holder already took into a seller claim against future payments;
 *         - the held ledger is zeroed.
 *         The final lender claim does not use it: on a terminal loan it
 *         releases both reservations for the whole claim, and the interest
 *         ledger is no longer read once the loan has ended.
 */
library LibHeldForLender {
    /**
     * @notice Takes everything held for `loan`'s lender position off the
     *         books and returns what it was and in which asset. No-op (0) when
     *         nothing is held.
     * @return amount What was held: the caller moves exactly this much out of
     *                `loan.lender`'s vault.
     * @return asset  The asset it is held in: the principal asset for an ERC-20
     *                loan, the prepay asset for an NFT rental.
     */
    function take(LibVaipakam.Storage storage s, uint256 loanId, LibVaipakam.Loan storage loan)
        internal
        returns (uint256 amount, address asset)
    {
        amount = s.heldForLender[loanId];
        if (amount == 0) return (0, address(0));
        asset = loan.assetType == LibVaipakam.AssetType.ERC20 ? loan.principalAsset : loan.prepayAsset;
        address frozen = LibSanctionedLock.frozenClaimant(s, loanId, true);
        if (frozen != address(0)) {
            LibVaipakam.assertNotSanctionedFailClosed(frozen);
            LibSanctionedLock.clearConfirmedFlag(s, frozen);
            LibSanctionedLock.clearFrozenClaimant(s, loanId, true);
        }
        LibEncumbrance.releaseActiveHeld(loanId, loan.lender);
        if (loan.status == LibVaipakam.LoanStatus.Active) {
            LibEncumbrance.releaseLenderProceeds(loanId, loan.lender);
        }
        LibVaipakam.InterestLedger storage l = s.interestLedger[loanId];
        if (l.parkedInterestGross != 0 || l.parkedInterestNet != 0) {
            LibInterestLedger.holderPaid(s, loan, l.parkedInterestGross);
            l.parkedInterestGross = 0;
            l.parkedInterestNet = 0;
            l.parkedInterestReservedNet = 0;
        }
        s.heldForLender[loanId] = 0;
        // #3413 / #3710 — what was held for the lender position left it (a
        // claim, a recommit to an intent): marked here, the one taker.
        LibPositionNFT.markLoanValueOut(loanId);
    }
}
