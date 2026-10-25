// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "../../test/helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";

/**
 * @title PositiveFlowsKeeperAutomation
 * @notice Keeper authority (#848 Phase 1): the user's master keeper switch, a
 *         keeper approved for one action, and that keeper executing it.
 *
 *         Moved from the retired `AnvilNewPositiveFlows` suite, whose `N`
 *         labels the comments below still use in places; {PositiveFlowsBase}
 *         maps them to the flow ids. Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsKeeperAutomation is PositiveFlowsBase {
    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsKeeperAutomation";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](1);
        list[0] = Scenario("PF-300", "User enables keeper access, approves a keeper for one action, keeper executes it",
            "PF-300, PF-303");
    }

    function _runScenario(uint256 index) internal override {
        if (index == 0) _keeperPerAction();
        else revert("PositiveFlowsKeeperAutomation: no scenario at index");
    }

    // ─── PF-300: Keeper Per-Action Authorization ────────────────────────────

    /// @dev Phase 6 — borrower delegates a specific subset of
    ///      strategic-flow actions to a keeper via
    ///      `ProfileFacet.approveKeeper(keeper, actionBits)`. The
    ///      keeper can then execute ONLY those actions on the
    ///      borrower's behalf. Maps to Advanced Guide § Keeper
    ///      Settings.
    ///
    ///      Scenario:
    ///        1. lender + borrower take a normal loan.
    ///        2. Borrower calls `approveKeeper(keeper, initPreclose)`.
    ///        3. Keeper calls `precloseDirect(loanId)` — succeeds
    ///           (KeeperFor gate sees the bit).
    ///        4. Borrower revokes via `revokeKeeper(keeper)`.
    ///        5. (Coverage of the deny path is in NEG-23 in the
    ///           negative flow file — keeper without the bit reverts
    ///           KeeperAccessRequired.)
    ///
    ///      Roles:
    ///        Borrower = `borrower` (whitelist owner)
    ///        Lender   = `lender`
    ///        Keeper   = `newBorrower` (any third-party EOA the
    ///                                  borrower trusts)
    function _keeperPerAction() internal {
        address bob = lender;
        address alice = borrower;
        address bot = newBorrower;
        uint256 bobKey = lenderKey;
        uint256 aliceKey = borrowerKey;
        uint256 botKey = newBorrowerKey;

        // Step 1: take a fresh loan.
        vm.startBroadcast(bobKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t5 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(aliceKey), offerId, true, 0);
        bytes memory _sig5 = LibAcceptTestSigner.sign(diamond, _t5, aliceKey);
        vm.startBroadcast(aliceKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t5, _sig5);
        vm.stopBroadcast();
        console.log("Loan initiated for keeper-auth scenario:", loanId);

        // Step 2: alice grants bot keeper authority. `LibAuth.requireKeeperFor`
        // requires THREE switches all on (Phase 6 design):
        //   (a) `setKeeperAccess(true)`  — user-level master switch
        //   (b) `setLoanKeeperEnabled(loanId, keeper, true)` — per-loan opt-in
        //   (c) `approveKeeper(keeper, actionBits)` — per-action bitmask
        // Missing any of the three → KeeperAccessRequired revert.
        uint8 initPreclose = 1 << 3;
        // approveKeeper reverts KeeperAlreadyApproved if a prior scenario
        // on the same chain (e.g. PartialFlows Phase B P-P) granted bot
        // an authorization that's still live, so revoke it first — but only
        // when there is one, read from the chain. This used to be a
        // try/catch around the revoke, and forge broadcasts every call the
        // simulation issued, swallowed reverts included: on a chain with no
        // prior approval the revoke re-simulated as `KeeperNotApproved()`
        // on the broadcast pass and aborted the whole script before anything
        // was mined (#1646). See the "Broadcast rule" in the contract header.
        bool botAlreadyApproved = ProfileFacet(diamond).isApprovedKeeper(alice, bot);
        vm.startBroadcast(aliceKey);
        ProfileFacet(diamond).setKeeperAccess(true);
        if (botAlreadyApproved) ProfileFacet(diamond).revokeKeeper(bot);
        ProfileFacet(diamond).approveKeeper(bot, initPreclose);
        ProfileFacet(diamond).setLoanKeeperEnabled(loanId, bot, true);
        vm.stopBroadcast();
        console.log("Alice authorized Bot for INIT_PRECLOSE on loan:", loanId);

        // Step 3: bot executes precloseDirect on alice's behalf.
        // precloseDirect needs USDC allowance for the principal +
        // accrued interest payment to the lender. The pull is from
        // msg.sender (bot) per RepayFacet pattern, BUT the
        // PrecloseFacet payment routing... let me check by reading.
        //
        // Per PrecloseFacet.precloseDirect(): borrower (or keeper as
        // borrower-NFT delegate) pays principal + accrued interest
        // from their wallet. msg.sender is bot here, so bot pays.
        // But conceptually alice is the borrower being precosed —
        // the keeper pattern means bot's funds substitute for alice's
        // for the duration of the operation.
        //
        // Mint bot enough USDC since they were not topped up at setup
        // for this purpose. Actually looking at setup, newBorrower
        // got 100_000e6 USDC — plenty.
        uint256 owed = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        // precloseDirect computes its own owed amount; approving the
        // RepayFacet-style amount + buffer covers it.
        vm.startBroadcast(botKey);
        usdc.approve(diamond, owed + 100e6);
        PrecloseFacet(diamond).precloseDirect(loanId);
        vm.stopBroadcast();

        // Verify loan settled.
        LibVaipakam.Loan memory loanAfter = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfter.status != LibVaipakam.LoanStatus.Active,
            "PF-300: precloseDirect via keeper should have settled the loan"
        );
        console.log("Bot executed precloseDirect on Alice's behalf; loan status:", uint8(loanAfter.status));

        // Step 4: alice revokes bot.
        vm.startBroadcast(aliceKey);
        ProfileFacet(diamond).revokeKeeper(bot);
        vm.stopBroadcast();
        console.log("Alice revoked Bot");

    }
}
