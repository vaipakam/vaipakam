// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ZeroExAggregatorAdapter} from "../../src/adapters/ZeroExAggregatorAdapter.sol";
import {HandoverPlan} from "../../script/lib/HandoverPlan.sol";
import {ChainContracts} from "../../script/lib/ChainContracts.sol";
import {PlainOwnable2StepHarness, ChainlinkStyleOwnable2StepHarness} from "../mocks/GovernanceHarnesses.sol";

/// @dev Stands in for the Diamond's registry getters, the only part of the
///      Diamond the walk reads.
contract RegistryDiamondStub {
    address[] internal adapters;
    address internal rateModel;
    address internal backstop;

    function set(address[] memory a, address model, address backstop_) external {
        adapters = a;
        rateModel = model;
        backstop = backstop_;
    }

    function getSwapAdapters() external view returns (address[] memory) {
        return adapters;
    }

    function getRateModel() external view returns (address) {
        return rateModel;
    }

    function getBackstopVault() external view returns (address) {
        return backstop;
    }
}

/// @dev A one-step `Ownable`: no `pendingOwner()`.
contract OneStepOwned is Ownable {
    constructor(address owner_) Ownable(owner_) {}
}

/// @dev Answers nothing about ownership.
contract NotOwned {}

/**
 * @title HandoverPlanDiscoveryTest
 * @notice #2743: the handover's owned contracts are FOUND, from the artifact
 *         and the Diamond's own registries, not listed. Whatever answers
 *         `owner()` with an owner other than the Diamond or zero is in the
 *         plan; the swap adapters were the contracts a hand list missed.
 */
