// src/facets/FeeEntitlementFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFeeEntitlement} from "../libraries/LibFeeEntitlement.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  FeeEntitlementFacet
 * @notice #1347 (M2 PR-5a/5b) — the Full VPFI tariff surface: prices the
 *         per-loan `C*` (LIF·year), charges each opting-in party's `C*` from
 *         their own vault into the recycle bucket, and stamps the per-loan
 *         fee-entitlement record the settlement sweep (PR-6) and loan-side
 *         reward cap (PR-5c) read.
 *
 * @dev    Lives in its own facet on purpose:
 *          - it gives the tariff charge a FRESH stack frame, off the
 *            at-budget `OfferAcceptFacet._acceptOffer` viaIR path (the charge
 *            is a `msg.sender == address(this)` cross-facet call, the same
 *            trust model as `chargeBorrowerLifAndDeliver`);
 *          - it keeps the Full-tariff bytecode off the already-large accept
 *            facet (EIP-170); and
 *          - it is the single place PR-5c / PR-6 extend for cap reads + lender
 *            Full honoring.
 *
 *         Ships DARK: while `cfgFeeEntitlementEnabled()` is false every Full
 *         opt-in fails closed (revert unless the party permitted a downgrade),
 *         so {chargeFullTariff} only ever stamps `None`/`HoldOnly` and the
 *         notional `cStarOpen`.
 */
contract FeeEntitlementFacet is IVaipakamErrors {
    /// @notice Cross-facet parameter bundle for {chargeFullTariff}, assembled by
    ///         `OfferAcceptFacet` from the offer + accept terms once the loan
    ///         exists. Lender Full authorization MUST originate from the
    ///         lender's own offer (never a borrower/matcher-set accept flag);
    ///         borrower Full from the EIP-712 accept terms.
    struct FullTariffChargeParams {
        uint256 loanId;
        address lendingAsset;
        address borrower;
        address lender;
        uint256 effectivePrincipal;
        uint256 durationDays;
        bool borrowerWantsFull;
        uint256 borrowerMaxCStar;
        bool borrowerAllowDowngrade;
        bool borrowerHoldEligible;
        bool lenderWantsFull;
        uint256 lenderMaxCStar;
        bool lenderAllowDowngrade;
        bool lenderHoldEligible;
    }

    /// @notice #1347 — emitted once per loan at initiation with the resolved
    ///         per-party modes, each Full party's absorbed tariff, and the
    ///         notional `C*`. Auxiliary fee-accounting log — the recycle credit
    ///         itself is observable via `VpfiRecycled`, and the loan lifecycle
    ///         via `LoanInitiated`.
    /// @custom:event-category informational/fee-entitlement
    event FeeEntitlementStamped(
        uint256 indexed loanId,
        uint8 borrowerMode,
        uint8 lenderMode,
        uint256 borrowerTariffPaid,
        uint256 lenderTariffPaid,
        uint256 cStarOpen
    );

    /**
     * @notice Charge the Full VPFI tariff for a freshly-initiated loan and stamp
     *         its fee-entitlement record.
     * @dev    Internal cross-facet entry — `msg.sender` MUST be the Diamond, so
     *         only `OfferAcceptFacet` (behind the accept flow) can reach it. It
     *         prices one shared notional `C*`, resolves and charges each party
     *         independently (double absorption — both Full ⇒ `2 × C*` to the
     *         bucket), then writes `feeEntitlementByLoanId[loanId]`. The
     *         notional `cStarOpen` is stamped for EVERY loan (even None/HoldOnly)
     *         because the loan-side reward cap (PR-5c) is defined from it.
     */
    function chargeFullTariff(FullTariffChargeParams calldata p) external {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();

        (uint256 cStar, bool numeraireOk) = LibFeeEntitlement.computeCStar(
            p.lendingAsset,
            p.effectivePrincipal,
            p.durationDays
        );

        (
            LibVaipakam.FeeEntitlementMode bMode,
            uint256 bPaid
        ) = LibFeeEntitlement.resolveAndCharge(
                p.loanId,
                p.borrower,
                p.borrowerWantsFull,
                p.borrowerMaxCStar,
                p.borrowerAllowDowngrade,
                p.borrowerHoldEligible,
                cStar,
                numeraireOk
            );
        (
            LibVaipakam.FeeEntitlementMode lMode,
            uint256 lPaid
        ) = LibFeeEntitlement.resolveAndCharge(
                p.loanId,
                p.lender,
                p.lenderWantsFull,
                p.lenderMaxCStar,
                p.lenderAllowDowngrade,
                p.lenderHoldEligible,
                cStar,
                numeraireOk
            );

        LibVaipakam.storageSlot().feeEntitlementByLoanId[p.loanId] = LibVaipakam
            .FeeEntitlement({
                borrowerMode: bMode,
                lenderMode: lMode,
                openDays: uint32(p.durationDays == 0 ? 1 : p.durationDays),
                borrowerTariffPaid: bPaid,
                lenderTariffPaid: lPaid,
                cStarOpen: cStar
            });

        emit FeeEntitlementStamped(
            p.loanId,
            uint8(bMode),
            uint8(lMode),
            bPaid,
            lPaid,
            cStar
        );
    }

    /**
     * @notice Quote the notional Full tariff `C*` for a prospective loan.
     * @dev    View surface for the frontend Full-tariff quote (PR-8 #1355) and
     *         off-chain callers. `numeraireOk` is false when the list LIF can't
     *         be priced — a reward-eligible origination requires it.
     * @param  lendingAsset  Prospective loan's ERC-20 principal asset.
     * @param  principal     Prospective filled principal in lending-asset wei.
     * @param  durationDays  Prospective term in days.
     * @return cStar         Notional tariff per Full party in VPFI wei (1e18).
     * @return numeraireOk   True iff the list LIF resolved a numeraire price.
     */
    function quoteCStar(
        address lendingAsset,
        uint256 principal,
        uint256 durationDays
    ) external view returns (uint256 cStar, bool numeraireOk) {
        return
            LibFeeEntitlement.computeCStar(
                lendingAsset,
                principal,
                durationDays
            );
    }

    /**
     * @notice Read a loan's fee-entitlement record (per-party modes, absorbed
     *         tariffs, notional `C*`, open term).
     * @param  loanId The loan to read.
     * @return The stored {LibVaipakam.FeeEntitlement} (zero-default when the
     *         loan never touched the VPFI discount/tariff path).
     */
    function getFeeEntitlement(
        uint256 loanId
    ) external view returns (LibVaipakam.FeeEntitlement memory) {
        return LibVaipakam.storageSlot().feeEntitlementByLoanId[loanId];
    }
}
