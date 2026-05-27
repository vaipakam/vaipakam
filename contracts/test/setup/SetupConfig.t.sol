// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupCore} from "./SetupCore.t.sol";

/// @title SetupConfig — alias for SetupCore (Stage 2 reshape).
/// @notice Stage 2 of the audit moved `ConfigFacet` + `LegalFacet` into
///         `SetupCore` (broadly needed across families). SetupConfig
///         remains as a thin alias so the migration mapping in the design
///         doc stays readable ("Config / Legal tests → SetupConfig") and
///         so future config-specific helpers have a logical home if
///         they're ever needed. No additional facets, no additional setUp.
///
/// @dev If you find yourself adding facets here, ask first whether they
///      belong in SetupCore (broadly needed) or in a more specific base.
abstract contract SetupConfig is SetupCore {
    function setUp() public virtual override {
        super.setUp();
    }
}
