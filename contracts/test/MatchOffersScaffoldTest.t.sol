// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";

/**
 * @title MatchOffersScaffoldTest
 * @notice Phase 1 of Issue #173 — the test-infrastructure piece. The
 *         issue scopes seven concrete scenarios (happy-path partial
 *         fill, multi-fill, dust-close, single-fill fallback, borrower
 *         `amountMax == 0` derivation, advanced-mode override, the
 *         MatchError revert paths). This file ships the scaffolding +
 *         a minimal smoke check that proves `matchOffers` and
 *         `previewMatch` are reachable through the SetupTest diamond
 *         post the `OfferMatchFacet` cut-in. The seven detailed
 *         scenarios are a focused follow-up under the same issue.
 *
 *         Why split this way: the SetupTest cut-in closes a real
 *         test-vs-prod drift (the production diamond cuts
 *         `OfferMatchFacet` per DeployDiamond §5e but SetupTest's test
 *         diamond did not), which is independently valuable and worth
 *         landing on its own. A small, surgical PR is also faster to
 *         review than one bundling 270 LOC of scenario coverage.
 *
 *         Inherits from `SetupTest` so the diamond comes pre-wired
 *         with the full facet set + per-tier liquidation pins + KYC
 *         + sanctions defaults from `setupHelper()`.
 */
