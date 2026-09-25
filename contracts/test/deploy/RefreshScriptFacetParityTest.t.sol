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

    function retired() external pure returns (bytes4[] memory) {
        return _retiredSelectors();
    }
    /// #1566 transport epochs PR 3b — expose the group hoist and the group
    /// itself so the atomicity guarantee they provide can be asserted rather
    /// than trusted.
    function hoistGroup(Item[] memory items, string[] memory keys)
        external
        pure
        returns (Item[] memory, uint256)
    {
        uint256 n = _hoistGroupFirst(items, keys);
        return (items, n);
    }

    function atomicGroup() external pure returns (string[] memory) {
        return _atomicCutGroup();
    }

    /// The budget is `internal constant` on the script; surfaced here rather
    /// than widened there, so the test reads the same figure `refresh()` does
    /// without changing the script's API.
    function selectorBudget() external pure returns (uint256) {
        return SELECTOR_BUDGET;
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

    /// @notice #1566 transport epochs PR 3b (Codex #2232 r3) — the ATOMIC CUT
    ///         GROUP's MEMBERSHIP, pinned.
    ///
    /// @dev    The rule the script states: a facet belongs to the group when
    ///         its replacement changes how the transport-epoch ledger is
    ///         written or read, such that running it against another member's
    ///         previous bytecode would make two surfaces disagree about one
    ///         amount. Three review rounds each found a different instance of
    ///         that one defect and each was answered by hoisting one more name,
    ///         which is why the list is now a declared set with a test on it
    ///         rather than a sequence of remembered special cases.
    ///
    ///         Pinned by exact content, not by `length >= 3`: the failure this
    ///         guards is a member being DROPPED or RENAMED, which a loose
    ///         assertion would pass. A deliberate change to the lifecycle's
    ///         membership updates this list and says why in the PR.
    function test_AtomicCutGroup_MembershipIsPinned() public {
        string[] memory keys = new RefreshItemsProbe().atomicGroup();
        assertEq(keys.length, 3, "the transport-epoch lifecycle has three participants");
        assertEq(keys[0], "rewardIngressFacet", "the ingress OPENS an epoch");
        assertEq(keys[1], "rewardReconciliationFacet", "classifyLegacyPacket SPENDS from it");
        assertEq(keys[2], "rewardEpochFacet", "and the epoch facet carries the lifecycle between");
    }

    /// @notice The group is hoisted WHOLE and to the FRONT, and the hoist
    ///         loses nothing.
    /// @dev    The contiguity is the load-bearing part: `refresh()` records the
    ///         batch boundary at `i + 1 == groupLen`, so a hoist that left a
    ///         member behind would put the boundary in the wrong place and cut
    ///         a partial group as the first transaction — the mixed-version
    ///         window, reopened by the very machinery meant to close it.
    function test_AtomicCutGroup_IsHoistedWholeAndContiguous() public {
        RefreshItemsProbe probe = new RefreshItemsProbe();
        RefreshAllFacetsInPlace.Item[] memory items = probe.deployItemsForTest();
        string[] memory keys = probe.atomicGroup();
        uint256 before = items.length;

        (RefreshAllFacetsInPlace.Item[] memory hoisted, uint256 groupLen) =
            probe.hoistGroup(items, keys);

        assertEq(hoisted.length, before, "nothing added or dropped");
        assertEq(groupLen, keys.length, "every member was placed");
        for (uint256 k; k < keys.length; ++k) {
            assertEq(hoisted[k].key, keys[k], "the group leads, in order");
        }
        // No member appears twice, and nothing else was lost: every key in the
        // hoisted array occurs exactly as often as it did before.
        for (uint256 k; k < keys.length; ++k) {
            uint256 seen;
            for (uint256 i; i < hoisted.length; ++i) {
                if (keccak256(bytes(hoisted[i].key)) == keccak256(bytes(keys[k]))) ++seen;
            }
            assertEq(seen, 1, "a group member appears exactly once");
        }
    }

    /// @notice A rename must not silently leave the order unchanged and
    ///         reopen the window the group exists to close.
    function test_AtomicCutGroup_RevertsOnAnUnknownKey() public {
        RefreshItemsProbe probe = new RefreshItemsProbe();
        RefreshAllFacetsInPlace.Item[] memory items = probe.deployItemsForTest();
        string[] memory keys = new string[](1);
        keys[0] = "rewardIngressFacetRenamed";
        vm.expectRevert(bytes("RefreshAllFacetsInPlace: atomic cut group key not found"));
        probe.hoistGroup(items, keys);
    }

    /// @notice A DUPLICATE key is refused, because it would swap a member back
    ///         out of the group it had just been placed in and leave `groupLen`
    ///         reporting a group larger than the one actually built — the
    ///         boundary then falls past the group's end and the first
    ///         transaction carries an unrelated facet.
    function test_AtomicCutGroup_RevertsOnADuplicateKey() public {
        RefreshItemsProbe probe = new RefreshItemsProbe();
        RefreshAllFacetsInPlace.Item[] memory items = probe.deployItemsForTest();
        string[] memory keys = new string[](2);
        keys[0] = "rewardIngressFacet";
        keys[1] = "rewardIngressFacet";
        vm.expectRevert(bytes("RefreshAllFacetsInPlace: duplicate atomic cut group key"));
        probe.hoistGroup(items, keys);
    }

    /// @notice The whole group fits in ONE diamondCut transaction.
    /// @dev    `refresh()` requires this at run time; asserting it here means
    ///         a group that outgrows the budget fails a test rather than a
    ///         live refresh. Growth is the realistic way it breaks: the group
    ///         holds `rewardReconciliationFacet`, whose surface has grown in
    ///         several PRs of this programme.
    function test_AtomicCutGroup_FitsOneSelectorBudget() public {
        RefreshItemsProbe probe = new RefreshItemsProbe();
        RefreshAllFacetsInPlace.Item[] memory items = probe.deployItemsForTest();
        string[] memory keys = probe.atomicGroup();
        (RefreshAllFacetsInPlace.Item[] memory hoisted, uint256 groupLen) =
            probe.hoistGroup(items, keys);

        uint256 total;
        for (uint256 i; i < groupLen; ++i) total += hoisted[i].selectors.length;
        assertLe(
            total,
            probe.selectorBudget(),
            "the atomic cut group no longer fits one transaction - it cannot be "
            "split without reopening the mixed-version window, so raise "
            "SELECTOR_BUDGET or move a surface off a group member"
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

    /// @notice #1566 slice 4 PR A (Codex #2158 r30 P1) — the refresh REMOVES
    ///         the selectors this upgrade retired. Two things must hold: no
    ///         retired selector is one the current deploy routes (removing
    ///         it would strand a live function), and the list names the
    ///         legacy one-argument seed, which must not survive routed to
    ///         bytecode that checks neither the manual pause nor the epoch.
    function test_RefreshScript_RetiredSelectors_AreNotRoutedByDeploy() public {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");
        DeployDiamond deployScript = new DeployDiamond();
        address deployer = vm.addr(DEPLOYER_KEY);
        deployScript.runWith(deployer, TREASURY, DEPLOYER_KEY);
        address diamond = deployScript.diamond();

        bytes4[] memory retired = new RefreshItemsProbe().retired();
        assertGt(retired.length, 0, "the retired list is empty - the legacy seed selector must be listed");
        bool namesLegacySeed;
        for (uint256 i; i < retired.length; ++i) {
            assertEq(
                IDiamondLoupe(diamond).facetAddress(retired[i]),
                address(0),
                "a retired selector is routed by the current DeployDiamond - removing it would strand a live function"
            );
            if (retired[i] == bytes4(keccak256("seedArmedFreshPaid(uint256)"))) namesLegacySeed = true;
        }
        assertTrue(namesLegacySeed, "the legacy seedArmedFreshPaid(uint256) selector is not retired");
        // 3b-ii-A (Codex #2276 r3 P1, r14 P2) — the four-argument vault credit
        // is NOT retired: it is a compatibility entry on the refreshed
        // VaultFactoryFacet, routed by the deploy to the SAME facet as its
        // five-argument successor, so a settle facet from before the epoch
        // leg keeps delivering to the vault after a facet-by-facet refresh —
        // and the retired list must not name it, or the refresh would remove
        // a live route.
        bytes4 fourArg = bytes4(keccak256("vaultCreditFromRewardCustodyERC20(address,address,uint256,uint256)"));
        bytes4 fiveArg = bytes4(keccak256("vaultCreditFromRewardCustodyERC20(address,address,uint256,uint256,uint256)"));
        for (uint256 i; i < retired.length; ++i) {
            assertTrue(retired[i] != fourArg, "the four-argument vault credit is a live compatibility entry, not a retired selector");
        }
        address vaultFacet = IDiamondLoupe(diamond).facetAddress(fiveArg);
        assertTrue(vaultFacet != address(0), "the five-argument vault credit is not routed");
        assertEq(IDiamondLoupe(diamond).facetAddress(fourArg), vaultFacet, "the four-argument vault credit is not routed to the same facet");
        assertTrue(
            IDiamondLoupe(diamond).facetAddress(bytes4(keccak256("seedArmedFreshPaid(uint256,uint64)"))) != address(0),
            "the epoch-bound seed is not routed"
        );
    }
}