contract HandoverPlanDiscoveryTest is Test {
    address internal admin = makeAddr("admin");
    address internal timelock = makeAddr("timelock");

    RegistryDiamondStub internal diamond;
    ZeroExAggregatorAdapter internal adapterOnAdmin;
    ZeroExAggregatorAdapter internal adapterOnDiamond;
    OneStepOwned internal rateModel;
    PlainOwnable2StepHarness internal sanctionsList;
    ChainlinkStyleOwnable2StepHarness internal chainlinkShaped;
    PlainOwnable2StepHarness internal renounced;
    PlainOwnable2StepHarness internal facetLike;
    NotOwned internal weth;
    PlainOwnable2StepHarness internal backstop;

    function setUp() public {
        vm.etch(timelock, hex"00");
        diamond = new RegistryDiamondStub();
        address[] memory seed = new address[](1);
        seed[0] = makeAddr("settler");
        adapterOnAdmin = new ZeroExAggregatorAdapter(admin, makeAddr("ah"), seed);
        adapterOnDiamond = new ZeroExAggregatorAdapter(address(diamond), makeAddr("ah"), seed);
        rateModel = new OneStepOwned(admin);
        sanctionsList = new PlainOwnable2StepHarness(admin);
        chainlinkShaped = new ChainlinkStyleOwnable2StepHarness(admin);
        renounced = new PlainOwnable2StepHarness(admin);
        vm.prank(admin);
        renounced.renounceOwnership();
        facetLike = new PlainOwnable2StepHarness(admin);
        weth = new NotOwned();
        backstop = new PlainOwnable2StepHarness(address(diamond));

        address[] memory adapters = new address[](2);
        adapters[0] = address(adapterOnAdmin);
        adapters[1] = address(adapterOnDiamond);
        diamond.set(adapters, address(rateModel), address(backstop));
    }

    function _json() internal returns (string memory) {
        vm.serializeAddress("facets", "someFacet", address(facetLike));
        string memory facets = vm.serializeAddress("facets", "otherFacet", address(weth));
        vm.serializeAddress("nested", "inner", address(chainlinkShaped));
        string memory nested = vm.serializeAddress("nested", "dupe", address(adapterOnAdmin));
        vm.serializeAddress("a", "diamond", address(diamond));
        vm.serializeAddress("a", "timelock", timelock);
        vm.serializeAddress("a", "sanctionsList", address(sanctionsList));
        vm.serializeAddress("a", "weth", address(weth));
        vm.serializeAddress("a", "someImpl", address(renounced));
        vm.serializeString("a", "facets", facets);
        return vm.serializeString("a", "nested", nested);
    }

    function test_walk_findsTheRegistriesAndTheArtifactOnce() public {
        ChainContracts.Found[] memory f = ChainContracts.walk(address(diamond), _json());
        // backstop, two adapters, rate model, then the artifact: diamond,
        // timelock, sanctionsList, weth, someImpl and nested.inner (the
        // facets are skipped and nested.dupe repeats an adapter).
        assertEq(f.length, 10);
        assertEq(f[0].addr, address(backstop));
        assertEq(f[0].source, "getBackstopVault()");
        assertEq(f[1].source, "getSwapAdapters()[0]");
        assertEq(f[2].source, "getSwapAdapters()[1]");
        assertEq(f[3].source, "getRateModel()");
        for (uint256 i; i < f.length; ++i) {
            assertTrue(f[i].addr != address(facetLike), "facets are the loupe's, never walked");
        }
    }

    function test_targets_holdEveryOwnedContractNotGovernedThroughTheDiamond() public {
        HandoverPlan.Target[] memory t = HandoverPlan.targets(_json(), address(diamond), timelock);
        HandoverPlan.Target[] memory listed = HandoverPlan.read(_json());
        // The listed slots come first, unchanged.
        for (uint256 i; i < listed.length; ++i) {
            assertEq(t[i].label, listed[i].label);
        }
        uint256 base = listed.length;
        assertEq(t.length, base + 4, "adapter on admin, rate model, sanctions list, chainlink-shaped");

        assertEq(t[base].addr, address(adapterOnAdmin));
        assertEq(t[base].label, "getSwapAdapters()[0]");
        assertEq(uint8(t[base].kind), uint8(HandoverPlan.OwnableKind.OpenZeppelin));
        assertFalse(t[base].required);
        assertFalse(t[base].guardian);

        assertEq(t[base + 1].addr, address(rateModel));
        assertEq(
            uint8(t[base + 1].kind),
            uint8(HandoverPlan.OwnableKind.Chainlink),
            "no pendingOwner(): read from events, where a one-step Ownable has none"
        );

        // The artifact's own order is the JSON key order; find them by address.
        HandoverPlan.Target memory list = _find(t, address(sanctionsList));
        assertEq(list.label, ".sanctionsList");
        assertEq(uint8(list.kind), uint8(HandoverPlan.OwnableKind.OpenZeppelin));
        HandoverPlan.Target memory hidden = _find(t, address(chainlinkShaped));
        assertEq(hidden.label, ".nested.inner");
        assertEq(uint8(hidden.kind), uint8(HandoverPlan.OwnableKind.Chainlink));
    }

    /// @dev After the handover the found contracts are the Timelock's, and
    ///      they stay in the plan so the gate checks them.
    function test_targets_keepATimelockOwnedContract() public {
        vm.prank(admin);
        sanctionsList.transferOwnership(timelock);
        vm.prank(timelock);
        sanctionsList.acceptOwnership();
        HandoverPlan.Target[] memory t = HandoverPlan.targets(_json(), address(diamond), timelock);
        assertTrue(_has(t, address(sanctionsList)));
    }

    function test_targets_leaveOutWhatTheDiamondGovernsOrNobodyOwns() public {
        HandoverPlan.Target[] memory t = HandoverPlan.targets(_json(), address(diamond), timelock);
        assertFalse(_has(t, address(adapterOnDiamond)), "the Diamond's own");
        assertFalse(_has(t, address(backstop)), "the Diamond's own");
        assertFalse(_has(t, address(renounced)), "nobody's");
        assertFalse(_has(t, address(weth)), "not ownable");
        assertFalse(_has(t, address(diamond)), "its own leg");
        assertFalse(_has(t, timelock), "its own leg");
        assertFalse(_has(t, address(facetLike)), "facets");
    }

    /// @dev A Diamond with no registry getters (an older facet set) reads as
    ///      no candidates, never a revert.
    function test_walk_toleratesAMissingGetter() public {
        NotOwned bare = new NotOwned();
        ChainContracts.Found[] memory f = ChainContracts.walk(address(bare), "");
        assertEq(f.length, 0);
    }

    function _find(HandoverPlan.Target[] memory t, address a) internal pure returns (HandoverPlan.Target memory) {
        for (uint256 i; i < t.length; ++i) {
            if (t[i].addr == a) return t[i];
        }
        revert("not in the plan");
    }

    function _has(HandoverPlan.Target[] memory t, address a) internal pure returns (bool) {
        for (uint256 i; i < t.length; ++i) {
            if (t[i].addr == a) return true;
        }
        return false;
    }
}
