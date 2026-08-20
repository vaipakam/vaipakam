// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {RefreshAllFacetsInPlace} from "../../script/RefreshAllFacetsInPlace.s.sol";
import {DiamondFacetNames} from "./DiamondFacetNames.sol";

/**
 * @title  RefreshScriptFacetParityTest
 * @notice #1793 guardrail. Asserts `RefreshAllFacetsInPlace.EXPECTED_FACETS`
 *         equals the number of facets the Diamond is actually built from, so a
 *         facet added to `DeployDiamond` but not mirrored into the in-place
 *         refresh script fails CI instead of failing a live redeploy.
 *
 * @dev    Why this cannot live inside the script. `refresh()` already guards
 *         itself:
 *
 *             require(items.length == EXPECTED_FACETS,
 *                     "RefreshAllFacetsInPlace: facet count drift vs DeployDiamond");
 *
 *         The message says "vs DeployDiamond", but the comparison is against the
 *         script's OWN constant. Adding a facet to `DeployDiamond` and touching
 *         neither `_deployItems()` nor `EXPECTED_FACETS` — the natural way to
 *         forget one, since you edit neither line — leaves that require
 *         satisfied. The script then refreshes every facet EXCEPT the new one,
 *         which keeps running pre-change bytecode while everything around it
 *         moves on: the half-applied-family hazard the script's own header warns
 *         about for paired facets.
 *
 *         That is not hypothetical. #1780 added `EarlyWithdrawalDirectFacet` and
 *         missed this script; the deploy-sanity suite, the excision gate and a
 *         full local `predeploy-check.sh` all passed green with it missing, and
 *         only Codex's review caught it (#1791 F1). A guard that compares a
 *         constant against itself is not a guard.
 *
 *         So the cross-check has to sit where BOTH lists are visible, and that
 *         is the test layer. The dependency direction is the point: a production
 *         refresh script must not import `test/` to validate itself, whereas a
 *         test may freely import the script. Hence `EXPECTED_FACETS` is
 *         `public` (a constant, so the getter costs nothing and no behaviour
 *         changes) and this test reads it from outside.
 *
 *         Ground truth is `DiamondFacetNames.cutFacetNames()`, which the suite
 *         already documents as mirroring `DeployDiamond`'s `cuts[]` and which
 *         `SelectorCoverageTest` independently cross-checks against the
 *         compiled facet ABIs. So this test inherits that list's correctness
 *         rather than introducing a third hand-maintained count.
 *
 *         NOT covered here, and deliberately — two gaps, both for the same
 *         reason and both tracked in #1793:
 *
 *         1. Whether every cut facet also gets a `Deployments.writeFacet(...)`
 *            call (#1791 F2). Solidity cannot see whether a call exists in a
 *            script's body.
 *
 *         2. Whether each `Item.key` string matches the deployment-artifact key
 *            `DeployDiamond` writes for that facet. This test proves the refresh
 *            covers the right CODE — selector set and per-selector codehash both
 *            match the built Diamond — but says nothing about the LABELS. A
 *            typo'd or swapped key still passes every assertion below, and a
 *            refresh that writes the wrong key mislabels the artifact consumers
 *            read. Unreachable from Solidity for three separate reasons: the
 *            canonical keys exist only as string literals inside `writeFacet`
 *            calls, with no enumerable list to compare against; the on-disk
 *            artifact is a RECORD of past deploys rather than a spec of the
 *            current facet set, so it cannot serve as ground truth (base-sepolia
 *            legitimately carries 70 facet keys and no `earlyWithdrawalDirectFacet`,
 *            anvil 61); and `Deployments.path()` derives its path from
 *            `block.chainid` with no override (`script/lib/Deployments.sol:202`),
 *            so a test cannot emit keys to a scratch location to diff them.
 *
 *         Both belong in `predeploy-check.sh`, which reads the script sources as
 *         text and can compare all three lists against each other.
 */
/// @dev Exposes the script's internal item builder so the test can inspect what
///      it actually produced. A subclass is needed because `_deployItems()` must
///      stay non-public on the script itself — it DEPLOYS all 73 facets, so it is
///      not something an operator should be able to invoke by accident.
contract RefreshItemsProbe is RefreshAllFacetsInPlace {
    function deployItemsForTest() external returns (Item[] memory) {
        return _deployItems();
    }
}

