// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibAuth} from "./LibAuth.sol";
import {LibServiceCapacity} from "./LibServiceCapacity.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {VPFIDiscountFacet} from "../facets/VPFIDiscountFacet.sol";

/**
 * @title LibPreclose
 * @author Vaipakam Developer Team
 * @notice The steps the borrower's early-close routes share: the direct
 *         preclose and the obligation handover ({PrecloseFacet}) and the
 *         offset route ({PrecloseOffsetFacet}). One source for each step, so
 *         the two facets cannot drift apart on who may act, which asset is
 *         paid or how a closed loan's positions are marked.
 * @dev    Split out with {PrecloseOffsetFacet} (#3410), when PrecloseFacet
 *         ran out of EIP-170 room; until then these were private helpers of
 *         PrecloseFacet. Every function is `internal`, so each facet compiles
 *         its own copy — the library is a single SOURCE, not a shared host.
 */
library LibPreclose {
    /// @dev The borrower-side authority check every preclose entry runs: the
    ///      position's holder (or, once a protected-account replacement
    ///      retired it, its controller) or a keeper it granted `action`; a
    ///      keeper's action is charged against its service capacity (#1219).
    function authorizeBorrowerSide(uint16 action, LibVaipakam.Loan storage loan) internal {
        if (LibAuth.requireKeeperFor(action, loan, /* lenderSide */ false)) LibServiceCapacity.chargeKeeper();
    }

    /// @dev The ERC-20 a loan is paid in: the principal asset for an ERC-20
    ///      loan, the prepay asset for an NFT rental.
    function paymentAsset(LibVaipakam.Loan storage loan) internal view returns (address) {
        return loan.assetType == LibVaipakam.AssetType.ERC20 ? loan.principalAsset : loan.prepayAsset;
    }

    /// @dev #1383 — resolve the lender yield-fee VPFI discount through the
    ///      diamond-internal `VPFIDiscountFacet.resolveLenderYieldFeeFor` host,
    ///      so the VPFI-payment-then-direct-reduction delivery lives on ONE
    ///      facet's bytecode. `settlingLender` is the party charged/credited:
    ///      the CURRENT lender-NFT holder on the non-consolidated legs, the
    ///      stored `loan.lender` on the consolidated / #1124-deferred legs (per
    ///      the site's payout target).
    ///
    ///      Short-circuits the ineligible/dark case with an INLINED eligibility
    ///      read (`consent OR Full`, no cross-facet routing) so the resolve is a
    ///      strict no-op for every unstamped/no-consent loan — including test
    ///      diamonds that don't cut `VPFIDiscountFacet` — and only routes to the
    ///      host when a discount can actually apply. Returns
    ///      `(lenderExtra, newTreasury)`; add `lenderExtra` to the lender share
    ///      and replace the treasury share with `newTreasury` at the call site.
    ///
    ///      Passes `bytes4(0)` as the failure selector so a host revert bubbles
    ///      its ORIGINAL reason rather than being masked by a facet-local
    ///      error, and no new error entry joins either facet's ABI — the same
    ///      choice `RepayFacet` makes for its copy of this step.
    function resolveLenderYieldFee(
        uint256 loanId,
        address settlingLender,
        uint256 interestForQuote,
        uint256 treasuryShare
    ) internal returns (uint256 lenderExtra, uint256 newTreasury) {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (treasuryShare == 0 || !LibVPFIDiscount.lenderYieldFeeEligible(loan, settlingLender)) {
            return (0, treasuryShare);
        }
        bytes memory ret = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                VPFIDiscountFacet.resolveLenderYieldFeeFor.selector,
                loanId,
                settlingLender,
                interestForQuote,
                treasuryShare
            ),
            bytes4(0)
        );
        (lenderExtra, newTreasury,) = abi.decode(ret, (uint256, uint256, uint256));
    }

    /// @dev Clears the renter of an NFT rental's token as the loan closes.
    function resetNftRenter(LibVaipakam.Loan storage loan) internal {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(VaultFactoryFacet.vaultSetRentalUser.selector, loan.id, address(0), 0),
            IVaipakamErrors.NFTRenterUpdateFailed.selector
        );
    }

    /// @dev Marks both position NFTs of a closed loan `LoanRepaid`.
    function setLoanClaimable(LibVaipakam.Loan storage loan, uint256 loanId) internal {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            IVaipakamErrors.NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            IVaipakamErrors.NFTStatusUpdateFailed.selector
        );
    }
}
