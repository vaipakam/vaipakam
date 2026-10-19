// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {Deployments} from "./lib/Deployments.sol";
import {RefreshAllFacetsInPlace, IOwnable} from "./RefreshAllFacetsInPlace.s.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";

/**
 * @title  RefreshChangedFacetsInPlace
 * @notice Testnet in-place refresh of EXACTLY the facets whose executable
 *         bytecode differs from this tree's build — and of nothing else.
 *
 *         {RefreshAllFacetsInPlace} redeploys every facet, because a hand-picked
 *         subset is unsafe: a shared library is INLINED into many facets, so a
 *         change to it reaches facets nobody edited, and a subset chosen by
 *         reading the diff leaves the Diamond running two versions of one rule.
 *         This script removes the hand from the pick. It builds every facet of
 *         this tree locally (no broadcast), compares each one's executable code
 *         with the code the Diamond routes for it today, and refreshes the ones
 *         that differ. A facet that inlines a changed library therefore differs
 *         and is refreshed; a facet whose code is byte-identical is not touched.
 *         The selection is a measurement, not a judgement.
 *
 *         "Executable" means the runtime code without its trailing CBOR
 *         metadata. The metadata hash changes whenever ANY source in a facet's
 *         import closure changes, a comment included, while the code that runs
 *         does not; comparing with it would redeploy byte-identical behaviour.
 *         Facets carry no immutables and no constructors (a facet runs in the
 *         Diamond's context), so nothing else in the code differs per
 *         deployment.
 *
 *         The same compiler property means a facet whose SOURCE did not change
 *         can still measure as changed, when the compilation run around it
 *         differs from the one its live code came from. That errs in the safe
 *         direction: such a facet is redeployed with code equivalent to what it
 *         runs, while a facet whose behaviour changed always differs and is
 *         never missed. The dry run's printed set is the authority, not a list
 *         read from the diff.
 *
 * @dev    WHAT ONE RUN DOES, in order:
 *           1. Testnet chain, owner key, and the slice-3 boundary — the same
 *              refusals as the complete refresh.
 *           2. Local build of every facet ({_deployItems}, outside any
 *              broadcast) and the comparison. The changed set is printed as a
 *              comma-separated key list. A live broadcast must name that exact
 *              list in `EXPECT_CHANGED` (the dry run prints it), so what is
 *              broadcast is what the operator reviewed.
 *           3. Pause (the first transaction), then deploy each changed facet's
 *              MEASURED runtime bytes ({_deployRuntime}), so the bytes cut are
 *              exactly the bytes compared. An artifact read back from disk is
 *              not used: under viaIR a contract's code can depend on which other
 *              files share its compilation run, and a cached artifact can come
 *              from a different run than the one this script measured in (the
 *              reward-epoch facet's did, during development).
 *           4. Cuts, Add or Replace per selector by live routing: the changed
 *              members of the ATOMIC CUT GROUP first, together, in one
 *              transaction ({RefreshAllFacetsInPlace._atomicCutGroup} states
 *              why); every other changed facet whole in one transaction, packed
 *              under {SELECTOR_BUDGET}.
 *           5. {_sweepStaleRoutes}: every route this tree no longer installs —
 *              a retired signature left on a replaced facet — is removed and
 *              re-checked.
 *           6. Completeness: every canonical selector of every facet routes to
 *              an address whose executable code equals this tree's build. After
 *              that check the Diamond routes this tree's COMPLETE selector set,
 *              the same state a complete refresh leaves.
 *           7. The custody complete-cut record ({LibRewardCustody.requireCutover},
 *              the gate on custody activation and every bootstrap write) is
 *              carried forward ONLY when it was current at the start of the run
 *              and the custody protocol version did not move: the Diamond was
 *              then a complete cut before, and step 6 proves it is a complete
 *              cut after. Any other start leaves the record unstamped and says
 *              so — the complete refresh is what establishes one.
 *           8. Unpause, only if this run's pause was the only transition
 *              ({AdminFacet.unpauseIfPauseEpoch}); artifact write-back.
 *
 *         WHAT IT DOES NOT DO: the complete refresh's proxy upgrades, role
 *         backfills and one-shot migrations. Use this script only when the
 *         change being rolled out needs none of them; a change that adds a
 *         refresh-time migration to {RefreshAllFacetsInPlace} is rolled out by
 *         that script. The vault implementation is upgraded by
 *         `UpgradeVaultImplementation.s.sol`.
 *
 *         STORAGE: like every in-place cut, safe only while every storage
 *         change since the Diamond was deployed is append-only.
 *
 *         Env: ADMIN_PRIVATE_KEY (the Diamond's ERC-173 owner), EXPECT_CHANGED
 *         (required on a live broadcast). Usage, from contracts/ on main:
 *           forge script script/RefreshChangedFacetsInPlace.s.sol --sig "refreshChanged()" \
 *             --rpc-url $BASE_SEPOLIA_RPC_URL                      # dry run: prints the set
 *           EXPECT_CHANGED=<the printed list> forge script ... --broadcast --slow
 */