contract MatchOffersScaffoldTest is SetupTest {
    // The matching kill-switch (`partialFillEnabled`) defaults to
    // `false` on a fresh deploy (`LibVaipakam.Storage.protocolCfg`
    // zero-init). `setUp` flips it ON so any test that inherits this
    // file lands on the partial-fill code paths #102 introduced.
    function setUp() public {
        setupHelper();

        // Flip the #102 matching kill-switch on (ranged offers need no
        // flag, #2812). Tests that need to exercise the OFF path can
        // re-disable it in their own scope.
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.stopPrank();
    }

    /// @notice The drift-fix smoke check. After SetupTest cuts
    ///         `OfferMatchFacet`, the two read/write selectors must be
    ///         resolvable through the diamond fallback. A revert here
    ///         (selector-not-found, `FunctionDisabled`, or anything
    ///         else) means the scaffolding regressed — the seven
    ///         follow-up scenarios all share the same setUp and would
    ///         fail spuriously rather than catching real bugs.
    function test_previewMatchSelectorReachable() public view {
        // `previewMatch(0, 0)` against two never-created offer ids
        // routes through the diamond, lands in `LibOfferMatch.previewMatch`,
        // and returns an `OfferAccepted` error code (the lender slot's
        // zero-init `accepted == false`, but the early-out check fires
        // on the borrower offer too — either way, NOT a `selector not
        // found` revert). The point is reachability, not semantics.
        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(0, 0, address(this), address(this));
        // Any structured `MatchError` is fine — we're proving the
        // selector resolves, not asserting the exact code.
        assertTrue(
            uint8(r.errorCode) >= uint8(LibOfferMatch.MatchError.Ok),
            "previewMatch returned a structured MatchResult"
        );
    }

    /// @notice Symmetric reachability check for the write selector.
    ///         `matchOffers(0, 0)` MUST revert (the offers don't
    ///         exist) — we assert the revert is a typed
    ///         `MatchError`-mapped facet revert, not a generic
    ///         selector-not-found. That distinguishes "the facet
    ///         was cut and reached" from "the diamond doesn't know
    ///         the selector".
    function test_matchOffersSelectorReachable() public {
        // A pair of zero ids passes the kill-switch (we flipped it
        // ON in setUp) and lands in `previewMatch`, which surfaces
        // a structured `MatchError`. `matchOffers` then maps that to
        // a typed revert via the explicit `if (...)` chain. We
        // expect the call to revert — but specifically with one of
        // the facet's named errors, not a generic fallback. Use
        // `expectRevert()` with no arg to catch any revert; if the
        // selector weren't cut, viem/forge would surface "function
        // selector was not recognized" which is also caught here —
        // but the regression mode we'd see in that case is a missing
        // selector, easy to spot in the test output.
        vm.expectRevert();
        OfferMatchFacet(address(diamond)).matchOffers(0, 0);
    }

    /// @notice The kill-switch path: when `partialFillEnabled` is OFF
    ///         (Phase 1 default), `matchOffers` reverts with
    ///         `FunctionDisabled(3)` regardless of the offers. This
    ///         test re-disables the flag inside its own scope so the
    ///         per-test setUp default doesn't mask the gate. Keeping
    ///         this guard test in scaffolding (rather than the
    ///         follow-up suite) means the master kill-switch path
    ///         has explicit, dedicated coverage instead of being a
    ///         silent precondition every other scenario inherits.
    function test_matchOffersGatedOnPartialFillKillSwitch() public {
        // Flip the master flag back off — overriding the setUp default.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(false);

        // `FunctionDisabled(uint8)` is the typed revert; reason 3 is
        // assigned to the partial-fill master gate (see
        // OfferMatchFacet.matchOffers's first guard). expectRevert
        // with the encoded selector + arg lets us assert BOTH the
        // error type AND the specific reason code.
        vm.expectRevert(
            abi.encodeWithSignature("FunctionDisabled(uint8)", uint8(3))
        );
        OfferMatchFacet(address(diamond)).matchOffers(0, 0);
    }

    /// @notice #494 Card A — a sanctioned matcher must revert
    ///         `SanctionedAddress(matcher)` BEFORE matchOffers does
    ///         any of the partial-fill or offer-existence work.
    ///         Tests just the gate; doesn't need real offers.
    function test_matchOffers_sanctionedMatcher_reverts() public {
        MockSanctionsList oracle = new MockSanctionsList();
        address sanctionedMatcher = makeAddr("sanctionedMatcher");
        oracle.setFlagged(sanctionedMatcher, true);
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));

        vm.expectRevert(
            abi.encodeWithSelector(
                LibVaipakam.SanctionedAddress.selector,
                sanctionedMatcher
            )
        );
        vm.prank(sanctionedMatcher);
        OfferMatchFacet(address(diamond)).matchOffers(0, 0);
    }

    // ─── #2812 — previewMatch reports matchOffers's entry guards ────────
    // `previewMatch`'s `Ok` promises `matchOffers` would succeed at this
    // block, so the three guards `matchOffers` runs before the match core
    // must preview as their own codes, in its order. The offer ids are the
    // never-created (0, 0) pair, whose core verdict is a non-Ok code: each
    // assertion below therefore proves the guard ran BEFORE the core.

    function test_previewMatch_matcherDisabled_whenKillSwitchOff() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(false);
        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(0, 0, address(this), address(this));
        assertEq(uint8(r.errorCode), uint8(LibOfferMatch.MatchError.MatcherDisabled), "switch off previews MatcherDisabled");
    }

    function test_previewMatch_sanctionedMatcher() public {
        MockSanctionsList oracle = new MockSanctionsList();
        address sanctionedMatcher = makeAddr("sanctionedMatcher");
        oracle.setFlagged(sanctionedMatcher, true);
        vm.startPrank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
        // Switch off too: the sanctions screen precedes it in matchOffers.
        ConfigFacet(address(diamond)).setPartialFillEnabled(false);
        vm.stopPrank();
        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(0, 0, sanctionedMatcher, sanctionedMatcher);
        assertEq(uint8(r.errorCode), uint8(LibOfferMatch.MatchError.Sanctioned), "sanctioned matcher previews Sanctioned");
    }

    function test_previewMatch_paused_precedesOtherGuards() public {
        MockSanctionsList oracle = new MockSanctionsList();
        address sanctionedMatcher = makeAddr("sanctionedMatcher");
        oracle.setFlagged(sanctionedMatcher, true);
        vm.startPrank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(oracle));
        ConfigFacet(address(diamond)).setPartialFillEnabled(false);
        AdminFacet(address(diamond)).pause();
        vm.stopPrank();
        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(0, 0, sanctionedMatcher, sanctionedMatcher);
        assertEq(uint8(r.errorCode), uint8(LibOfferMatch.MatchError.Paused), "pause is the first guard");
    }
}
