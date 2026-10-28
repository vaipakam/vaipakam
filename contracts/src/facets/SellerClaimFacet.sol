// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibCloseoutFreeze} from "../libraries/LibCloseoutFreeze.sol";
import {LibInterestLedger} from "../libraries/LibInterestLedger.sol";
import {LibNumeraireValueRead} from "../libraries/LibNumeraireValueRead.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {NumeraireValueFacet} from "./NumeraireValueFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title  SellerClaimFacet
 * @author Vaipakam Developer Team
 * @notice #1209 — pays the interest a lender who SOLD their position earned
 *         while they held it. A sale turns the seller's earned and unpaid
 *         interest into a seller claim on the loan ({LibInterestLedger}); this
 *         facet is where those claims are paid:
 *
 *         - **While the loan is open**, every interest payout to the lender
 *           side reaches {paySellersFirst} before the holder is paid. The open
 *           claims take the slice first, oldest first, each up to what it is
 *           owed, and each seller's share goes into their own vault.
 *         - **At a terminal**, the lender claim row is split once
 *           ({resolveSellerClaims}): the holder's principal first, then the
 *           seller claims oldest first, then the holder takes the rest. The
 *           split runs when the holder claims or when a seller claims,
 *           whichever is first, so neither waits on the other.
 *         - **The backstop buyout** of a fallback lender slice splits its cash
 *           the same way ({settleSellerClaimsFrom}).
 *
 *         A seller withdraws what has reached their vault with {claimAsSeller}.
 *
 * @dev    Why the seller's share goes to their vault and not their wallet: an
 *         interest payout is part of someone else's transaction (the
 *         borrower's repayment, a keeper's settlement), and a past lender's
 *         wallet must never be able to refuse it. A vault deposit cannot be
 *         refused, and a share paid to a flagged seller simply waits: the claim
 *         is screened fail-closed.
 *
 *         Every share is paid NET of the fee. Inline, a seller bears the fee
 *         the slice actually paid (its own net-to-gross proportion). At a
 *         terminal the claim row is already net of the loan's snapshot fee, so
 *         a seller is owed their gross less that fee.
 *
 *         Terminal ranking (owner decision 2026-10-28, "principal first"):
 *         - A claim in the PRINCIPAL asset ranks by amount.
 *         - A claim in another ERC-20 (the collateral, in kind) ranks by value
 *           through the shared numeraire rule, the recovery read as a LIQUID
 *           value (an illiquid asset is worth 0, as everywhere else).
 *         - A recovery that cannot be valued, or an NFT, cannot show that the
 *           holder's principal was covered, so the holder keeps all of it and
 *           the seller claims close unpaid.
 *         Whatever a claim is not paid is stated in {SellerInterestClaimClosed}.
 */
