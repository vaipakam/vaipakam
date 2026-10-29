// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibInterestLedger} from "../libraries/LibInterestLedger.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {LibSaleSolvency} from "../libraries/LibSaleSolvency.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {EarlyWithdrawalFacet} from "./EarlyWithdrawalFacet.sol";
import {EarlyWithdrawalDirectFacet} from "./EarlyWithdrawalDirectFacet.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title  SaleExitVerdictFacet
 * @author Vaipakam Developer Team
 * @notice The ONE answer to "may this lender exit by sale right now, and if
 *         not, why and until when" (#1841), for both lender exit routes: the
 *         direct sale into a standing buy offer (`sellLoanViaBuyOffer`) and the
 *         listing (`createLoanSaleOffer`).
 *
 * @dev    The entries do not carry their own copy of these checks. Each one
 *         calls {requireSaleExitOpen} through the Diamond and reverts with the
 *         first refusal it returns, and {saleExitVerdict} reports every refusal
 *         from the same classifier, so the lender exit chooser cannot show an
 *         exit the contract would refuse, or hide one it would accept, for any
 *         reason this facet classifies. This is the `saleAdmission` precedent
 *         one level wider: the logic lives once on a facet with room for it,
 *         and the entries (both near EIP-170) pay only for the call.
 *
 *         A refusal is the ABI-encoded custom error the entry raises for it,
 *         not a code: the reason a client decodes is the contract's own error,
 *         named in the Diamond ABI, so there is no second schema (no enum or
 *         bit table) for a client to mirror and let drift.
 *
 *         What it does NOT cover, stated so a clear verdict is not read as more
 *         than it is:
 *         - Anything about the buy offer a direct sale consumes (its shape,
 *           terms, expiry, amount, the rate shortfall it implies, the buyer's
 *           screening and risk access). The verdict takes no offer; whether a
 *           matching offer exists is a book question for the sale tool.
 *         - The listing's own inputs: its window length, rate and consent.
 *         - A keeper caller's service-capacity charge on the listing route.
 *         A clear verdict therefore means "the loan and this caller may sell",
 *         and the chosen offer or listing inputs can still be refused.
 *
 *         Periodic interest is not a refusal on either route: neither entry
 *         checks overdue periodic interest or the periodic switch.
 */
