// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPermit2, ISignatureTransfer} from "./LibPermit2.sol";
import {LibEntitlement} from "./LibEntitlement.sol";

/**
 * @title  LibRefinancePayoff
 * @notice #1558: how the borrower pays their share of the old loan's payoff
 *         when a refinance completes. The borrower signs a single-use Permit2
 *         permit for that share and attaches it to their refinance request.
 *         The acceptance that completes the refinance (a lender accepting the
 *         request, or the matcher filling it; #3042 retired every other
 *         route) uses that permit once. The Diamond never holds a standing
 *         allowance for the payoff.
 * @dev    WHY. The payoff used to be pulled from the borrower's wallet on a
 *         standing ERC-20 allowance granted when the request was posted,
 *         because the pull runs in a transaction the borrower does not send.
 *         That allowance had to be sized for the worst case (the payoff at
 *         the end of the grace window), so a refinance that completed earlier
 *         left the difference approved. A request that failed left the whole
 *         allowance standing, and the app could not safely undo it, because
 *         a counterparty's acceptance could be in flight. A signed permit
 *         removes the shared figure: it is bounded by an amount and an
 *         expiry, Permit2 burns its nonce on first use, and an unused permit
 *         simply lapses.
 *
 *         THE WITNESS. The permit binds `RefinancePayoff(loanId, offerId)`
 *         into Permit2's digest, so a signature pays off this one loan through
 *         this one request and nothing else. Even a submitter who can pass any
 *         permit to the Diamond cannot spend it on another of the borrower's
 *         loans or requests.
 *
 *         ONE PULL, OF THE WALLET'S SHARE. Since #3042 the new lender's net
 *         principal (the new loan's principal less its initiation fee) pays
 *         the old lender vault to vault, inside the same transaction, and the
 *         wallet pays only the rest: the payoff minus that net principal,
 *         which is the old loan's interest (and any late fee) plus the new
 *         loan's initiation fee. The permit is single-use, so that share
 *         arrives in the Diamond in one measured pull, and the refinance sends
 *         the treasury's fee and the rest of the old lender's due on from
 *         there. A short arrival is refused, as every wallet pull is.
 *
 *         WHO MAY SET IT. Only the request's creator, and the payoff is drawn
 *         only from the current borrower-position holder. A refinance requires
 *         those to be the same person, and the signer is checked against the
 *         holder by name before Permit2 checks the signature.
 */
