// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {RiskAccessFacet} from "../../src/facets/RiskAccessFacet.sol";

/**
 * @title LibAcceptTestSigner
 * @notice Test-only helper for the #662 anti-phishing accept binding. The four
 *         public accept entries now require an EIP-712-signed `AcceptTerms`
 *         (see `docs/DesignsAndPlans/OfferAcceptTermBindingDesign.md`), so every
 *         test that accepts an offer must build the typed struct from the stored
 *         offer and sign it with the acceptor's key.
 *
 * @dev    A **library**, not a base contract, so it works from ANY test
 *         regardless of whether it inherits `SetupTest` or bare `forge-std/Test`
 *         (OfferFacetTest etc. are `is Test`). It reaches the `vm` cheatcode via
 *         the canonical hevm address, and reads the stored offer + digest +
 *         liquidity through the diamond's external views — so the only thing a
 *         caller supplies is `(diamond, acceptor, acceptorPk, offerId)`.
 *
 *         **Acceptors MUST have a private key.** Create them with
 *         `makeAddrAndKey` (which yields the SAME address as `makeAddr` plus the
 *         key, so existing address assertions are unchanged) and pass that key.
 *
 *         **Nonce = offerId.** The contract's replay ledger is keyed
 *         `(acceptor, nonce)`; an offer is acceptable at most once, so `offerId`
 *         is a collision-free per-acceptor nonce with no counter state (which a
 *         library can't hold). A reverted accept rolls back the nonce mark, so a
 *         revert-then-retry on the same offer still works.
 */