contract RefreshScriptFacetParityTest is Test, DiamondFacetNames {
    /// @dev Mirrors `DeployDiamondIntegrationTest`'s constants so the deploy in
    ///      the selector-set test below behaves identically.
    uint256 internal constant DEPLOYER_KEY = 1;
    address internal constant TREASURY = address(0xBEEF);

    /// @dev Selector sets for the equality check. Mappings for O(1) membership,
    ///      plus a list so the reverse direction can be iterated.
    mapping(bytes4 => bool) private _routedByDeploy;
    mapping(bytes4 => bool) private _cutByRefresh;
    bytes4[] private _routedList;

    function test_RefreshScript_FacetCount_MatchesDiamond() public {
        uint256 refreshExpects = new RefreshAllFacetsInPlace().EXPECTED_FACETS();
        uint256 diamondHas = cutFacetNames().length;

        assertEq(
            refreshExpects,
            diamondHas,
            "facet-count drift: RefreshAllFacetsInPlace is out of step with the "
            "Diamond. Adding a facet needs BOTH an items[] entry in "
            "_deployItems() AND a bump to EXPECTED_FACETS in "
            "script/RefreshAllFacetsInPlace.s.sol. The script's own require "
            "cannot catch this (it compares that constant against itself) - "
            "see #1793."
        );
    }

    /// @notice Every slot `_deployItems()` allocates must actually be FILLED.
    ///
    /// @dev    Codex #1795 P1, and the case the count assertion above cannot
    ///         reach. `_deployItems()` opens with
    ///         `items = new Item[](EXPECTED_FACETS)`, so the array's LENGTH comes
    ///         from the constant and not from the assignments below it. A
    ///         developer who adds a facet, bumps `cutFacetNames()` and
    ///         `EXPECTED_FACETS`, and forgets `items[N] = Item(...)` leaves a
    ///         zero-valued slot: empty key, `address(0)` implementation, no
    ///         selectors. Both length checks — `refresh()`'s `require` and the
    ///         count test above — still pass, and the live refresh silently skips
    ///         that facet, which is the precise failure this file exists to stop.
    ///
    ///         So the contents are read, not just the size. Reading them also
    ///         catches the adjacent slip: a copy-pasted line that overwrites an
    ///         existing index instead of filling the new one leaves the array
    ///         full-length with a DUPLICATE key and a hole elsewhere, which the
    ///         per-slot check alone would miss on the duplicated side.
    function test_RefreshScript_EverySlotIsPopulated() public {
        RefreshAllFacetsInPlace.Item[] memory items = new RefreshItemsProbe().deployItemsForTest();

        assertEq(
            items.length,
            cutFacetNames().length,
            "_deployItems() produced a different number of items than the Diamond has facets"
        );

        for (uint256 i; i < items.length; ++i) {
            string memory where = string.concat("items[", vm.toString(i), "]");
            assertGt(
                bytes(items[i].key).length,
                0,
                string.concat(
                    where,
                    " has no addresses.json key - a slot was allocated but never assigned in _deployItems()"
                )
            );
            assertTrue(
                items[i].impl != address(0),
                string.concat(where, " has a zero implementation address - slot allocated but never assigned")
            );
            assertGt(
                items[i].selectors.length,
                0,
                string.concat(where, " routes no selectors - slot allocated but never assigned")
            );
        }

        // Duplicate keys mean one index was written twice and another left empty.
        for (uint256 i; i < items.length; ++i) {
            for (uint256 j = i + 1; j < items.length; ++j) {
                assertTrue(
                    keccak256(bytes(items[i].key)) != keccak256(bytes(items[j].key)),
                    string.concat(
                        "duplicate facet key '",
                        items[i].key,
                        "' at items[",
                        vm.toString(i),
                        "] and items[",
                        vm.toString(j),
                        "] - an assignment overwrote an existing index instead of filling a new one"
                    )
                );
            }
        }
    }

    /// @notice The refresh's selector set must EQUAL what `DeployDiamond`
    ///         actually routes onto a Diamond.
    ///
    /// @dev    Codex #1795 round-2 P1, and the case neither assertion above can
    ///         reach. Both of those are structural — a count, then
    ///         non-emptiness and uniqueness. None of them looks at *identity*.
    ///         So a change that SWAPS one cut facet for another at the same
    ///         total passes everything: `DeployDiamond` and `cutFacetNames()`
    ///         carry the new facet while `_deployItems()` still carries the
    ///         retired one, all 73 slots stay populated and unique, and the
    ///         refresh then omits the new facet *and* recuts the retired
    ///         selectors — the half-applied state this file exists to prevent.
    ///
    ///         Compared by SELECTOR SET rather than by name, deliberately.
    ///         `cutFacetNames()` holds contract names (`DiamondLoupeFacet`)
    ///         while `items[].key` holds addresses.json keys
    ///         (`diamondLoupeFacet`); normalising between them means
    ///         lowercasing the first character, which breaks on acronym-initial
    ///         names like `VPFITokenFacet`. A naming heuristic inside a drift
    ///         guard is just a new drift surface. Selector sets need no mapping.
    ///
    ///         Ground truth is the Diamond `DeployDiamond.run()` actually
    ///         builds, read back through the loupe — not a list maintained
    ///         here. Re-deriving the canonical union locally would mean copying
    ///         `SelectorCoverageTest._populateRoutedSet()`'s 73 calls, i.e.
    ///         adding an eighth registry place, which is the very drift the
    ///         suite warns about. Same `runWith` + `DEPLOY_SKIP_ARTIFACTS`
    ///         pattern `DeployDiamondIntegrationTest` uses, for the same
    ///         reasons documented there (thread-local args, no artifact
    ///         clobber).
    ///
    ///         `DiamondCutFacet` is excluded on both sides: the
    ///         `VaipakamDiamond` constructor installs it, so it is not in any
    ///         `cuts[]` list, not in `cutFacetNames()`, and not in
    ///         `_deployItems()` — exactly as `DiamondFacetNames` documents.
    function test_RefreshScript_SelectorSet_MatchesDeployedDiamond() public {
        // ── canonical side: what a real deploy routes ──────────────────
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");
        DeployDiamond deployScript = new DeployDiamond();
        address deployer = vm.addr(DEPLOYER_KEY);
        deployScript.runWith(deployer, TREASURY, DEPLOYER_KEY);
        address diamond = deployScript.diamond();

        IDiamondLoupe.Facet[] memory live = IDiamondLoupe(diamond).facets();
        uint256 routedCount;
        for (uint256 i; i < live.length; ++i) {
            for (uint256 j; j < live[i].functionSelectors.length; ++j) {
                bytes4 sel = live[i].functionSelectors[j];
                if (sel == IDiamondCut.diamondCut.selector) continue; // constructor-installed
                if (!_routedByDeploy[sel]) {
                    _routedByDeploy[sel] = true;
                    _routedList.push(sel);
                    routedCount++;
                }
            }
        }
        assertGt(routedCount, 0, "loupe returned no selectors - deploy did not build a Diamond");

        // ── refresh side: what an in-place refresh would cut ───────────
        RefreshAllFacetsInPlace.Item[] memory items = new RefreshItemsProbe().deployItemsForTest();
        for (uint256 i; i < items.length; ++i) {
            // Codex round-3 P1: selector-set equality is STILL blind to a wrong
            // implementation. Keep the canonical selector getter but instantiate a
            // different facet — `Item(key, address(new WrongFacet()),
            // _getRightSelectors())` — and the union is unchanged, so both
            // directions below pass. The refresh would then route those selectors
            // to a facet that does not implement them, and the script's own
            // post-cut verification passes too, because it compares live routing
            // against that same wrong address.
            //
            // So the IMPLEMENTATION is compared as well, by `codehash` rather than
            // by address: the refresh deploys fresh instances by design, so the
            // addresses MUST differ while the runtime code must not.
            bytes32 itemCodeHash = items[i].impl.codehash;
            assertTrue(
                itemCodeHash != bytes32(0),
                string.concat("items[", vm.toString(i), "] impl has no runtime code")
            );

            for (uint256 j; j < items[i].selectors.length; ++j) {
                bytes4 sel = items[i].selectors[j];
                _cutByRefresh[sel] = true;
                assertTrue(
                    _routedByDeploy[sel],
                    string.concat(
                        "the refresh would cut selector ",
                        vm.toString(sel),
                        " (facet '",
                        items[i].key,
                        "') that DeployDiamond does not route - a retired facet is still listed in _deployItems()"
                    )
                );
                assertEq(
                    itemCodeHash,
                    IDiamondLoupe(diamond).facetAddress(sel).codehash,
                    string.concat(
                        "items[",
                        vm.toString(i),
                        "] ('",
                        items[i].key,
                        "') would cut selector ",
                        vm.toString(sel),
                        " to an implementation whose runtime code differs from the facet that owns it on the"
                        " deployed Diamond - the wrong facet is instantiated for these selectors"
                    )
                );
            }
        }

        for (uint256 i; i < _routedList.length; ++i) {
            assertTrue(
                _cutByRefresh[_routedList[i]],
                string.concat(
                    "DeployDiamond routes selector ",
                    vm.toString(_routedList[i]),
                    " that the refresh would NOT cut - a facet is missing from _deployItems()"
                )
            );
        }
    }
}