library LibRefinancePayoff {
    /// @notice The witness type, as Permit2 appends it to its own
    ///         `PermitWitnessTransferFrom(...)` stub. Per EIP-712 `encodeType`,
    ///         the referenced types follow in alphabetical order.
    string internal constant WITNESS_TYPE_STRING =
        "RefinancePayoff witness)"
        "RefinancePayoff(uint256 loanId,uint256 offerId)"
        "TokenPermissions(address token,uint256 amount)";

    /// @notice EIP-712 type hash of the witness struct.
    bytes32 internal constant WITNESS_TYPEHASH =
        keccak256("RefinancePayoff(uint256 loanId,uint256 offerId)");

    /// @notice The borrower attached a payoff permit to refinance request
    ///         `offerId`, replacing any earlier one.
    /// @param offerId   The refinance request (a borrower offer).
    /// @param signer    The request's creator, who signed the permit.
    /// @param maxAmount The most the permit lets the refinance pull.
    /// @param nonce     The permit's Permit2 nonce.
    /// @param deadline  When the permit expires.
    /// @custom:event-category state-change/consent
    event RefinancePayoffPermitSet(
        uint256 indexed offerId,
        address indexed signer,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline
    );

    /// @notice The borrower removed the payoff permit from request `offerId`.
    /// @custom:event-category state-change/consent
    event RefinancePayoffPermitCleared(uint256 indexed offerId, address indexed signer);

    /// @notice A refinance used the permit: `amount` of `asset`, the wallet's
    ///         share of the payoff, came from `payer`'s wallet into the Diamond
    ///         to pay off `loanId`. The permit's nonce is now spent and the
    ///         stored permit is gone.
    /// @custom:event-category informational/settlement
    event RefinancePayoffPulled(
        uint256 indexed loanId,
        uint256 indexed offerId,
        address indexed payer,
        address asset,
        uint256 amount,
        uint256 nonce
    );

    /// @notice Only the creator of borrower offer `offerId` may attach or
    ///         remove its payoff permit.
    error RefinancePayoffNotRequestCreator(uint256 offerId);
    /// @notice A permit must name a positive amount, an unexpired deadline and
    ///         a signature.
    error RefinancePayoffPermitInvalid();
    /// @notice Request `offerId` carries no payoff permit, so the refinance
    ///         cannot pay off the old loan.
    error RefinancePayoffPermitMissing(uint256 offerId);
    /// @notice The permit on request `offerId` was signed by `signer`, but the
    ///         payoff is drawn from the current borrower-position holder.
    error RefinancePayoffSignerNotHolder(uint256 offerId, address signer, address holder);
    /// @notice The wallet's share of the payoff (`amount`) is more than the
    ///         permit on request `offerId` allows.
    error RefinancePayoffAboveSigned(uint256 offerId, uint256 amount, uint256 maxAmount);
    /// @notice The permit on request `offerId` expired at `deadline`.
    error RefinancePayoffPermitExpired(uint256 offerId, uint256 deadline);

    /// @notice The payoff of `loanId` at time `at`: the principal, the
    ///         interest the exiting lender's settlement prices and any late
    ///         fee. The treasury's fee comes out of this sum, so it is the
    ///         whole amount the refinance pays out, however the yield fee
    ///         resolves (every branch only moves part of the treasury fee to
    ///         the lender).
    /// @dev    `RefinanceFacet`'s settlement distributes exactly this at
    ///         `block.timestamp`, from the new lender's net principal and the
    ///         wallet's share ({walletShareAt});
    ///         `RefinancePayoffFacet.getRefinancePayoff` reports it now and at a
    ///         moment the caller names.
    function amountAt(uint256 loanId, LibVaipakam.Loan storage loan, uint256 at)
        internal
        view
        returns (uint256)
    {
        return loan.principal
            + LibEntitlement.settlementInterestNet(loan, at)
            + LibVaipakam.calculateLateFeeAt(loanId, at);
    }

    /// @notice The most the wallet can pay when a request asking for
    ///         `requestAmount` refinances `loanId` at time `at`: the payoff
    ///         then, minus the least net principal the accept can deliver to
    ///         the old lender.
    /// @dev    The least net principal is `requestAmount` less the initiation
    ///         fee at the LIVE rate with no discount. A filled principal is
    ///         never below the request's amount, and a borrower discount or
    ///         Full tariff only lowers the fee, so the real net is at least
    ///         this and the real wallet share at most the figure returned. A
    ///         permit sized to it therefore covers every acceptance by `at`
    ///         unless governance raises the fee rate first. Floored at zero;
    ///         the settlement refuses a net above the old lender's due.
    function walletShareAt(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        uint256 requestAmount,
        uint256 at
    ) internal view returns (uint256) {
        uint256 payoff = amountAt(loanId, loan, at);
        uint256 minNet = requestAmount
            - (requestAmount * LibVaipakam.cfgLoanInitiationFeeBps()) / LibVaipakam.BASIS_POINTS;
        return payoff > minNet ? payoff - minNet : 0;
    }

    /// @notice The witness the permit binds: this loan, through this request.
    function witness(uint256 loanId, uint256 offerId) internal pure returns (bytes32) {
        return keccak256(abi.encode(WITNESS_TYPEHASH, loanId, offerId));
    }

    /// @notice Attach `msg.sender`'s payoff permit to their borrower offer
    ///         `offerId`. The signature is checked by Permit2 when it is used,
    ///         not here.
    function set(
        uint256 offerId,
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        if (offer.creator != msg.sender || offer.offerType != LibVaipakam.OfferType.Borrower) {
            revert RefinancePayoffNotRequestCreator(offerId);
        }
        if (maxAmount == 0 || deadline < block.timestamp || signature.length == 0) {
            revert RefinancePayoffPermitInvalid();
        }
        s.refinancePayoffPermit[offerId] = LibVaipakam.RefinancePayoffPermit({
            signer: msg.sender,
            maxAmount: maxAmount,
            nonce: nonce,
            deadline: deadline,
            signature: signature
        });
        emit RefinancePayoffPermitSet(offerId, msg.sender, maxAmount, nonce, deadline);
    }

    /// @notice Remove `msg.sender`'s payoff permit from request `offerId`.
    /// @dev    Keyed on the stored signer, so it works after the offer itself
    ///         is cancelled. Removing it here stops this Diamond using it; the
    ///         borrower can also spend the nonce in Permit2 itself.
    function clear(uint256 offerId) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address signer = s.refinancePayoffPermit[offerId].signer;
        if (signer == address(0) || signer != msg.sender) {
            revert RefinancePayoffNotRequestCreator(offerId);
        }
        delete s.refinancePayoffPermit[offerId];
        emit RefinancePayoffPermitCleared(offerId, signer);
    }

    /// @notice Pull the wallet's share of `loanId`'s payoff through request
    ///         `offerId`'s permit: `amount` of `asset` from `holder`'s wallet
    ///         into the Diamond, in full. Spends the permit.
    /// @dev    A zero share asks the wallet for nothing, so it needs no permit:
    ///         any stored one is discarded (its request is being consumed) and
    ///         Permit2 is not called. That happens only when the net principal
    ///         equals the old lender's due and the treasury fee is zero.
    function pull(
        uint256 loanId,
        uint256 offerId,
        address holder,
        address asset,
        uint256 amount
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (amount == 0) {
            delete s.refinancePayoffPermit[offerId];
            return;
        }
        LibVaipakam.RefinancePayoffPermit storage p = s.refinancePayoffPermit[offerId];
        if (p.signature.length == 0) revert RefinancePayoffPermitMissing(offerId);
        if (p.signer != holder) revert RefinancePayoffSignerNotHolder(offerId, p.signer, holder);
        if (amount > p.maxAmount) revert RefinancePayoffAboveSigned(offerId, amount, p.maxAmount);
        if (block.timestamp > p.deadline) revert RefinancePayoffPermitExpired(offerId, p.deadline);
        uint256 nonce = p.nonce;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: asset, amount: p.maxAmount}),
            nonce: nonce,
            deadline: p.deadline
        });
        bytes memory signature = p.signature;
        // Spent before the external call: Permit2 burns the nonce, and the
        // stored copy must never outlive it.
        delete s.refinancePayoffPermit[offerId];
        LibPermit2.pullWithWitness(
            holder,
            address(this),
            asset,
            amount,
            permit,
            witness(loanId, offerId),
            WITNESS_TYPE_STRING,
            signature
        );
        emit RefinancePayoffPulled(loanId, offerId, holder, asset, amount, nonce);
    }

    /// @notice Whether Permit2 has already spent `signer`'s `nonce`.
    /// @dev    Reads Permit2's unordered-nonce bitmap. A Permit2 that cannot be
    ///         read (no code on a test chain) reads as not spent.
    function nonceSpent(address signer, uint256 nonce) internal view returns (bool) {
        if (signer == address(0)) return false;
        (bool ok, bytes memory ret) = LibPermit2.PERMIT2.staticcall(
            abi.encodeCall(ISignatureTransfer.nonceBitmap, (signer, nonce >> 8))
        );
        if (!ok || ret.length < 32) return false;
        return (abi.decode(ret, (uint256)) >> (nonce & 0xff)) & 1 == 1;
    }
}
