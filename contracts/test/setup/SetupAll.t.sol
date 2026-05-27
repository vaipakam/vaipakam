// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupLifecycle} from "./SetupLifecycle.t.sol";
import {SetupRewards} from "./SetupRewards.t.sol";
import {SetupMetrics} from "./SetupMetrics.t.sol";
import {SetupTreasury} from "./SetupTreasury.t.sol";
import {SetupConfig} from "./SetupConfig.t.sol";
import {SetupCore} from "./SetupCore.t.sol";

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";

/// @title SetupAll — full-surface base mirroring the old `SetupTest`'s
///         facet footprint via C3 multi-inheritance.
/// @notice Inheriting `SetupAll` deploys every facet the old `SetupTest`
///         deployed (39 total: 37 spread across the family mixins + 2 added
///         here — `TestMutatorFacet` (test-only) and `OracleAdminFacet`).
///         Existing test files that genuinely use the full diamond surface
///         migrate from `is SetupTest` → `is SetupAll` at Stage 5.
///
/// @dev C3 linearization order is fixed by the order of `is ...` here.
///      With this declaration, the resolved MRO is:
///        SetupAll → SetupLifecycle → SetupLoans → SetupOffers →
///        SetupRewards → SetupMetrics → SetupTreasury → SetupConfig →
///        SetupCore → TestBase → Test
///      Each `setUp` calls `super.setUp()` first so execution actually
///      runs in REVERSE — TestBase work, then SetupCore (Diamond +
///      8 core facets + initializeAccessControl), then each family's
///      diamondCut in order, then SetupAll's two extras.
abstract contract SetupAll is
    SetupLifecycle,
    SetupRewards,
    SetupMetrics,
    SetupTreasury,
    SetupConfig
{
    TestMutatorFacet internal testMutatorFacet;
    OracleAdminFacet internal oracleAdminFacet;

    function setUp()
        public
        virtual
        override(SetupLifecycle, SetupRewards, SetupMetrics, SetupTreasury, SetupConfig)
    {
        super.setUp(); // walks C3 chain: SetupLifecycle → ... → SetupCore → TestBase

        testMutatorFacet = new TestMutatorFacet();
        oracleAdminFacet = new OracleAdminFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(testMutatorFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getTestMutatorFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(oracleAdminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOracleAdminFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }
}
