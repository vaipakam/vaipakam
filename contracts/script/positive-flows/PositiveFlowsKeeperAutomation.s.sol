// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsStaged} from "./PositiveFlowsStaged.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";

/**
 * @title PositiveFlowsKeeperAutomation
 * @notice Keeper authority (#848 Phase 1): the user's master keeper switch, a
 *         keeper approved for one action on one loan, and that keeper
 *         executing it.
 *
 *         The scenario takes three steps (#3574): the first posts the
 *         lender's offer; the second, once its terms have stood the minimum
 *         age, opens the loan and grants the keeper; the third lets the
 *         keeper preclose and revokes it. The preclose runs a stage after the
 *         loan opened, as a real keeper action would, with interest accrued.
 *         The keeper approval is recorded as a setting to put back, so a
 *         run that stops after the grant can be unwound (`unwind()`) and
 *         does not leave a live delegation on the borrower.
 *         `run()` is the simulation and `stage()` the broadcastable run
 *         ({PositiveFlowsStaged}, `script/positive-flows/run-staged.sh`).
 *         Fixture and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsKeeperAutomation is PositiveFlowsStaged {
    /// @dev The offer the first step posts and the second fills.
    string private constant OFFER = "offer";
    /// @dev The loan the second step opens and the third closes.
    string private constant LOAN = "loan";
    /// @dev Recorded with the keeper's address: put back means the borrower
    ///      no longer approves it.
    string private constant KEEPER_APPROVAL = "keeperApproval";
    /// @dev `ProfileFacet` action bit for starting a preclose.
    uint8 private constant INIT_PRECLOSE = 1 << 3;

    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsKeeperAutomation";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](1);
        list[0] = Scenario("PF-300", "User enables keeper access, approves a keeper for one action, keeper executes it",
            "PF-300, PF-303");
    }

    /// @dev Post the offer; open the loan and grant the keeper; the keeper
    ///      precloses.
    function _stepCount(uint256) internal pure override returns (uint256) {
        return 3;
    }

    function _runStep(uint256 index, uint256 step) internal override {
        if (index != 0) revert("PositiveFlowsKeeperAutomation: no scenario at index");
        if (step == 0) return _keep(OFFER, _createLenderOffer(lenderKey));
        if (step == 1) {
            uint256 loanId = _acceptAs(borrowerKey, _kept(OFFER), address(weth), COLLATERAL_AMOUNT);
            _keep(LOAN, loanId);
            return _grantKeeper(loanId);
        }
        _keeperPrecloses(_kept(LOAN));
    }

    // ─── Settings to put back ─────────────────────────────────────────────

    function _stillToRestore(string memory name, uint256 value) internal view override returns (bool) {
        if (_eq(name, KEEPER_APPROVAL)) return ProfileFacet(diamond).isApprovedKeeper(borrower, address(uint160(value)));
        return super._stillToRestore(name, value);
    }

    function _restore(string memory name, uint256 value) internal override {
        if (_eq(name, KEEPER_APPROVAL)) {
            vm.startBroadcast(borrowerKey);
            ProfileFacet(diamond).revokeKeeper(address(uint160(value)));
            vm.stopBroadcast();
            return;
        }
        super._restore(name, value);
    }

    // ─── PF-300 ───────────────────────────────────────────────────────────

    /// @dev The borrower delegates one action, starting a preclose, to a
    ///      keeper (`newBorrower`, any wallet the borrower trusts). The keeper
    ///      gate needs three switches on: the borrower's master switch
    ///      (`setKeeperAccess`), the per-loan opt-in (`setLoanKeeperEnabled`)
    ///      and the per-action approval (`approveKeeper`). The keeper then
    ///      precloses, paying from its own wallet, and the borrower revokes
    ///      it. The refusal of a keeper without the bit is negative-flow
    ///      coverage (NEG-23).
    function _grantKeeper(uint256 loanId) internal {
        console.log("Loan initiated for keeper-auth scenario:", loanId);
        address keeper = newBorrower;

        // approveKeeper refuses a keeper that is already approved, so an
        // approval left by another run on this chain is revoked first, but
        // only when the chain shows one: a revoke with nothing to revoke
        // would be refused on the broadcast pass (#1646).
        bool alreadyApproved = ProfileFacet(diamond).isApprovedKeeper(borrower, keeper);
        _toRestore(KEEPER_APPROVAL, uint256(uint160(keeper)));
        vm.startBroadcast(borrowerKey);
        ProfileFacet(diamond).setKeeperAccess(true);
        if (alreadyApproved) ProfileFacet(diamond).revokeKeeper(keeper);
        ProfileFacet(diamond).approveKeeper(keeper, INIT_PRECLOSE);
        ProfileFacet(diamond).setLoanKeeperEnabled(loanId, keeper, true);
        vm.stopBroadcast();
        console.log("Borrower approved the keeper to start a preclose on loan:", loanId);
    }

    /// @dev The keeper precloses the loan, then the borrower revokes it.
    function _keeperPrecloses(uint256 loanId) internal {
        address keeper = newBorrower;

        // The keeper pays the preclose from its own wallet; the fixture funds
        // `newBorrower` with USDC. precloseDirect sizes its own payment, and
        // the repay quote plus a margin covers it.
        uint256 owed = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        vm.startBroadcast(newBorrowerKey);
        usdc.approve(diamond, owed + 100e6);
        PrecloseFacet(diamond).precloseDirect(loanId);
        vm.stopBroadcast();

        LibVaipakam.Loan memory loanAfter = LoanFacet(diamond).getLoanDetails(loanId);
        require(loanAfter.status != LibVaipakam.LoanStatus.Active,
            "PF-300: precloseDirect via keeper should have settled the loan");
        console.log("Keeper precloses on the borrower's behalf; loan status:", uint8(loanAfter.status));

        vm.startBroadcast(borrowerKey);
        ProfileFacet(diamond).revokeKeeper(keeper);
        vm.stopBroadcast();
        console.log("Borrower revoked the keeper");
    }
}