contract RefreshChangedFacetsInPlace is RefreshAllFacetsInPlace {
    /// @notice The changed set the last run found, as printed.
    string public lastChangedKeys;

    function refreshChanged() external {
        _refreshChanged(
            Deployments.readDiamond(), vm.envUint("ADMIN_PRIVATE_KEY"), vm.envOr("EXPECT_CHANGED", string(""))
        );
    }

    /// @notice Parameterised entry — same body as {refreshChanged}, with the
    ///         target, the signer and the expected set passed in rather than
    ///         read from the environment (the process environment is shared by
    ///         parallel test threads; see `RedeployFacets.runWith`).
    function refreshChangedWith(address diamond, uint256 ownerKey, string memory expectChanged) external {
        _refreshChanged(diamond, ownerKey, expectChanged);
    }

    function _refreshChanged(address diamond, uint256 ownerKey, string memory expectChanged) internal {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || cid == 421614 || cid == 97 || cid == 11155111 || cid == 11155420 || cid == 31337,
            "RefreshChangedFacetsInPlace: testnet only"
        );
        require(
            vm.addr(ownerKey) == IOwnable(diamond).owner(),
            "RefreshChangedFacetsInPlace: the signing key is not the diamond owner"
        );
        _requireSlice3Diamond(diamond);
        IDiamondLoupe loupe = IDiamondLoupe(diamond);
        bool writesArtifact = Deployments.artifactWritesEnabled();

        // ── 2. measure ──────────────────────────────────────────────────────
        Item[] memory fresh = _deployItems();
        require(fresh.length == EXPECTED_FACETS, "RefreshChangedFacetsInPlace: facet count drift vs DeployDiamond");
        Item[] memory target = new Item[](fresh.length);
        bool[] memory changed = new bool[](fresh.length);
        uint256 nChanged;
        string memory keys;
        for (uint256 i; i < fresh.length; ++i) {
            address live = _liveHost(loupe, fresh[i].selectors);
            bool differs = live == address(0)
                || keccak256(_executable(live.code)) != keccak256(_executable(fresh[i].impl.code));
            target[i] = Item(fresh[i].key, differs ? address(0) : live, fresh[i].selectors);
            if (differs) {
                changed[i] = true;
                keys = nChanged == 0 ? fresh[i].key : string.concat(keys, ",", fresh[i].key);
                ++nChanged;
            }
        }
        lastChangedKeys = keys;
        console.log("=== Changed-facet in-place refresh ===");
        console.log("Chain id:", cid);
        console.log("Diamond: ", diamond);
        console.log("facets measured:", fresh.length);
        console.log("facets whose executable code differs:", nChanged);
        if (nChanged != 0) console.log("changed set:", keys);
        if (writesArtifact && cid != 31337) {
            require(
                bytes(expectChanged).length != 0,
                "RefreshChangedFacetsInPlace: a live broadcast must set EXPECT_CHANGED to the list the dry run printed"
            );
        }
        if (bytes(expectChanged).length != 0) {
            require(
                keccak256(bytes(expectChanged)) == keccak256(bytes(keys)),
                string.concat("RefreshChangedFacetsInPlace: EXPECT_CHANGED does not match the changed set found: ", keys)
            );
        }
        if (nChanged == 0) {
            console.log("nothing to refresh: every routed facet already runs this tree's code");
            return;
        }

        // The custody complete-cut record as it stands BEFORE any cut (step 7).
        (uint32 stampedV0, uint32 requiredV0, bytes32 stampedR0, bytes32 currentR0) =
            RewardCustodyFacet(diamond).rewardCustodyCutoverStatus();
        bool recordWasCurrent = stampedV0 == requiredV0 && stampedR0 == currentR0;

        // ── 3. pause, deploy ────────────────────────────────────────────────
        vm.startBroadcast(ownerKey);
        bool wasPaused = AdminFacet(diamond).paused();
        (,,, uint64 epochBeforeOurPause) =
            LibPausable.decodePausableSlot(vm.load(diamond, LibPausable.PAUSABLE_STORAGE_POSITION));
        AdminFacet(diamond).pause();
        for (uint256 i; i < fresh.length; ++i) {
            if (!changed[i]) continue;
            address impl = _deployRuntime(fresh[i].impl.code);
            require(
                keccak256(impl.code) == keccak256(fresh[i].impl.code),
                string.concat("RefreshChangedFacetsInPlace: deployed code differs from the measured code: ", fresh[i].key)
            );
            target[i].impl = impl;
            console.log("  deployed", fresh[i].key, impl);
        }

        // ── 4. cut: the atomic group first and whole, then the rest ──────────
        bool[] memory inGroup = _groupMembers(target, _atomicCutGroup());
        IDiamondCut.FacetCut[] memory groupCut = _cutsWhere(loupe, target, changed, inGroup, true);
        if (groupCut.length != 0) {
            IDiamondCut(diamond).diamondCut(groupCut, address(0), "");
            console.log("  cut: atomic group members, one transaction, entries", groupCut.length);
        }
        _cutRestPacked(diamond, loupe, target, changed, inGroup);

        // ── 5. retired routes ──────────────────────────────────────────────
        _sweepStaleRoutes(diamond, loupe, target);

        // ── 6. completeness ────────────────────────────────────────────────
        for (uint256 i; i < target.length; ++i) {
            require(
                keccak256(_executable(target[i].impl.code)) == keccak256(_executable(fresh[i].impl.code)),
                string.concat("RefreshChangedFacetsInPlace: a facet does not run this tree's code: ", target[i].key)
            );
            for (uint256 j; j < target[i].selectors.length; ++j) {
                require(
                    loupe.facetAddress(target[i].selectors[j]) == target[i].impl,
                    string.concat("RefreshChangedFacetsInPlace: a selector is not routed to its facet: ", target[i].key)
                );
            }
        }
        console.log("verified: every canonical selector routes to this tree's code");

        // ── 7. the custody complete-cut record ─────────────────────────────
        (, uint32 requiredV1,,) = RewardCustodyFacet(diamond).rewardCustodyCutoverStatus();
        if (recordWasCurrent && requiredV1 == stampedV0) {
            RewardCustodyFacet(diamond).stampRewardCustodyCutover();
            console.log("custody complete-cut record carried forward (was current; complete again after this cut)");
        } else if (!recordWasCurrent) {
            console.log("custody complete-cut record was NOT current before this run and is left unstamped;");
            console.log("run RefreshAllFacetsInPlace before any custody activation or bootstrap write");
        } else {
            console.log("custody protocol version moved; record left unstamped - run RefreshAllFacetsInPlace");
        }

        // ── 8. unpause, write back ─────────────────────────────────────────
        if (!wasPaused) {
            AdminFacet(diamond).unpauseIfPauseEpoch(epochBeforeOurPause + 1);
        }
        vm.stopBroadcast();

        if (!writesArtifact) {
            console.log("dry run: addresses.json NOT written (no transaction was sent)");
            return;
        }
        for (uint256 i; i < target.length; ++i) {
            if (changed[i]) Deployments.writeFacet(target[i].key, target[i].impl);
        }
        Deployments.writeUint(".facetCount", loupe.facetAddresses().length);
        console.log("addresses.json updated for the changed facets. Next:");
        console.log("  bash script/exportFrontendDeployments.sh");
    }

    /// @dev The one address every selector of a facet routes to today, or
    ///      zero when any of them is unrouted or the set is split across
    ///      addresses. Zero means "refresh it": a facet with no single live
    ///      host is not running one known build.
    function _liveHost(IDiamondLoupe loupe, bytes4[] memory sels) internal view returns (address host) {
        for (uint256 j; j < sels.length; ++j) {
            address a = loupe.facetAddress(sels[j]);
            if (a == address(0) || (j != 0 && a != host)) return address(0);
            host = a;
        }
    }

    /// @dev Runtime code without the trailing CBOR metadata, whose length is
    ///      the code's last two bytes. Code too short to carry it is returned
    ///      as is.
    function _executable(bytes memory code) internal pure returns (bytes memory) {
        uint256 len = code.length;
        if (len < 2) return code;
        uint256 meta = (uint256(uint8(code[len - 2])) << 8) | uint256(uint8(code[len - 1]));
        if (meta + 2 > len) return code;
        bytes memory out = new bytes(len - meta - 2);
        for (uint256 i; i < out.length; ++i) out[i] = code[i];
        return out;
    }

    /// @dev Deploy `runtime` as a contract's code, exactly: the init code is a
    ///      12-byte copier (`PUSH2 len, DUP1, PUSH1 12, PUSH1 0, CODECOPY,
    ///      PUSH1 0, RETURN`) followed by the runtime, which is what a
    ///      constructorless contract's own init code does. Explorers that match
    ///      on runtime code still verify the facet; one that also matches the
    ///      creation code will not, which is the price of cutting exactly the
    ///      bytes that were compared.
    function _deployRuntime(bytes memory runtime) internal returns (address a) {
        require(runtime.length != 0 && runtime.length <= 0xffff, "RefreshChangedFacetsInPlace: runtime size");
        bytes memory init = abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
        assembly ("memory-safe") {
            a := create(0, add(init, 0x20), mload(init))
        }
        require(a != address(0), "RefreshChangedFacetsInPlace: facet deployment failed");
    }

    /// @dev Which items belong to the atomic cut group. An unknown group key
    ///      is a refusal, as in {RefreshAllFacetsInPlace._hoistGroupFirst}: a
    ///      rename must not quietly drop a member out of the group.
    function _groupMembers(Item[] memory items, string[] memory group) internal pure returns (bool[] memory member) {
        member = new bool[](items.length);
        for (uint256 g; g < group.length; ++g) {
            bool found;
            for (uint256 i; i < items.length; ++i) {
                if (keccak256(bytes(items[i].key)) == keccak256(bytes(group[g]))) {
                    member[i] = true;
                    found = true;
                }
            }
            require(found, "RefreshChangedFacetsInPlace: atomic cut group key not found");
        }
    }

    /// @dev The Add / Replace entries of every changed item with
    ///      `member[i] == wantMember`, partitioned by live routing.
    function _cutsWhere(
        IDiamondLoupe loupe,
        Item[] memory items,
        bool[] memory changed,
        bool[] memory member,
        bool wantMember
    ) internal view returns (IDiamondCut.FacetCut[] memory cuts) {
        uint256 n;
        for (uint256 i; i < items.length; ++i) {
            if (changed[i] && member[i] == wantMember) n += _cutOf(loupe, items[i]).length;
        }
        cuts = new IDiamondCut.FacetCut[](n);
        uint256 k;
        for (uint256 i; i < items.length; ++i) {
            if (!changed[i] || member[i] != wantMember) continue;
            IDiamondCut.FacetCut[] memory c = _cutOf(loupe, items[i]);
            for (uint256 j; j < c.length; ++j) cuts[k++] = c[j];
        }
    }

    /// @dev One facet's cut: Replace for its routed selectors, Add for the
    ///      unrouted ones (an empty side is omitted — a cut entry may not be
    ///      empty).
    function _cutOf(IDiamondLoupe loupe, Item memory item) internal view returns (IDiamondCut.FacetCut[] memory c) {
        uint256 nAdd;
        for (uint256 j; j < item.selectors.length; ++j) {
            if (loupe.facetAddress(item.selectors[j]) == address(0)) ++nAdd;
        }
        bytes4[] memory adds = new bytes4[](nAdd);
        bytes4[] memory reps = new bytes4[](item.selectors.length - nAdd);
        uint256 a;
        uint256 r;
        for (uint256 j; j < item.selectors.length; ++j) {
            if (loupe.facetAddress(item.selectors[j]) == address(0)) adds[a++] = item.selectors[j];
            else reps[r++] = item.selectors[j];
        }
        c = new IDiamondCut.FacetCut[]((nAdd != 0 ? 1 : 0) + (reps.length != 0 ? 1 : 0));
        uint256 k;
        if (reps.length != 0) {
            c[k++] = IDiamondCut.FacetCut({
                facetAddress: item.impl, action: IDiamondCut.FacetCutAction.Replace, functionSelectors: reps
            });
        }
        if (nAdd != 0) {
            c[k++] = IDiamondCut.FacetCut({
                facetAddress: item.impl, action: IDiamondCut.FacetCutAction.Add, functionSelectors: adds
            });
        }
    }

    /// @dev Every changed facet outside the atomic group, each one whole in a
    ///      single transaction, packed greedily under {SELECTOR_BUDGET}. A
    ///      facet larger than the budget travels alone.
    function _cutRestPacked(
        address diamond,
        IDiamondLoupe loupe,
        Item[] memory items,
        bool[] memory changed,
        bool[] memory inGroup
    ) internal {
        uint256 i;
        while (i < items.length) {
            uint256 sels;
            uint256 end = i;
            while (end < items.length) {
                uint256 add = (changed[end] && !inGroup[end]) ? items[end].selectors.length : 0;
                if (sels != 0 && sels + add > SELECTOR_BUDGET) break;
                sels += add;
                ++end;
            }
            bool[] memory window = new bool[](items.length);
            for (uint256 w = i; w < end; ++w) window[w] = changed[w] && !inGroup[w];
            IDiamondCut.FacetCut[] memory cut = _cutsWhere(loupe, items, window, new bool[](items.length), false);
            if (cut.length != 0) {
                IDiamondCut(diamond).diamondCut(cut, address(0), "");
                console.log("  cut batch: entries", cut.length, "selectors", sels);
            }
            i = end;
        }
    }
}
