// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DiamondConfigSpell} from "../../script/DiamondConfigSpell.s.sol";

/// @title  DiamondConfigSpellPegGateTest
/// @notice #884 — the launch deploy must NOT price VPFI.
///
///         `DiamondConfigSpell` used to run `ConfigureVPFIBuy` on every deploy
///         with a VPFI stack, so a launch landed with the discount peg SET —
///         the opposite of the Phase-1 posture, and a materially different
///         product: with the peg unset the lender yield-fee discount is
///         delivered by direct reduction and carries the whole discount; with
///         it set the hold slice becomes VPFI-payment-authoritative.
///
///         #1356's retail guardrail asserted the peg was unset and PASSED —
///         it observes a fresh deploy, and the configure phase pegged it
///         immediately after. A true assert over a state the pipeline had
///         already left.
///
/// @dev    This file exists because I got the testability question wrong.
///         I claimed in #1920 that no Solidity test could observe this branch,
///         since it lives in a broadcast script behind an env var, and used
///         that to justify shipping the fix with no executable coverage.
///         `vm.setEnv` exists (`forge-std/src/Vm.sol:615`) and three deploy
///         tests here already use it. The decision is now a `public view`
///         helper on the spell, so both gate values are pinned directly.
contract DiamondConfigSpellPegGateTest is Test {
    DiamondConfigSpell internal spell;

    function setUp() public {
        spell = new DiamondConfigSpell();
    }

    /// @dev ONE test, walking every case sequentially, and deliberately not
    ///      five separate test functions.
    ///
    ///      The first version of this file WAS five functions and it was
    ///      FLAKY: `vm.setEnv` mutates the process environment, Foundry runs
    ///      test functions concurrently, and the unset-case test raced the
    ///      opt-in case — the opt-in assert failed in-suite and passed when
    ///      run alone. A test that passes in isolation and fails in the suite
    ///      is worse than no test, because the next person reads the red as
    ///      noise. Sequencing the cases inside one body removes the shared
    ///      mutable state from the equation entirely.
    function test_ThePegGateIsOffByDefaultAndOnlyOptsInOnExactlyOne() public {
        // 1. Unset — the launch posture. THE regression this file exists for:
        //    re-adding an unconditional `ConfigureVPFIBuy` call, or flipping
        //    this default, fails right here.
        vm.setEnv("CONFIGURE_VPFI_PEG", "");
        assertFalse(
            spell.pegConfigureRequested(),
            "launch posture: an unset CONFIGURE_VPFI_PEG must leave VPFI unpriced"
        );

        // 2. Explicit zero reads the same as unset.
        vm.setEnv("CONFIGURE_VPFI_PEG", "0");
        bool off = spell.pegConfigureRequested();
        assertFalse(off, "0 means off, the same as unset");

        // 3. The opt-in must actually work, or an operator who needs the peg
        //    reaches for a worse lever.
        vm.setEnv("CONFIGURE_VPFI_PEG", "1");
        bool on = spell.pegConfigureRequested();
        assertTrue(on, "an explicit 1 opts in");

        // 4. Non-vacuity, stated as its own property: a helper hard-coded to
        //    `false` would satisfy every assertFalse above and only ONE
        //    assertTrue would catch it. This says the two branches differ.
        assertTrue(on != off, "the gate must distinguish its two values");

        // 5. Fail-closed on anything else. A typo, a stale `true`, or `2`
        //    must not price VPFI — this is a product switch, not a tuning knob.
        vm.setEnv("CONFIGURE_VPFI_PEG", "2");
        assertFalse(spell.pegConfigureRequested(), "2 is not an opt-in");
        vm.setEnv("CONFIGURE_VPFI_PEG", "true");
        assertFalse(spell.pegConfigureRequested(), "a non-numeric value is not an opt-in");
    }
}