library LibAcceptTestSigner {
    Vm private constant vm =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Build the `AcceptTerms` the contract will accept for `offerId`,
    ///         mirroring `OfferAcceptFacet._bindTermsToOffer`'s role-correct
    ///         endpoint + acknowledged-illiquid selection exactly.
    /// @param linkedLoanId The auto-linked sale/offset target loan id for a
    ///        sale-vehicle / offset accept; 0 for a normal offer.
    function buildTerms(
        address diamond,
        address acceptor,
        uint256 offerId,
        bool consent,
        uint256 linkedLoanId
    ) internal view returns (LibAcceptTerms.AcceptTerms memory t) {
        LibVaipakam.Offer memory o = OfferCancelFacet(diamond).getOffer(offerId);
        bool isERC20 = o.assetType == LibVaipakam.AssetType.ERC20;
        bool isLender = o.offerType == LibVaipakam.OfferType.Lender;
        t.acceptor = acceptor;
        t.offerCreator = o.creator;
        t.offerKey = keccak256(abi.encode(offerId)); // direct-path offerKey (client-side)
        t.offerType = uint8(o.offerType);
        t.lendingAsset = o.lendingAsset;
        t.collateralAsset = o.collateralAsset;
        t.amount = isERC20 ? (isLender ? o.amountMax : o.amount) : o.amount;
        t.collateralAmount = o.collateralAmount;
        t.interestRateBps = isERC20
            ? (isLender ? o.interestRateBps : o.interestRateBpsMax)
            : o.interestRateBps;
        t.durationDays = o.durationDays;
        t.tokenId = o.tokenId;
        t.collateralTokenId = o.collateralTokenId;
        t.quantity = o.quantity;
        t.collateralQuantity = o.collateralQuantity;
        t.assetType = uint8(o.assetType);
        t.collateralAssetType = uint8(o.collateralAssetType);
        t.prepayAsset = o.prepayAsset;
        t.useFullTermInterest = o.useFullTermInterest;
        t.allowsPartialRepay = o.allowsPartialRepay;
        t.allowsPrepayListing = o.allowsPrepayListing;
        t.allowsParallelSale = o.allowsParallelSale;
        t.refinanceTargetLoanId = o.refinanceTargetLoanId;
        t.linkedLoanId = linkedLoanId;
        t.parallelSaleOrderHash = o.parallelSaleOrderHash;
        t.periodicInterestCadence = uint8(o.periodicInterestCadence);
        t.riskAndTermsConsent = consent;
        t.acknowledgedIlliquidLendingAsset = _ack(diamond, o.lendingAsset);
        t.acknowledgedIlliquidCollateralAsset = _ack(diamond, o.collateralAsset);
        t.nonce = offerId; // collision-free per acceptor (offer accepted once)
        t.deadline = block.timestamp + 1 hours;
        // #730 — stamp the live risk-terms HASH so the #662⇄#671 illiquid
        // ack-substitution gate sees a FRESH acknowledgement (a governance bump
        // re-derives the hash and re-locks any ack signed against the old one).
        t.riskTermsHash = _currentRiskTermsHash(diamond);
    }

    /// @notice #951 v2 (bind-to-live) — build `AcceptTerms` for a lender-sale
    ///         vehicle accept. A sale-vehicle buyer binds principal / collateral /
    ///         duration against the LIVE linked loan, NOT the offer snapshot (the
    ///         offer's `amount`/`durationDays` are display-only and its
    ///         `collateralAmount` is 0), so this overrides those three fields from
    ///         `s.loans[linkedLoanId]`. This mirrors what the frontend must sign
    ///         for a sale accept. `collateralAmount` is set to the live floor; a
    ///         caller testing the `>=` floor can lower it further before signing.
    function buildSaleTerms(
        address diamond,
        address acceptor,
        uint256 offerId,
        bool consent,
        uint256 linkedLoanId
    ) internal view returns (LibAcceptTerms.AcceptTerms memory t) {
        t = buildTerms(diamond, acceptor, offerId, consent, linkedLoanId);
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(linkedLoanId);
        t.amount = loan.principal;
        t.collateralAmount = loan.collateralAmount;
        t.durationDays = loan.durationDays;
    }

    /// @dev The diamond's `currentRiskTermsHash`, read DEFENSIVELY: minimal-cut
    ///      tests (e.g. OfferFacetTest) may not route `RiskAccessFacet`, and such
    ///      a diamond can't enable the risk gate anyway, so a missing selector ⇒
    ///      `bytes32(0)` is correct. A `staticcall` (not a typed call) lets the read
    ///      degrade to 0 instead of reverting the whole accept.
    function _currentRiskTermsHash(address diamond)
        private
        view
        returns (bytes32)
    {
        (bool ok, bytes memory ret) = diamond.staticcall(
            abi.encodeWithSelector(
                RiskAccessFacet.getCurrentRiskTermsHash.selector
            )
        );
        return (ok && ret.length >= 32) ? abi.decode(ret, (bytes32)) : bytes32(0);
    }

    /// @notice ECDSA-sign an `AcceptTerms` digest with `pk` → packed `(r,s,v)`.
    /// @dev    Recovers the digest off-chain via {LibAcceptTerms.digestFor} (the
    ///         on-chain `hashAcceptTerms` view was removed for EIP-170 headroom —
    ///         #730); `digestFor` binds the same `verifyingContract` (= `diamond`)
    ///         the runtime `verify` uses, so the recovered signature matches.
    function sign(address diamond, LibAcceptTerms.AcceptTerms memory t, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = LibAcceptTerms.digestFor(t, diamond);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Sign + accept `offerId` as `acceptor` (consent=true, no link).
    ///         Use this for happy-path accepts. For an `expectRevert` test, call
    ///         {buildTerms} + {sign} FIRST (their diamond view-calls would
    ///         otherwise consume the `expectRevert`), then `vm.expectRevert`,
    ///         `vm.prank`, and the typed `acceptOffer(offerId, t, sig)` directly.
    function signAndAccept(
        address diamond,
        address acceptor,
        uint256 pk,
        uint256 offerId
    ) internal returns (uint256) {
        return signAndAccept(diamond, acceptor, pk, offerId, true, 0);
    }

    /// @notice Sign + accept with explicit consent + linked-loan target (sale /
    ///         offset vehicles), or a deliberately-false consent.
    function signAndAccept(
        address diamond,
        address acceptor,
        uint256 pk,
        uint256 offerId,
        bool consent,
        uint256 linkedLoanId
    ) internal returns (uint256) {
        LibAcceptTerms.AcceptTerms memory t =
            buildTerms(diamond, acceptor, offerId, consent, linkedLoanId);
        bytes memory sig = sign(diamond, t, pk);
        vm.prank(acceptor);
        return OfferAcceptFacet(diamond).acceptOffer(offerId, t, sig);
    }

    function _ack(address diamond, address leg) private view returns (address) {
        if (leg == address(0)) return address(0);
        return
            OracleFacet(diamond).checkLiquidity(leg) ==
                LibVaipakam.LiquidityStatus.Illiquid
                ? leg
                : address(0);
    }
}
