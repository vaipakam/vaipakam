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
    ///         `offerId`, authorising the refinance to pay off the old loan
    ///         from your wallet. Replaces any permit already attached.
    /// @dev    Sign a Permit2 `PermitWitnessTransferFrom` with the Diamond as
    ///         spender, the old loan's principal asset as the token, `maxAmount`
    ///         as the amount, and the witness
    ///         `RefinancePayoff(uint256 loanId,uint256 offerId)` for the loan
    ///         the request refinances (see `LibRefinancePayoff`). Size
    ///         `maxAmount` with {getRefinancePayoff}'s `payoffAtGraceEnd`, the
    ///         most the payoff can reach before the request lapses. Whoever
    ///         completes the refinance uses the permit once, and only for the
    ///         payoff at that moment; the rest of `maxAmount` is never pulled
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
    ///         off, and the permit it would pay with.
    /// @return asset            The old loan's principal asset.
    /// @return payoffNow        The payoff if the refinance completed now: the
    ///                          principal, the interest the exiting lender is
    ///                          owed, and any late fee. The treasury's fee
    ///                          comes out of it.
    /// @return payoffAtGraceEnd The payoff at the end of the old loan's grace
    ///                          window, the most it can be while the request
    ///                          stands. A permit for this much covers any
    ///                          moment of the request's life.
    /// @return signer           Who signed the attached permit (0 if none).
    /// @return maxAmount        The most the permit allows.
    /// @return nonce            The permit's Permit2 nonce.
    /// @return deadline         When the permit expires.
    /// @return nonceSpent       Whether Permit2 has already spent that nonce,
    ///                          in which case the permit can no longer pay.
    /// @dev    Both payoffs read 0 unless `loanId` is an Active ERC-20 loan.
    ///         Informational: whether the request could be accepted at all is
    ///         `RefinanceFacet.checkRefinanceRequest`'s answer.
    function getRefinancePayoff(uint256 loanId, uint256 offerId)
        external
        view
        returns (
            address asset,
            uint256 payoffNow,
            uint256 payoffAtGraceEnd,
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
            payoffNow = LibRefinancePayoff.amountAt(loanId, loan, block.timestamp);
            uint256 graceEnd = LibLoanClock.graceEnd(loan);
            payoffAtGraceEnd = LibRefinancePayoff.amountAt(
                loanId, loan, graceEnd > block.timestamp ? graceEnd : block.timestamp
            );
        }
        LibVaipakam.RefinancePayoffPermit storage p = s.refinancePayoffPermit[offerId];
        signer = p.signer;
        maxAmount = p.maxAmount;
        nonce = p.nonce;
        deadline = p.deadline;
        nonceSpent = LibRefinancePayoff.nonceSpent(signer, nonce);
    }
}
