// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupLifecycle} from "./SetupLifecycle.t.sol";
import {SetupRewards} from "./SetupRewards.t.sol";
import {SetupMetrics} from "./SetupMetrics.t.sol";
import {SetupTreasury} from "./SetupTreasury.t.sol";
import {SetupConfig} from "./SetupConfig.t.sol";

/// @title SetupAll — full-surface base mirroring the old `SetupTest`'s
///         facet footprint via C3 multi-inheritance.
/// @notice Inheriting `SetupAll` deploys every facet the old `SetupTest`
///         deployed. Existing test files that genuinely use the full
///         diamond surface migrate from `is SetupTest` → `is SetupAll`
///         at Stage 5.
///
/// @dev Stage 2 reshape: `TestMutatorFacet`, `OracleAdminFacet`,
///      `ConfigFacet`, and `LegalFacet` moved into `SetupCore` (broadly
///      needed). SetupAll no longer adds them here — they arrive via
///      the inherited Core. The multi-inheritance below picks up every
///      domain family's additions on top of Core.
///
/// @dev C3 linearization order is fixed by the order of `is ...`. With
///      this declaration, the resolved MRO walks:
///        SetupAll → SetupLifecycle → SetupLoans → SetupOffers →
///        SetupRewards → SetupMetrics → SetupTreasury → SetupConfig →
///        SetupCore → TestBase → Test
///      Each `setUp` calls `super.setUp()` first so execution actually
///      runs in REVERSE — TestBase work, then SetupCore (Diamond +
///      13 core facets + initializeAccessControl + mocks + oracle
///      defaults), then each family's incremental diamondCut, then
///      SetupAll's no-op leaf.
abstract contract SetupAll is
    SetupLifecycle,
    SetupRewards,
    SetupMetrics,
    SetupTreasury,
    SetupConfig
{
    function setUp()
        public
        virtual
        override(SetupLifecycle, SetupRewards, SetupMetrics, SetupTreasury, SetupConfig)
    {
        super.setUp(); // walks the C3 chain
    }
}
