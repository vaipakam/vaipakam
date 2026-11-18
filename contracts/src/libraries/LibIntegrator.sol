// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibIntegrator
 * @author Vaipakam Developer Team
 * @notice #3682 / #3720 — the reads of the integrator registry: whether an
 *         integrator named on a loan is paid, and at what rate
 *         (`IntegratorFeeShareDesign.md` sections 3 to 6). The registry is
 *         written only by `IntegratorFacet`.
 */
library LibIntegrator {
    /// @notice Why an integrator named on a loan is paid nothing. Its share
    ///         goes to the reserve; the loan opens either way.
    enum Refusal {
        None,
        NotNamed,
        NotRegistered,
        Suspended,
        Flagged,
        BorrowerIsIntegrator
    }

    /// @notice The default rate for an entry that carries none.
    function defaultRateBps() internal view returns (uint256) {
        uint16 v = LibVaipakam.storageSlot().feeShareCfg.integratorDefaultBps;
        return v == 0 ? LibVaipakam.INTEGRATOR_SHARE_BPS_DEFAULT : v;
    }

    /// @notice An entry's rate: its own, or the default.
    function rateOf(LibVaipakam.IntegratorEntry storage e) internal view returns (uint256) {
        return e.rateBps == 0 ? defaultRateBps() : e.rateBps;
    }

    /// @notice The rate `integrator` is paid at on a loan borrowed by
    ///         `borrower` now, or 0 with the reason it is not paid: not named,
    ///         not registered, suspended, flagged by the sanctions list (its id
    ///         or its payout account), or a borrower that is the integrator,
    ///         its payout account or one of its declared contracts.
    function rateFor(address integrator, address borrower) internal view returns (uint256, Refusal) {
        if (integrator == address(0)) return (0, Refusal.NotNamed);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntegratorEntry storage e = s.integrators[integrator];
        if (e.status == LibVaipakam.IntegratorStatus.None) return (0, Refusal.NotRegistered);
        if (e.status == LibVaipakam.IntegratorStatus.Suspended) return (0, Refusal.Suspended);
        if (s.integratorOfAddress[borrower] == integrator) return (0, Refusal.BorrowerIsIntegrator);
        if (LibVaipakam.isSanctionedAddress(integrator) || LibVaipakam.isSanctionedAddress(e.payout)) {
            return (0, Refusal.Flagged);
        }
        return (rateOf(e), Refusal.None);
    }

    /// @notice Record that loan `loanId` was brought by `integrator` (a
    ///         registered entry, paid or not): its public count rises once.
    function recordLoan(uint256 loanId, address integrator) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntegratorEntry storage e = s.integrators[integrator];
        if (e.status == LibVaipakam.IntegratorStatus.None) return;
        s.loanIntegrator[loanId] = integrator;
        e.loansBrought += 1;
    }

    /// @notice A loan reached default or liquidation: if an integrator
    ///         brought it and it opened less than
    ///         {LibVaipakam.INTEGRATOR_EARLY_DEFAULT_WINDOW} ago, that
    ///         integrator's early-default count rises once.
    function onLoanBadEnd(LibVaipakam.Loan storage loan) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address integrator = s.loanIntegrator[loan.id];
        if (integrator == address(0)) return;
        if (block.timestamp >= uint256(loan.startTime) + LibVaipakam.INTEGRATOR_EARLY_DEFAULT_WINDOW) return;
        LibVaipakam.IntegratorEntry storage e = s.integrators[integrator];
        if (e.status != LibVaipakam.IntegratorStatus.None) e.loansEarlyDefaulted += 1;
    }
}
