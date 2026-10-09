// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console} from "forge-std/console.sol";
import {CustodyInvariantBase} from "./CustodyInvariantBase.sol";
import {CustodyHandler} from "./CustodyHandler.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {MetricsFacet} from "../../src/facets/MetricsFacet.sol";
import {PayrollFacet} from "../../src/facets/PayrollFacet.sol";
import {RewardRemittanceLensFacet} from "../../src/facets/RewardRemittanceLensFacet.sol";
import {SwapToRepayIntentFacet} from "../../src/facets/SwapToRepayIntentFacet.sol";
import {TreasuryFacet} from "../../src/facets/TreasuryFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {FallbackCustodyFacet} from "../../src/facets/FallbackCustodyFacet.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";

/**
 * @title  DiamondCustodyAttributionInvariant
 * @notice #2141's acceptance test: every token the Diamond holds is attributed to a named owner,
 *         under any interleaving of the fallback and intent flows. The owner's rule (#2141): a user
 *         asset still in the Diamond's balance when a transaction ends must go back to its owner's
 *         vault under a lien. This suite lands FIRST (#1566 step S0) and is green on today's code
 *         with today's legacy custody terms; S2b and S3b tighten it as each class leaves the Diamond.
 *
 *         T ranges over USDC (the principal), WETH and VPFI (the collaterals).
 *
 *         V0 (`afterInvariant`) -- every action ran, and every custody family was OBSERVED in every
 *            run: fallback entered through both producers, a failed retry that restored the
 *            custody row (S2b), a successful retry, the in-kind dispose, the backstop absorb, cure
 *            by top-up, cure by repayment, a FallbackPending partial match leg, a full match
 *            rescue, and intent commit, fill and cancel. An invariant over a path the run never
 *            took proves nothing.
 *         V0b -- the protocol-owned balances outside the handler's closed action set stay zero
 *            (buyback budgets, emissions and keeper budgets, the treasury balance -- the treasury
 *            is external -- and payroll). A handler that starts exercising one must add it to V1.
 *         V1 -- `balanceOf(T, diamond) == ledger(T) + legacyFallback(T) + legacyIntent(T)`, where
 *            ledger is zero for USDC and WETH and, for VPFI, the recycle bucket + the stranded-
 *            recovery reservation + every loan's grandfathered LIF custody (`vpfiHeld + rebate`);
 *            legacyFallback is every tracked fallback loan's
 *            `getFallbackCustody(id).legacyDiamondHeld` in T (S2b: fallback custody is
 *            vault-held, so this is zero on a fresh deploy, and a non-zero value is a pre-slice
 *            row every consumer refuses); legacyIntent is every commit's `getIntentCustody` in T
 *            (S3b: the lot stays in the vault until its fill, so this is zero on a fresh deploy,
 *            and a non-zero value is a pre-slice commit the pre-hook and teardown refuse). V1 has NO
 *            tolerance: the K5 residue S0 allowed (a partial internal match flooring the three
 *            snapshot slices independently, up to two wei per leg resting in the Diamond) is
 *            gone with S2b -- the custody never enters the Diamond, and the borrower slice
 *            absorbs the floor remainder so the snapshot total equals the row.
 *         V2 -- #2141's end state: no user custody rests in the Diamond at all
 *            (`legacyFallback + legacyIntent + LIF custody == 0`), enforced per class through
 *            {V2_ENFORCED}. S2b enforced the fallback and LIF classes, S3b the intent class (see
 *            {test_V2_EveryClassIsVaultHeld_AndALegacyIntentRowTurnsItRed}, the proof V2 can
 *            fail).
 *         V3 -- every fallback custody row agrees with its snapshot and its lien: for a
 *            FallbackPending loan with an active snapshot the row equals the snapshot total and
 *            the lien covers the row; outside FallbackPending the row is zero; and no row reads
 *            as Diamond-held. A consumer that left a snapshot disagreeing with the row it
 *            debited (S1-20) turns it red.
 *         V3a -- for every vault owner and T, the protocol-tracked vault balance covers the
 *            encumbrance on it.
 *
 *         Brief mutation map: 1 (slice-2 entry reverted to the Diamond-held body) and 3 (no
 *         retry restore) turn V2 red; 2 (slice-3 commit pulling at commit) turns V1 red -- the
 *         Diamond would hold a lot no custody read names; 4 (treasury slice sent to the Diamond)
 *         turns V1 red; 5 (a lender-slice lien decrement dropped) turns V3a red.
 *
 * @dev    Run: `forge test --match-path test/invariants/DiamondCustodyAttribution.invariant.t.sol`
 *         (the `cifast` profile does not compile `test/invariants`).
 */