contract SellerClaimFacet is DiamondReentrancyGuard, DiamondPausable {
    error OnlyDiamondInternal();
    /// @notice The loan has not reached a terminal whose lender claim is final
    ///         (it is open, or its fallback is still pending).
    error SellerClaimsNotFinal(uint256 loanId);
    /// @notice Nothing is waiting for this seller on this loan.
    error NothingToClaimAsSeller(uint256 loanId, address seller);

    /// @notice A seller's share of an interest payout on an open loan reached
    ///         their vault.
    /// @param gross    The gross interest taken off their claim.
    /// @param net      Their share of it after the fee this slice paid.
    /// @param credited What their vault received (below `net` only for a token
    ///                 that charges on transfer).
    /// @custom:event-category state-change/claim-mutation
    event SellerInterestPaid(
        uint256 indexed loanId,
        address indexed seller,
        address asset,
        uint256 gross,
        uint256 net,
        uint256 credited
    );

    /// @notice A seller claim closed at a terminal.
    /// @param grossOwed What the claim was owed, gross of the fee.
    /// @param netOwed   What it was owed after the fee, in the principal asset.
    /// @param asset     The asset the recovery was paid in.
    /// @param paid      What left the recovery for this seller, in `asset`.
    /// @param fullyPaid Whether `paid` covered `netOwed`. When false the
    ///                  shortfall is unpaid and nothing on the loan owes it.
    /// @custom:event-category state-change/claim-mutation
    event SellerInterestClaimClosed(
        uint256 indexed loanId,
        address indexed seller,
        uint256 grossOwed,
        uint256 netOwed,
        address asset,
        uint256 paid,
        bool fullyPaid
    );

    /// @notice A seller withdrew what was waiting for them on a loan.
    /// @custom:event-category state-change/claim-mutation
    event SellerInterestWithdrawn(
        uint256 indexed loanId,
        address indexed seller,
        address asset,
        uint256 amount
    );

    modifier onlyDiamondInternal() {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        _;
    }

    // ─── Inline payout (open loan) ─────────────────────────────────────────

    /// @notice Pays the open seller claims out of an interest slice, before
    ///         the holder. Reached only through {LibInterestLedger.paySellersFirst}.
    /// @param payer `address(0)` when the slice sits in the Diamond; otherwise
    ///              the wallet funding it, which approved the Diamond.
    /// @return sellersGross The gross interest the claims took.
    /// @return sellersNet   What left the slice for the sellers; the caller
    ///                      pays the holder that much less.
    function paySellersFirst(
        uint256 loanId,
        address payer,
        address asset,
        uint256 interestGross,
        uint256 interestNet
    ) external onlyDiamondInternal returns (uint256 sellersGross, uint256 sellersNet) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibInterestLedger.SellerShare[] memory shares;
        (shares, sellersGross, sellersNet) =
            LibInterestLedger.takeForSellers(s, loanId, interestGross, interestNet);
        for (uint256 i; i < shares.length; ++i) {
            LibInterestLedger.SellerShare memory sh = shares[i];
            if (sh.gross == 0) continue;
            uint256 credited;
            if (sh.net > 0) {
                if (payer == address(0)) {
                    credited = LibSanctionedLock.depositLocked(s, sh.seller, loanId, asset, sh.net);
                } else {
                    // A voluntary payment: refused unless it all arrived.
                    LibSanctionedLock.depositLockedFrom(s, payer, sh.seller, loanId, asset, sh.net);
                    credited = sh.net;
                }
                LibEncumbrance.encumberSellerInterest(loanId, sh.seller, asset, credited);
            }
            emit SellerInterestPaid(loanId, sh.seller, asset, sh.gross, sh.net, credited);
        }
    }

    // ─── Terminal ──────────────────────────────────────────────────────────

    /// @notice Splits a terminal lender claim between the holder and the open
    ///         seller claims, once. `ClaimFacet` calls it before paying the
    ///         holder; {claimAsSeller} calls it for a seller who claims first.
    /// @dev    No-op when no claim is open. Reverts {SellerClaimsNotFinal}
    ///         while the lender claim can still change.
    function resolveSellerClaims(uint256 loanId) external onlyDiamondInternal {
        _resolve(LibVaipakam.storageSlot(), loanId);
    }

    /// @notice Splits a terminal recovery that does not go through the claim
    ///         row (the backstop's cash buyout of a fallback lender slice):
    ///         pays the seller claims their ranked part of `recovery` out of
    ///         `fromUser`'s vault and closes every claim.
    /// @return paid What left `fromUser`'s vault for the sellers; the caller
    ///              pays the holder `recovery - paid`.
    function settleSellerClaimsFrom(
        uint256 loanId,
        address fromUser,
        address asset,
        uint256 recovery
    ) external onlyDiamondInternal returns (uint256 paid) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        paid = _splitAndPay(s, loanId, s.loans[loanId], fromUser, asset, recovery, false);
    }

    // ─── Seller entry ──────────────────────────────────────────────────────

    /// @notice Withdraws what is waiting for the caller as a past seller of
    ///         `loanId`'s lender position. On a loan whose lender claim is
    ///         final it first splits that claim, if nobody has yet.
    /// @dev    Screened fail-closed: a seller confirmed flagged cannot withdraw
    ///         during an oracle outage. Whatever reached their vault stays there
    ///         until they read clean.
    function claimAsSeller(uint256 loanId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (LibSanctionedLock.mustFreezeParty(s, msg.sender)) {
            revert LibVaipakam.SanctionedAddress(msg.sender);
        }
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (s.sellerInterestClaims[loanId].length != 0 && _final(loan)) {
            _resolve(s, loanId);
        }
        uint256 total = _withdraw(loanId, msg.sender, loan.principalAsset);
        address other = s.lenderClaims[loanId].asset;
        if (other != address(0) && other != loan.principalAsset) {
            total += _withdraw(loanId, msg.sender, other);
        }
        if (total == 0) revert NothingToClaimAsSeller(loanId, msg.sender);
    }

    // ─── Views ─────────────────────────────────────────────────────────────

    /// @notice A loan's interest ledger: what the current holder has earned and
    ///         not been paid as of now, the principal the lender side is owed,
    ///         the last checkpoint, and the open seller claims, oldest first.
    function getInterestLedger(uint256 loanId)
        external
        view
        returns (
            uint256 holderEarned,
            uint256 principalOwed,
            uint64 touchedAt,
            LibVaipakam.SellerInterestClaim[] memory sellerClaims
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        holderEarned = LibInterestLedger.holderEarnedNow(s, loan);
        principalOwed = LibInterestLedger.principalOwed(s, loan);
        touchedAt = s.interestLedger[loanId].touchedAt;
        sellerClaims = s.sellerInterestClaims[loanId];
    }

    /// @notice What is waiting in `seller`'s vault for them on `loanId`, in
    ///         `asset`, ready for {claimAsSeller}.
    function getSellerInterestHeld(uint256 loanId, address seller, address asset)
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().sellerInterestHeld[loanId][seller][asset];
    }

    // ─── Internal ──────────────────────────────────────────────────────────

    /// @dev A lender claim is final once the loan is in a lender-claimable
    ///      terminal other than FallbackPending (whose claim-time retry can
    ///      still rewrite the row), or Settled.
    function _final(LibVaipakam.Loan storage loan) private view returns (bool) {
        return loan.status == LibVaipakam.LoanStatus.Settled ||
            (loan.status != LibVaipakam.LoanStatus.FallbackPending &&
                LibCloseoutFreeze.lenderClaimableStatus(loan.status));
    }

    function _resolve(LibVaipakam.Storage storage s, uint256 loanId) private {
        if (s.sellerInterestClaims[loanId].length == 0) return;
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (!_final(loan)) revert SellerClaimsNotFinal(loanId);
        LibVaipakam.ClaimInfo storage claim = s.lenderClaims[loanId];
        // A claim already paid, not in an ERC-20, or never written has nothing
        // to split: the seller claims close unpaid (recovery 0).
        uint256 recovery = claim.claimed || claim.asset == address(0) ||
            claim.assetType != LibVaipakam.AssetType.ERC20 ? 0 : claim.amount;
        _splitAndPay(s, loanId, loan, loan.lender, claim.asset, recovery, true);
    }

    /// @dev Ranks `recovery` (in `asset`) between the holder's principal and
    ///      the open seller claims, pays each seller's part from `fromUser`'s
    ///      vault into their own, and closes every claim. With `fromClaimRow`
    ///      the recovery is the terminal lender claim row: the sellers' part
    ///      comes off the row and off its lender-proceeds reservation BEFORE it
    ///      leaves the stored lender's vault, so the withdraw guard lets it go
    ///      and the rest stays reserved for the holder.
    function _splitAndPay(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address fromUser,
        address asset,
        uint256 recovery,
        bool fromClaimRow
    ) private returns (uint256 paid) {
        LibVaipakam.SellerInterestClaim[] memory claims = LibInterestLedger.closeAll(s, loanId);
        uint256 feeBps = LibVaipakam.effectiveTreasuryFeeBps(loan);
        uint256[] memory pays = _rank(s, loan, claims, asset, recovery, feeBps);
        for (uint256 i; i < pays.length; ++i) paid += pays[i];
        if (fromClaimRow && paid > 0) {
            LibEncumbrance.reduceLenderProceeds(loanId, fromUser, asset, paid);
            s.lenderClaims[loanId].amount -= paid;
        }
        for (uint256 i; i < claims.length; ++i) {
            _closeOne(s, loanId, loan, fromUser, asset, claims[i], pays[i], feeBps);
        }
    }

    /// @dev Pays one closing seller claim its part `pay` of the recovery from
    ///      `fromUser`'s vault into the seller's own, reserved for
    ///      {claimAsSeller}, and records how the claim closed. Its own frame.
    function _closeOne(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address fromUser,
        address asset,
        LibVaipakam.SellerInterestClaim memory claim,
        uint256 pay,
        uint256 feeBps
    ) private {
        if (pay > 0) {
            uint256 credited = LibSanctionedLock.depositLockedFromVault(
                s, fromUser, claim.seller, loanId, asset, pay
            );
            LibEncumbrance.encumberSellerInterest(loanId, claim.seller, asset, credited);
        }
        uint256 netOwed =
            (claim.grossOwed * (LibVaipakam.BASIS_POINTS - feeBps)) / LibVaipakam.BASIS_POINTS;
        bool fullyPaid = asset == loan.principalAsset
            ? pay >= netOwed
            : pay > 0 && _valueCovers(loan, asset, pay, netOwed);
        emit SellerInterestClaimClosed(loanId, claim.seller, claim.grossOwed, netOwed, asset, pay, fullyPaid);
    }

    /// @dev The terminal ranking: the holder's principal first, then each
    ///      seller's net claim oldest first. See the contract notes.
    function _rank(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        LibVaipakam.SellerInterestClaim[] memory claims,
        address asset,
        uint256 recovery,
        uint256 feeBps
    ) private view returns (uint256[] memory pays) {
        pays = new uint256[](claims.length);
        if (recovery == 0 || asset == address(0)) return pays;
        uint256 owedPrincipal = LibInterestLedger.principalOwed(s, loan);
        if (asset == loan.principalAsset) {
            uint256 pool = recovery > owedPrincipal ? recovery - owedPrincipal : 0;
            for (uint256 i; i < claims.length && pool > 0; ++i) {
                uint256 netOwed =
                    (claims[i].grossOwed * (LibVaipakam.BASIS_POINTS - feeBps)) / LibVaipakam.BASIS_POINTS;
                uint256 pay = netOwed < pool ? netOwed : pool;
                pays[i] = pay;
                pool -= pay;
            }
            return pays;
        }
        // In kind: rank by value. A recovery that reads no liquid value, or a
        // principal that cannot be valued, cannot show the principal covered.
        uint256 recoveryValue = _liquidValue(asset, recovery);
        (bool okP, uint256 principalValue) =
            LibNumeraireValueRead.tryValue(loan.principalAsset, owedPrincipal, true);
        if (recoveryValue == 0 || !okP || (owedPrincipal > 0 && principalValue == 0)) return pays;
        uint256 poolValue = recoveryValue > principalValue ? recoveryValue - principalValue : 0;
        for (uint256 i; i < claims.length && poolValue > 0; ++i) {
            uint256 netOwed =
                (claims[i].grossOwed * (LibVaipakam.BASIS_POINTS - feeBps)) / LibVaipakam.BASIS_POINTS;
            (bool ok, uint256 owedValue) = LibNumeraireValueRead.tryValue(loan.principalAsset, netOwed, true);
            if (!ok) continue;
            uint256 payValue = owedValue < poolValue ? owedValue : poolValue;
            poolValue -= payValue;
            pays[i] = (recovery * payValue) / recoveryValue;
        }
    }

    /// @dev Whether `pay` of `asset` is worth at least `netOwed` of the
    ///      principal asset, for the in-kind {SellerInterestClaimClosed} flag.
    function _valueCovers(LibVaipakam.Loan storage loan, address asset, uint256 pay, uint256 netOwed)
        private
        view
        returns (bool)
    {
        (bool ok, uint256 owedValue) = LibNumeraireValueRead.tryValue(loan.principalAsset, netOwed, true);
        return ok && _liquidValue(asset, pay) >= owedValue;
    }

    function _liquidValue(address asset, uint256 amount) private view returns (uint256 value) {
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeCall(NumeraireValueFacet.getLiquidNumeraireValue, (asset, amount))
        );
        if (ok && ret.length >= 32) value = abi.decode(ret, (uint256));
    }

    function _withdraw(uint256 loanId, address seller, address asset) private returns (uint256 amount) {
        amount = LibEncumbrance.releaseSellerInterest(loanId, seller, asset);
        if (amount == 0) return 0;
        LibFacet.crossFacetCall(
            abi.encodeCall(VaultFactoryFacet.vaultWithdrawERC20, (seller, asset, seller, amount)),
            bytes4(0)
        );
        emit SellerInterestWithdrawn(loanId, seller, asset, amount);
    }
}
