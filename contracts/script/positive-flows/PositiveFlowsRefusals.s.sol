// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsStaged} from "./PositiveFlowsStaged.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibOfferShape} from "../../src/libraries/LibOfferShape.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";

/**
 * @title PositiveFlowsRefusals
 * @notice Gates the Diamond must enforce end to end (#3574): each scenario
 *         asks the deployed Diamond for something its rules forbid and
 *         requires the refusal by its exact error, so a call refused for an
 *         unrelated reason (an allowance, a range checked earlier) cannot pass
 *         it. It replaces `AnvilNegativeFlows` and its `NegativeFlows`
 *         wrapper, which built a loan and probed it in one broadcast and so
 *         stopped before sending anything once the offer-age rule (#3412)
 *         arrived, and which accepted any revert as a pass.
 *
 *         Every refusal is probed in the simulation only (`RevertProbe`): it
 *         is never sent, so it neither aborts a broadcast nor spends a nonce
 *         the chain never sees, and it still runs the deployed code against
 *         the chain's state. The offer-shape refusals send nothing at all. The
 *         two that need a live loan post an offer in one stage and open the
 *         loan, then probe it, in the next ({PositiveFlowsStaged}): `run()` is
 *         the simulation, `stage()` the broadcastable run
 *         (`script/positive-flows/run-staged.sh PositiveFlowsRefusals`).
 *         The loans they open stay open; nothing here changes a protocol
 *         setting, so nothing is recorded to put back.
 *
 *         Per-facet unit tests cover the rest of the negative matrix
 *         (`docs/TestScopes/AdvancedUserGuideTestMatrix.md`); this module
 *         proves the Diamond-routed entry points enforce the gates on a real
 *         chain. Sanctioned-caller refusals are PF-008's (OperatorAdmin).
 *         Fixture and actors: {PositiveFlowsBase}.
 */
contract PositiveFlowsRefusals is PositiveFlowsStaged {
    /// @dev The offer a two-step scenario's first step posts.
    string private constant OFFER = "offer";

    /// @dev The highest rate an offer may name (100%).
    uint256 private constant MAX_INTEREST_BPS = 10_000;

    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsRefusals";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](9);
        list[0] = Scenario("NEG-RA1", "An offer whose largest amount is below its amount is refused", "NEG-RA1");
        list[1] = Scenario("NEG-RA2", "An offer whose highest rate is below its rate is refused", "NEG-RA2");
        list[2] = Scenario("NEG-RA3", "An offer whose rate exceeds 100% is refused", "NEG-RA3");
        list[3] = Scenario("NEG-2", "An offer without the creator's risk and terms consent is refused", "NEG-2");
        list[4] = Scenario("NEG-3", "An offer lending and collateralising the same asset is refused", "NEG-3");
        list[5] = Scenario("NEG-4", "An offer with a zero-day duration is refused", "NEG-4");
        list[6] = Scenario("NEG-9", "A lender offer asking less collateral than the floor is refused", "NEG-9");
        list[7] = Scenario("NEG-15", "A claim on a loan that is still active is refused", "NEG-15");
        list[8] = Scenario("NEG-20", "A partial repayment of a loan that did not allow one is refused", "NEG-20");
    }

    /// @dev The two loan refusals post, then open and probe; the rest are one probe.
    function _stepCount(uint256 index) internal pure override returns (uint256) {
        return index >= 7 ? 2 : 1;
    }

    function _runStep(uint256 index, uint256 step) internal override {
        if (index >= 7) {
            // The standard offer allows no partial repayment (NEG-20).
            if (step == 0) return _keep(OFFER, _createLenderOffer(lenderKey));
            uint256 loanId = _acceptAs(borrowerKey, _kept(OFFER), address(weth), COLLATERAL_AMOUNT);
            console.log("Loan opened for the probe:", loanId);
            if (index == 7) return _claimBeforeTerminal(loanId);
            return _partialRepayWhenOff(loanId);
        }

        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        bytes4 expected;
        if (index == 0) {
            p.amountMax = LOAN_AMOUNT - 1;
            expected = LibOfferShape.InvalidAmountRange.selector;
        } else if (index == 1) {
            p.interestRateBpsMax = INTEREST_BPS - 1;
            expected = LibOfferShape.InvalidRateRange.selector;
        } else if (index == 2) {
            p.interestRateBpsMax = MAX_INTEREST_BPS + 1;
            expected = LibOfferShape.InterestRateAboveCeiling.selector;
        } else if (index == 3) {
            p.creatorRiskAndTermsConsent = false;
            expected = IVaipakamErrors.RiskAndTermsConsentRequired.selector;
        } else if (index == 4) {
            p.collateralAsset = p.lendingAsset;
            expected = IVaipakamErrors.SelfCollateralizedOffer.selector;
        } else if (index == 5) {
            p.durationDays = 0;
            expected = OfferCreateFacet.InvalidOfferType.selector;
        } else if (index == 6) {
            // 0.001 WETH against 1,000 USDC, far below the floor. A lender
            // offer keeps collateralAmountMax equal to collateralAmount, a
            // range check that runs before the floor
            // (LenderCollateralRangeNotAllowed), so both move together.
            p.collateralAmount = 1e15;
            p.collateralAmountMax = 1e15;
            expected = OfferCreateFacet.MinCollateralBelowFloor.selector;
        } else {
            revert("PositiveFlowsRefusals: no scenario at index");
        }
        _requireCreateRefused(p, expected, index);
    }

    /// @dev The lender asks to post `p`; the Diamond must refuse with
    ///      `expected`, a check made before any token is pulled.
    function _requireCreateRefused(LibVaipakam.CreateOfferParams memory p, bytes4 expected, uint256 index) internal {
        Scenario memory sc = scenarios()[index];
        _requireRefusedWithSelector(
            lender,
            abi.encodeWithSelector(OfferCreateFacet.createOffer.selector, p, type(uint64).max),
            expected,
            string.concat(sc.id, ": the offer should be refused with its own error")
        );
        console.log(string.concat(sc.id, ": refused as expected"));
    }

    // ─── NEG-15 ───────────────────────────────────────────────────────────

    function _claimBeforeTerminal(uint256 loanId) internal {
        _requireRefusedWithSelector(
            lender,
            abi.encodeWithSelector(ClaimFacet.claimAsLender.selector, loanId),
            IVaipakamErrors.InvalidLoanStatus.selector,
            "NEG-15: a lender claim on an active loan should be refused (InvalidLoanStatus)"
        );
        console.log("NEG-15: the lender's claim on the active loan was refused");
    }

    // ─── NEG-20 ───────────────────────────────────────────────────────────

    function _partialRepayWhenOff(uint256 loanId) internal {
        _requireRefusedWithSelector(
            borrower,
            abi.encodeWithSelector(RepayFacet.repayPartial.selector, loanId, LOAN_AMOUNT / 5),
            RepayFacet.PartialRepayNotAllowed.selector,
            "NEG-20: a partial repayment without the opt-in should be refused (PartialRepayNotAllowed)"
        );
        console.log("NEG-20: the partial repayment was refused");
    }
}