contract DiamondCustodyAttributionInvariant is CustodyInvariantBase {
    /// @dev V2's classes, as bits of {V2_ENFORCED}.
    uint256 internal constant V2_CLASS_FALLBACK = 1;
    uint256 internal constant V2_CLASS_INTENT = 2;
    uint256 internal constant V2_CLASS_LIF = 4;
    /// @dev The ONE switch for V2, one bit per class. S2b (#1566 slice 2) enforced the fallback
    ///      class, now vault-held, and the LIF class (grandfathered-only, zero on a fresh deploy);
    ///      S3b (slice 3) enforces the intent class, whose lot is now pulled only inside its fill.
    uint256 internal constant V2_ENFORCED = V2_CLASS_FALLBACK | V2_CLASS_INTENT | V2_CLASS_LIF;
    /// @dev K5 (see the contract notice): no partial-leg dust since S2b, so V1 has no tolerance.
    uint256 internal constant V1_K5_DUST_PER_PARTIAL_LEG = 0;

    CustodyHandler internal handler;

    function setUp() public {
        _deployCustodyHarness();
        handler = _deployCustodyHandler();
        // Fixture-live: the harness itself leaves nothing in the Diamond and no treasury balance,
        // so every unit V1 later attributes was put there by a handler action.
        address[3] memory tokens = _custodyTokens();
        for (uint256 j; j < 3; ++j) {
            assertEq(IERC20(tokens[j]).balanceOf(address(diamond)), 0, "genesis: the Diamond holds nothing");
            assertEq(TreasuryFacet(address(diamond)).getTreasuryBalance(tokens[j]), 0, "genesis: no treasury balance");
        }
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: handler.actionSelectors()}));
    }

    // ============================================================================================
    //  Invariants
    // ============================================================================================

    function invariant_V1_DiamondBalanceIsFullyAttributed() public view {
        _assertV1();
    }

    function invariant_V0b_UnlistedOwnersStayZero() public view {
        _assertV0b();
    }

    function invariant_V3a_TrackedBalanceCoversEncumbrance() public view {
        _assertV3a();
    }

    function invariant_V3_FallbackRowAgreesWithSnapshotAndLien() public view {
        _assertV3();
    }

    function invariant_V2_NoUserCustodyRestsInTheDiamond() public view {
        if (V2_ENFORCED == 0) return;
        assertEq(_v2Residue(V2_ENFORCED), 0, "V2: user custody rests in the Diamond");
    }

    /// @notice V0. An `invariant_` function also runs before the first call, so coverage can only be
    ///         checked here, once the run is over.
    function afterInvariant() public view {
        _logCoverage();
        _assertV0();
    }

    // ============================================================================================
    //  Deterministic cells
    // ============================================================================================

    /// @notice #2141's end state across both classes, and the evidence V2 can fail. A REAL failed
    ///         HF liquidation (the reverting venue, no mocked withdraw) leaves the fallback custody
    ///         in the borrower's vault as the loan's custody row, and a REAL intent commit leaves its
    ///         lot in the vault: none of either reads as Diamond-held, the Diamond holds only the
    ///         protocol ledgers, and V1 attributes its balance exactly. A commit stamped with the old
    ///         custody (raw-written: nothing on this source writes it) turns V2's intent class red --
    ///         the proof the enforced check can fail.
    function test_V2_EveryClassIsVaultHeld_AndALegacyIntentRowTurnsItRed() public {
        handler.liquidate(1, true);
        assertEq(handler.fallbackViaLiquidation(), 1, _why());
        uint256[] memory fb = handler.fallbackLoanIds();
        assertEq(fb.length, 1, "one fallback loan tracked");
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(fb[0]).status),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the loan is FallbackPending"
        );
        address fc = handler.collateralOf(fb[0]);
        (uint256 row, uint256 legacyF) = FallbackCustodyFacet(address(diamond)).getFallbackCustody(fb[0]);
        (uint256 l, uint256 tr, uint256 b,,, bool active,) = ClaimFacet(address(diamond)).getFallbackSnapshot(fb[0]);
        assertTrue(active, "fixture-live: the snapshot is active");
        assertGt(row, 0, "fixture-live: fallback custody exists");
        assertEq(row, l + tr + b, "all of it is the vault-held custody row");
        assertEq(legacyF, 0, "none of it reads as Diamond-held");
        assertEq(IERC20(fc).balanceOf(address(diamond)), _ledger(fc), "the Diamond holds only protocol ledgers of it");

        handler.commitIntent(2);
        assertEq(handler.intentCommits(), 1, _why());
        uint256[] memory it = handler.intentLoanIds();
        address ic = handler.collateralOf(it[0]);
        uint256 lot = SwapToRepayIntentFacet(address(diamond)).getIntentCommit(it[0]).makerAmount;
        assertGt(lot, 0, "fixture-live: a live commit with a lot");
        assertEq(SwapToRepayIntentFacet(address(diamond)).getIntentCustody(it[0]), 0, "the lot is not Diamond-held");
        assertEq(IERC20(ic).balanceOf(address(diamond)), _ledger(ic), "the Diamond holds only protocol ledgers of it");
        assertEq(_v2Residue(V2_ENFORCED), 0, "every enforced class is clean");
        _assertV1();
        _assertV3();
        _assertV3a();

        TestMutatorFacet(address(diamond)).setIntentCustodialCollateralRaw(it[0], lot);
        assertEq(_v2Residue(V2_CLASS_INTENT), lot, "a legacy-stamped commit turns V2's intent class red");
    }

    /// @notice Every V0 family is reachable from a fixed sequence of handler calls -- the proof that
    ///         `afterInvariant`'s coverage requirement can be met, and the first place to look (the
    ///         messages carry the handler's last swallowed revert) when it is not. Time-moving steps
    ///         come late: a default warps past grace, after which Active loans no longer repay.
    function test_EveryV0FamilyIsReachable() public {
        handler.openLoan(11, 1_000e18, 0);
        handler.openLoan(12, 2_000e18, 1);
        handler.openLoan(13, 3_000e18, 2);
        assertEq(handler.loansOpened(), 3, _why());

        handler.repayPartial(11, 100e18);
        handler.addCollateral(12, 50e18);
        handler.repay(13);
        assertGt(handler.repaid() + handler.partialRepaid(), 0, _why());

        handler.commitIntent(21);
        assertGt(handler.intentCommits(), 0, _why());
        handler.fillIntent(22);
        assertGt(handler.intentFills(), 0, _why());
        handler.cancelIntent(23, false);
        handler.cancelIntent(24, true);
        assertEq(handler.intentCancels(), 2, _why());

        handler.liquidate(31, true);
        assertGt(handler.fallbackViaLiquidation(), 0, _why());
        handler.claimLender(32, 1);
        assertGt(handler.retryFailed(), 0, _why());
        assertGt(handler.retryRestored(), 0, _why());
        assertGt(handler.disposed(), 0, _why());
        handler.claimLender(33, 2);
        assertGt(handler.retrySucceeded(), 0, _why());
        handler.absorb(34);
        assertGt(handler.absorbed(), 0, _why());
        handler.cure(35, 10e18);
        assertGt(handler.cured(), 0, _why());
        handler.repayCure(36);
        assertGt(handler.repayCured(), 0, _why());
        handler.internalMatch(37, false);
        assertGt(handler.fallbackPartialLegs(), 0, _why());
        handler.internalMatch(38, true);
        assertGt(handler.fullRescues(), 0, _why());

        handler.claimBorrower(41);
        handler.claimLender(42, 0);
        handler.priceShock(9_700);
        handler.toggleSanction(43);
        handler.toggleSanction(44);
        handler.warp(1 days);
        handler.liquidate(45, false);

        handler.defaultLoan(51, true);
        assertGt(handler.fallbackViaDefault(), 0, _why());

        _assertV0();
        _assertV1();
        _assertV0b();
        _assertV3();
        _assertV3a();
    }

    // ============================================================================================
    //  The terms
    // ============================================================================================

    function _assertV0() internal view {
        bytes32[18] memory names = handler.actionNames();
        for (uint256 i; i < names.length; ++i) {
            assertGt(handler.calls(names[i]), 0, string.concat("V0: action never ran: ", vm.toString(names[i])));
        }
        assertGt(handler.fallbackViaLiquidation(), 0, "V0: fallback entered through the RiskFacet producer");
        assertGt(handler.fallbackViaDefault(), 0, "V0: fallback entered through the DefaultedFacet producer");
        assertGt(handler.retryFailed(), 0, "V0: claim-time retry failed");
        assertGt(handler.retryRestored(), 0, "V0: a failed retry restored the custody row (S2b)");
        assertGt(handler.retrySucceeded(), 0, "V0: claim-time retry succeeded");
        assertGt(handler.disposed(), 0, "V0: in-kind fallback distribution (dispose)");
        assertGt(handler.absorbed(), 0, "V0: backstop absorb");
        assertGt(handler.cured(), 0, "V0: cure by top-up");
        assertGt(handler.repayCured(), 0, "V0: cure by full repayment");
        assertGt(handler.fallbackPartialLegs(), 0, "V0: FallbackPending partial internal-match leg");
        assertGt(handler.fullRescues(), 0, "V0: FallbackPending full internal-match rescue");
        assertGt(handler.intentCommits(), 0, "V0: intent commit");
        assertGt(handler.intentFills(), 0, "V0: intent fill");
        assertGt(handler.intentCancels(), 0, "V0: intent cancel");
    }

    /// @dev Diagnostic only -- asserts nothing. With `-vv` it prints, at the end of a run, the V0
    ///      family counters, the swallowed reverts at the sites a family depends on, and V1's
    ///      unattributed residue per T (the K5 dust actually resting, against its allowance).
    function _logCoverage() internal view {
        console.log("V0 loansOpened", handler.loansOpened());
        console.log("V0 fallbackViaLiquidation", handler.fallbackViaLiquidation());
        console.log("V0 fallbackViaDefault", handler.fallbackViaDefault());
        console.log("V0 retryFailed", handler.retryFailed());
        console.log("V0 retrySucceeded", handler.retrySucceeded());
        console.log("V0 disposed", handler.disposed());
        console.log("V0 absorbed", handler.absorbed());
        console.log("V0 cured", handler.cured());
        console.log("V0 repayCured", handler.repayCured());
        console.log("V0 fallbackPartialLegs", handler.fallbackPartialLegs());
        console.log("V0 fullRescues", handler.fullRescues());
        console.log("V0 intentCommits", handler.intentCommits());
        console.log("V0 intentFills", handler.intentFills());
        console.log("V0 intentCancels", handler.intentCancels());
        string[9] memory sites = [
            "openLoan.create", "openLoan.accept", "liquidate", "defaultLoan", "internalMatch",
            "absorb", "cure", "commitIntent", "fillIntent"
        ];
        for (uint256 i; i < sites.length; ++i) {
            bytes32 key = bytes32(bytes(sites[i]));
            uint256 count = handler.reverts(key);
            console.log(string.concat("reverts ", sites[i]), count);
            if (count != 0) console.logBytes(handler.lastRevert(key));
        }
        address[3] memory tokens = _custodyTokens();
        string[3] memory labels = ["USDC", "WETH", "VPFI"];
        for (uint256 j; j < 3; ++j) {
            uint256 held = IERC20(tokens[j]).balanceOf(address(diamond));
            uint256 attributed = _ledger(tokens[j]) + _legacyFallback(tokens[j]) + _legacyIntent(tokens[j]);
            console.log(string.concat("V1 residue ", labels[j]), held > attributed ? held - attributed : 0);
            console.log(string.concat("V1 K5 allowance ", labels[j]), V1_K5_DUST_PER_PARTIAL_LEG * handler.partialLegsByAsset(tokens[j]));
        }
    }

    function _assertV0b() internal view {
        TreasuryFacet tf = TreasuryFacet(address(diamond));
        address[3] memory tokens = _custodyTokens();
        for (uint256 j; j < 3; ++j) {
            assertEq(tf.getBuybackBudget(tokens[j]), 0, "V0b: buyback budget");
            assertEq(tf.getBaseBuybackBudget(tokens[j]), 0, "V0b: base buyback budget");
            assertEq(tf.getTreasuryBalance(tokens[j]), 0, "V0b: treasury balance (the treasury is external)");
        }
        assertEq(tf.getRewardEmissionsBudget(), 0, "V0b: reward emissions budget");
        assertEq(tf.getKeeperRewardBudget(), 0, "V0b: keeper reward budget");
        assertEq(PayrollFacet(address(diamond)).getPayrollStreamCount(), 0, "V0b: payroll streams");
    }

    function _assertV1() internal view {
        _assertAttributed(usdc, "USDC");
        _assertAttributed(weth, "WETH");
        _assertAttributed(vpfi, "VPFI");
    }

    function _assertAttributed(address t, string memory label) internal view {
        uint256 held = IERC20(t).balanceOf(address(diamond));
        uint256 attributed = _ledger(t) + _legacyFallback(t) + _legacyIntent(t);
        assertGe(held, attributed, string.concat("V1: rows attribute more than the Diamond holds, ", label));
        assertLe(
            held - attributed,
            V1_K5_DUST_PER_PARTIAL_LEG * handler.partialLegsByAsset(t),
            string.concat("V1: Diamond balance attributed to no row, ", label)
        );
    }

    function _assertV3a() internal view {
        address[] memory owners = _custodyOwners();
        address[3] memory tokens = _custodyTokens();
        for (uint256 o; o < owners.length; ++o) {
            for (uint256 j; j < 3; ++j) {
                uint256 tracked =
                    VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(owners[o], tokens[j]);
                uint256 encumbered = MetricsFacet(address(diamond)).getEncumbered(owners[o], tokens[j], 0);
                assertGe(tracked, encumbered, "V3a: encumbrance exceeds the tracked vault balance");
            }
        }
    }

    /// @dev The protocol-owned VPFI ledgers plus the grandfathered LIF custody; nothing for USDC/WETH.
    function _ledger(address t) internal view returns (uint256) {
        if (t != vpfi) return 0;
        return ConfigFacet(address(diamond)).getRecycleBucket()
            + RewardRemittanceLensFacet(address(diamond)).getStrandedRecoveryReserved() + _lifCustody();
    }

    /// @dev The legacy fallback term: every tracked fallback loan's Diamond-held custody in `t`, as the
    ///      one custody read reports it (`getFallbackCustody(id).legacyDiamondHeld`, S2b). It replaced
    ///      S0's active-snapshot total, which was the right term while the custody rested in the
    ///      Diamond and would now count vault-held custody as Diamond-held.
    function _legacyFallback(address t) internal view returns (uint256 sum) {
        uint256[] memory ids = handler.fallbackLoanIds();
        for (uint256 i; i < ids.length; ++i) {
            if (handler.collateralOf(ids[i]) != t) continue;
            (, uint256 legacy) = FallbackCustodyFacet(address(diamond)).getFallbackCustody(ids[i]);
            sum += legacy;
        }
    }

    /// @dev V3 over every loan the handler opened: a FallbackPending loan's custody row equals its
    ///      active snapshot's total and its lien covers the row; any other loan holds no row; no
    ///      row reads as Diamond-held.
    function _assertV3() internal view {
        uint256[] memory ids = handler.loanIds();
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            (uint256 row, uint256 legacy) = FallbackCustodyFacet(address(diamond)).getFallbackCustody(id);
            assertEq(legacy, 0, "V3: no fallback row reads as Diamond-held on a fresh deploy");
            if (LoanFacet(address(diamond)).getLoanDetails(id).status != LibVaipakam.LoanStatus.FallbackPending) {
                assertEq(row, 0, "V3: a loan outside FallbackPending holds no fallback custody row");
                continue;
            }
            (uint256 l, uint256 tr, uint256 b,,, bool active,) = ClaimFacet(address(diamond)).getFallbackSnapshot(id);
            if (!active) continue;
            assertEq(row, l + tr + b, "V3: the custody row equals its active snapshot's total");
            (uint256 lien,) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(id);
            assertGe(lien, row, "V3: the collateral lien covers the custody row");
        }
    }

    /// @dev The legacy intent term: every tracked commit's Diamond-held custody in `t`, as the one
    ///      custody read reports it (`getIntentCustody(id)`, S3b). It replaced S0's live-commit lot
    ///      (`makerAmount`), which was the right term while the lot rested in the Diamond from
    ///      commit to fill and would now count a vault-held lot as Diamond-held. Zero for a
    ///      settled or cancelled commit (its record is deleted).
    function _legacyIntent(address t) internal view returns (uint256 sum) {
        uint256[] memory ids = handler.intentLoanIds();
        for (uint256 i; i < ids.length; ++i) {
            if (handler.collateralOf(ids[i]) != t) continue;
            sum += SwapToRepayIntentFacet(address(diamond)).getIntentCustody(ids[i]);
        }
    }

    /// @dev Class 3: the Diamond-held borrower LIF VPFI and its rebates, over every loan.
    function _lifCustody() internal view returns (uint256 sum) {
        uint256[] memory ids = handler.loanIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint256 rebate, uint256 held) = ClaimFacet(address(diamond)).getBorrowerLifRebate(ids[i]);
            sum += rebate + held;
        }
    }

    /// @dev V2's left-hand side over the classes in `classes`.
    function _v2Residue(uint256 classes) internal view returns (uint256 residue) {
        address[3] memory tokens = _custodyTokens();
        for (uint256 j; j < 3; ++j) {
            if ((classes & V2_CLASS_FALLBACK) != 0) residue += _legacyFallback(tokens[j]);
            if ((classes & V2_CLASS_INTENT) != 0) residue += _legacyIntent(tokens[j]);
        }
        if ((classes & V2_CLASS_LIF) != 0) residue += _lifCustody();
    }

    function _why() internal view returns (string memory) {
        return string.concat(
            "last handler revert at ",
            vm.toString(handler.lastRevertKey()),
            ": ",
            vm.toString(handler.lastRevertData())
        );
    }
}
