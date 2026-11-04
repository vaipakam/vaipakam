// src/facets/RefinancePayoffFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibRefinancePayoff} from "../libraries/LibRefinancePayoff.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RefinancePayoffFacet
 * @author Vaipakam Developer Team
 * @notice The borrower's side of paying off a loan by refinance (#1558): the
 *         single-use Permit2 permit the borrower attaches to a refinance
 *         request, its removal, and the view that sizes it.
 * @dev Part of the Diamond Standard (EIP-2535).
 *
 *      WHY A FACET OF ITS OWN: the refinance itself (`RefinanceFacet`) USES
 *      the permit, once, inside the settlement; this facet is where the
 *      borrower GIVES and WITHDRAWS it and reads what it must cover. The two
 *      meet only in `LibRefinancePayoff` (the stored permit and the payoff
 *      rule). Hosting the authorisation surface with the settlement had put
 *      `RefinanceFacet` 260 bytes over the EIP-170 limit.
 *
 *      Both facets read the stored permit's layout, so they are refreshed
 *      together. `RedeployFacets` refuses a Diamond that does not already
 *      route this facet's entry, so it cannot be the refresh that moves a
 *      chain from the standing allowance to the permit.
 */
contract RefinancePayoffFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    /// @notice Attach a single-use Permit2 permit to your refinance request
    ///         `offerId`, authorising the refinance to pull your wallet's share
    ///         of the old loan's payoff. Replaces any permit already attached.
    /// @dev    Sign a Permit2 `PermitWitnessTransferFrom` with the Diamond as
    ///         spender, the old loan's principal asset as the token, `maxAmount`
    ///         as the amount, and the witness
    ///         `RefinancePayoff(uint256 loanId,uint256 offerId)` for the loan
    ///         the request refinances (see `LibRefinancePayoff`). Size
    ///         `maxAmount` with {getRefinancePayoff}'s `walletShareBy` for the
    ///         permit's `deadline`: the most your wallet's share can reach while
    ///         the permit can still be used. The new loan's net principal pays
    ///         the rest of the payoff directly (#3042). The acceptance that
    ///         completes the refinance uses the permit once, and only for your
    ///         share at that moment; the rest of `maxAmount` is never pulled
    ///         and nothing stays approved. Permit2 checks the signature when it
    ///         is used, so a bad one fails the refinance, not this call.
    ///         Requires the wallet's one-time ERC-20 approval of Permit2.
    ///         Tier-1 sanctions-gated: it authorises a payment.
    /// @param offerId   Your borrower offer (the refinance request).
    /// @param maxAmount The most the permit allows the refinance to pull.
    /// @param nonce     The permit's Permit2 nonce.
    /// @param deadline  When the permit expires.
    /// @param signature Your signature over the permit.
    function setRefinancePayoffPermit(
        uint256 offerId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibRefinancePayoff.set(offerId, maxAmount, nonce, deadline, signature);
    }

    /// @notice Remove your payoff permit from request `offerId`, so no
    ///         refinance can use it. Works after the request is cancelled, and
    ///         while the protocol is paused, because withdrawing consent must
    ///         always be possible.
    function clearRefinancePayoffPermit(uint256 offerId) external nonReentrant {
        LibRefinancePayoff.clear(offerId);
    }

    /// @notice What a refinance of `loanId` through request `offerId` would pay
    ///         off, now and by time `by`, and the permit it would pay with.
    /// @param  by               The moment to size the payoff for: pass the
    ///                          permit's deadline, which is the request's last
    ///                          fillable moment. Read as no earlier than now and
    ///                          no later than the end of the old loan's grace
    ///                          window, after which no refinance can complete;
    ///                          `type(uint256).max` therefore reads the grace end.
    /// @return asset            The old loan's principal asset.
    /// @return payoffNow        The payoff if the refinance completed now: the
    ///                          principal, the interest the exiting lender is
    ///                          owed, and any late fee. The treasury's fee
    ///                          comes out of it.
    /// @return payoffBy         The payoff at `by`. The payoff never falls as
    ///                          time passes, so this is the most it can be up
    ///                          to then.
    /// @return walletShareNow   The most the wallet would pay if the request
    ///                          were accepted now: the payoff less the least
    ///                          net principal the request delivers to the old
    ///                          lender (its amount less the initiation fee at
    ///                          the live rate, before any discount).
    /// @return walletShareBy    The same at `by`. A permit for this much covers
    ///                          any acceptance of the request by then, unless
    ///                          governance raises the initiation-fee rate first.
    /// @return signer           Who signed the attached permit (0 if none).
    /// @return maxAmount        The most the permit allows.
    /// @return nonce            The permit's Permit2 nonce.
    /// @return deadline         When the permit expires.
    /// @return nonceSpent       Whether Permit2 has already spent that nonce,
    ///                          in which case the permit can no longer pay.
    /// @dev    Both payoffs read 0 unless `loanId` is an Active ERC-20 loan.
    ///         A pause that begins after this read moves the grace end, and the
    ///         payoff at a given moment with it; the figure is as of this block.
    ///         The wallet shares read the request's amount from `offerId`; for
    ///         an `offerId` with no stored offer (a request about to be
    ///         posted) they assume a request for the outstanding principal.
    ///         Informational: whether the request could be accepted at all is
    ///         `RefinanceFacet.checkRefinanceRequest`'s answer.
    function getRefinancePayoff(uint256 loanId, uint256 offerId, uint256 by)
        external
        view
        returns (
            address asset,
            uint256 payoffNow,
            uint256 payoffBy,
            uint256 walletShareNow,
            uint256 walletShareBy,
            address signer,
            uint256 maxAmount,
            uint256 nonce,
            uint256 deadline,
            bool nonceSpent
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        asset = loan.principalAsset;
        if (
            loan.status == LibVaipakam.LoanStatus.Active &&
            loan.assetType == LibVaipakam.AssetType.ERC20
        ) {
            // A request not posted yet (no stored offer) is sized as one
            // asking for the outstanding principal, which is what a refinance
            // request asks for.
            uint256 requestAmount = s.offers[offerId].amount;
            if (requestAmount == 0) requestAmount = loan.principal;
            payoffNow = LibRefinancePayoff.amountAt(loanId, loan, block.timestamp);
            walletShareNow = LibRefinancePayoff.walletShareAt(loanId, loan, requestAmount, block.timestamp);
            uint256 graceEnd = LibLoanClock.graceEnd(loan);
            uint256 at = by < graceEnd ? by : graceEnd;
            if (at > block.timestamp) {
                payoffBy = LibRefinancePayoff.amountAt(loanId, loan, at);
                walletShareBy = LibRefinancePayoff.walletShareAt(loanId, loan, requestAmount, at);
            } else {
                payoffBy = payoffNow;
                walletShareBy = walletShareNow;
            }
        }
        LibVaipakam.RefinancePayoffPermit storage p = s.refinancePayoffPermit[offerId];
        signer = p.signer;
        maxAmount = p.maxAmount;
        nonce = p.nonce;
        deadline = p.deadline;
        nonceSpent = LibRefinancePayoff.nonceSpent(signer, nonce);
    }
}