contract SaleExitVerdictFacet {
    /// @notice The two lender exit routes the verdict answers for.
    enum SaleRoute {
        Direct,
        Listing
    }

    /// @notice One reason a route is refused.
    /// @param reason    The custom error the route's entry raises for it,
    ///                  ABI-encoded (selector and arguments); decode it with the
    ///                  Diamond ABI.
    /// @param reopensAt The earliest time this refusal can lift by time alone
    ///                  or by a permissionless step anyone may take (tearing
    ///                  down an expired listing or offset). 0 when no time is
    ///                  known: it needs a decision (an unpause, a cancel by the
    ///                  offer's creator, a price move) or never lifts.
    struct SaleRefusal {
        bytes reason;
        uint64 reopensAt;
    }

    /// @dev Upper bound on refusals per route; sized above the classifier's count.
    uint256 private constant MAX_REFUSALS = 24;

    /// @dev A fixed-capacity refusal list built in memory, trimmed on return.
    struct Refusals {
        SaleRefusal[] items;
        uint256 count;
        bool stopAtFirst;
    }

    /**
     * @notice Every refusal each lender exit route raises for `loanId` and
     *         `caller` right now. An empty list means the route is open as far
     *         as this facet classifies (see the contract notes).
     * @param  loanId The loan whose lender position would be sold.
     * @param  caller The address that would submit the sale: the position
     *                holder, or (listing only) a keeper acting for it. The
     *                verdict is caller-relative and must not be reused across a
     *                wallet change.
     * @return direct  Refusals of `sellLoanViaBuyOffer`, in the order the entry
     *                 meets them (the entry raises the first).
     * @return listing Refusals of `createLoanSaleOffer`, likewise.
     */
    function saleExitVerdict(uint256 loanId, address caller)
        external
        view
        returns (SaleRefusal[] memory direct, SaleRefusal[] memory listing)
    {
        direct = _classify(loanId, caller, SaleRoute.Direct, false);
        listing = _classify(loanId, caller, SaleRoute.Listing, false);
    }

    /**
     * @notice Reverts with the first refusal `route` raises for `loanId` and
     *         `caller`; returns when there is none.
     * @dev    Called by both sale entries through the Diamond, with the
     *         entry's own `msg.sender` as `caller`. Stops at the first refusal,
     *         so the oracle-reaching admission check runs only on a sale every
     *         cheaper check admits.
     */
    function requireSaleExitOpen(uint256 loanId, address caller, SaleRoute route)
        external
        view
    {
        SaleRefusal[] memory refusals = _classify(loanId, caller, route, true);
        if (refusals.length != 0) {
            bytes memory reason = refusals[0].reason;
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    /**
     * @notice Reverts with the sale-admission refusal for `loanId`, if any:
     *         the solvency floor, the LTV cap, an unpriceable leg, or terms the
     *         buyer would inherit on worse footing than a fresh loan.
     * @dev    The admission guard (`LibSaleSolvency.assertSaleSolvent`) behind
     *         an external entry, so {saleExitVerdict} can collect its revert
     *         data with try/catch. The guard's typed reverts are the one
     *         mapping from classifier codes to errors, and running it here
     *         keeps every admission error in this facet's ABI.
     */
    function requireSaleAdmission(uint256 loanId) external view {
        LibSaleSolvency.assertSaleSolvent(loanId);
    }

    function _classify(uint256 loanId, address caller, SaleRoute route, bool stopAtFirst)
        private
        view
        returns (SaleRefusal[] memory)
    {
        Refusals memory r = Refusals(new SaleRefusal[](MAX_REFUSALS), 0, stopAtFirst);
        bool listing = route == SaleRoute.Listing;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // The global pause (both entries are `whenNotPaused`). An auto-pause
        // window names its end; a manual pause names none.
        if (LibPausable.paused()) {
            _add(
                r,
                abi.encodeWithSelector(LibPausable.EnforcedPause.selector),
                // forge-lint: disable-next-line(unsafe-typecast)
                LibPausable.manuallyPaused() ? 0 : uint64(LibPausable.pausedUntil())
            );
            if (_full(r)) return _trim(r);
        }

        // Tier-1 screen of the submitting address (fail-open, as at the entry).
        bool callerFlagged = LibVaipakam.isSanctionedAddress(caller);
        if (callerFlagged) {
            _add(r, abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, caller), 0);
            if (_full(r)) return _trim(r);
        }

        // Both routes require an Active loan. A loan with no live lender
        // position (never created, or closed and its NFT burned) is not Active
        // either; nothing below applies to it.
        address holder = LibERC721._ownerOfRaw(loan.lenderTokenId);
        if (loan.status != LibVaipakam.LoanStatus.Active || holder == address(0)) {
            _add(r, abi.encodeWithSelector(IVaipakamErrors.LoanNotActive.selector), 0);
            return _trim(r);
        }

        // Who may submit. The direct sale settles to its caller, so only the
        // holder may, with no exception. The listing admits an authorised
        // keeper for the holder, and the Diamond's own self-call (the rule
        // `LibAuth.requireKeeperFor` has always applied to that entry).
        if (caller != holder) {
            if (!listing) {
                _add(r, abi.encodeWithSelector(IVaipakamErrors.NotNFTOwner.selector), 0);
                if (_full(r)) return _trim(r);
            } else if (
                caller != address(this) &&
                !LibAuth.keeperMayActFor(
                    caller, LibVaipakam.KEEPER_ACTION_INIT_EARLY_WITHDRAW, loanId, holder
                )
            ) {
                _add(r, abi.encodeWithSelector(IVaipakamErrors.KeeperAccessRequired.selector), 0);
                if (_full(r)) return _trim(r);
            }
        }

        // The holder receives the proceeds. The listing screens it fail-open
        // at creation; the direct sale moves the position under the fail-closed
        // move gate, which refuses a confirmed flag during an oracle outage too.
        if (
            !(callerFlagged && holder == caller) &&
            (listing
                ? LibVaipakam.isSanctionedAddress(holder)
                : LibVaipakam.positionMovePartyBlocked(holder))
        ) {
            _add(r, abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, holder), 0);
            if (_full(r)) return _trim(r);
        }

        // A rental (NFT principal) cannot be sold on either route.
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            _add(r, abi.encodeWithSelector(IVaipakamErrors.InvalidSaleOffer.selector), 0);
            if (_full(r)) return _trim(r);
        }
        // #1209 — the sale records the holder's earned-unpaid interest as a
        // seller claim, and a loan carries a bounded number of open claims.
        // Older claims are paid from the borrower's later interest, so the
        // refusal lifts as they are paid; it names no reopening time.
        if (
            loan.assetType == LibVaipakam.AssetType.ERC20 &&
            !LibInterestLedger.saleClaimRoom(s, loanId, holder)
        ) {
            _add(
                r,
                abi.encodeWithSelector(
                    LibInterestLedger.SellerClaimsFull.selector,
                    loanId,
                    s.sellerInterestClaims[loanId].length
                ),
                0
            );
            if (_full(r)) return _trim(r);
        }
        // #1209 — interest parked for a frozen holder is paid to the seller at
        // the sale; it waits on the recorded frozen claimant, so a different
        // claimant who is still blocked refuses the sale (one rule, shared
        // with the settlement).
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            address blocker = LibInterestLedger.parkedSaleBlocker(s, loanId, holder);
            if (blocker != address(0)) {
                _add(r, abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, blocker), 0);
                if (_full(r)) return _trim(r);
            }
        }
        // The listing vehicle escrows no collateral, so it needs ERC-20 collateral.
        if (listing && loan.collateralAssetType != LibVaipakam.AssetType.ERC20) {
            _add(
                r,
                abi.encodeWithSelector(EarlyWithdrawalFacet.SaleOfferCollateralMustBeERC20.selector),
                0
            );
            if (_full(r)) return _trim(r);
        }

        // A linked listing closes both routes until it is cancelled, completed
        // or torn down. Teardown is permissionless once the listing has expired
        // unaccepted, so the earliest teardown is the later of now and its
        // expiry; the teardown then starts the relist cooldown for the listing
        // route FROM THE MOMENT IT RUNS, never from the expiry.
        uint256 saleOfferId = s.loanToSaleOfferId[loanId];
        if (saleOfferId != 0) {
            LibVaipakam.Offer storage sale = s.offers[saleOfferId];
            uint64 reopens;
            if (!sale.accepted && sale.expiresAt != 0) {
                uint256 teardown = _earliestTeardown(sale.expiresAt);
                // forge-lint: disable-next-line(unsafe-typecast)
                reopens = uint64(
                    listing ? teardown + LibVaipakam.SALE_RELIST_COOLDOWN_SECONDS : teardown
                );
            }
            _add(r, abi.encodeWithSelector(IVaipakamErrors.SaleOfferAlreadyExists.selector), reopens);
            if (_full(r)) return _trim(r);
        }

        // A live borrower offset is a settlement in flight. Its creator may
        // cancel it at any time; anyone may once it has expired unaccepted.
        uint256 offsetOfferId = s.loanToOffsetOfferId[loanId];
        if (offsetOfferId != 0) {
            LibVaipakam.Offer storage offset = s.offers[offsetOfferId];
            _add(
                r,
                abi.encodeWithSelector(EarlyWithdrawalFacet.OffsetActiveOnLoan.selector),
                // forge-lint: disable-next-line(unsafe-typecast)
                !offset.accepted && offset.expiresAt != 0
                    ? uint64(_earliestTeardown(offset.expiresAt))
                    : 0
            );
            if (_full(r)) return _trim(r);
        }

        // The loan's term. Past maturity closes both routes for good. A listing
        // needs at least `MIN_SALE_LISTING_SECONDS` of term left to run in.
        uint256 maturity = LibLoanClock.maturity(loan);
        if (block.timestamp >= maturity) {
            _add(r, abi.encodeWithSelector(EarlyWithdrawalDirectFacet.SaleLoanPastMaturity.selector), 0);
            if (_full(r)) return _trim(r);
        } else if (listing && maturity < block.timestamp + LibVaipakam.MIN_SALE_LISTING_SECONDS) {
            _add(r, abi.encodeWithSelector(EarlyWithdrawalFacet.SaleListingWindowInvalid.selector), 0);
            if (_full(r)) return _trim(r);
        }

        if (listing) {
            // A listing that ended unfilled bars an immediate relist.
            uint64 cooldownUntil = s.saleRelistCooldownUntil[loanId];
            if (block.timestamp < cooldownUntil) {
                _add(
                    r,
                    abi.encodeWithSelector(
                        EarlyWithdrawalFacet.SaleRelistCooldownActive.selector, cooldownUntil
                    ),
                    cooldownUntil
                );
                if (_full(r)) return _trim(r);
            }
            // The listing first consolidates the position to its holder; a
            // position carrying unreserved held VPFI cannot be consolidated.
            if (LibConsolidation.isExcludedLive(s, loan, loanId, true)) {
                _add(
                    r,
                    abi.encodeWithSelector(EarlyWithdrawalFacet.SalePositionNotConsolidatable.selector),
                    0
                );
                if (_full(r)) return _trim(r);
            }
            // The listing carries the remaining term as its duration, which
            // generic offer creation caps at the live governance maximum. Once
            // the remaining term falls to the cap, it clears.
            uint256 remainingDays = LibLoanClock.remainingTermDays(loan);
            uint256 cap = LibVaipakam.cfgMaxOfferDurationDays();
            if (remainingDays > cap) {
                _add(
                    r,
                    abi.encodeWithSelector(
                        OfferCreateFacet.OfferDurationExceedsCap.selector, remainingDays, cap
                    ),
                    // forge-lint: disable-next-line(unsafe-typecast)
                    uint64(maturity - cap * 1 days) // a timestamp; below maturity
                );
                if (_full(r)) return _trim(r);
            }
        }

        // Governance's per-asset pause covers both legs on both routes.
        _assetPause(r, loan.principalAsset);
        if (_full(r)) return _trim(r);
        _assetPause(r, loan.collateralAsset);
        if (_full(r)) return _trim(r);

        // A vault behind the mandatory version is refused when funds move
        // through it: the holder's on the listing (the vehicle is created for
        // it), and the stored lender's wherever its held balance moves (the
        // listing's consolidation, the direct sale's held migration). The
        // direct sale migrates the held balance out of the stored lender's
        // vault whoever holds the position, so only the listing, where a
        // holder who IS the stored lender was already checked above, skips it.
        if (listing && LibVaipakam.vaultUpgradeRequired(holder)) {
            _add(r, abi.encodeWithSelector(VaultFactoryFacet.VaultUpgradeRequired.selector), 0);
            if (_full(r)) return _trim(r);
        }
        if (
            s.heldForLender[loanId] != 0 &&
            !(listing && loan.lender == holder) &&
            LibVaipakam.vaultUpgradeRequired(loan.lender)
        ) {
            _add(r, abi.encodeWithSelector(VaultFactoryFacet.VaultUpgradeRequired.selector), 0);
            if (_full(r)) return _trim(r);
        }

        // Admission last: the only check that reaches the oracles. A guard
        // that reverts with no data (the classifier itself could not run) is
        // reported as an unknown admission, never as clear.
        try SaleExitVerdictFacet(address(this)).requireSaleAdmission(loanId) {}
        catch (bytes memory admission) {
            _add(
                r,
                admission.length != 0
                    ? admission
                    : abi.encodeWithSelector(
                        LibSaleSolvency.SaleAdmissionCodeUnknown.selector,
                        loanId,
                        LibSaleSolvency.SALE_ADMISSION_UNAVAILABLE
                    ),
                0
            );
        }

        return _trim(r);
    }

    function _assetPause(Refusals memory r, address asset) private view {
        if (LibFacet.isAssetPaused(asset)) {
            _add(r, abi.encodeWithSelector(IVaipakamErrors.AssetPaused.selector, asset), 0);
        }
    }

    /// @dev The earliest moment an unaccepted offer expiring at `expiresAt`
    ///      can be torn down by anyone: its expiry, or now if that has passed.
    function _earliestTeardown(uint64 expiresAt) private view returns (uint256) {
        return block.timestamp > expiresAt ? block.timestamp : expiresAt;
    }

    function _add(Refusals memory r, bytes memory reason, uint64 reopensAt) private pure {
        r.items[r.count] = SaleRefusal(reason, reopensAt);
        r.count++;
    }

    function _full(Refusals memory r) private pure returns (bool) {
        return r.stopAtFirst && r.count != 0;
    }

    function _trim(Refusals memory r) private pure returns (SaleRefusal[] memory out) {
        out = new SaleRefusal[](r.count);
        for (uint256 i; i < r.count; ++i) out[i] = r.items[i];
    }
}
