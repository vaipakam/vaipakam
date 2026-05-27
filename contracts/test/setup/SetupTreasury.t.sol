// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupCore} from "./SetupCore.t.sol";

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {TreasuryFacet} from "../../src/facets/TreasuryFacet.sol";
import {PayrollFacet} from "../../src/facets/PayrollFacet.sol";

/// @title SetupTreasury — SetupCore + the 2 treasury / payroll facets.
/// @notice Target tests: `TreasuryConvertAndPayroll` and similar narrow
///         treasury-only tests. Loan-related treasury behaviour stays under
///         `SetupLoans` / `SetupLifecycle`.
///
/// @dev Compile cost: 10 facet TYPE imports vs the old `SetupTest`'s 39.
abstract contract SetupTreasury is SetupCore {
    TreasuryFacet internal treasuryFacet;
    PayrollFacet internal payrollFacet;

    function setUp() public virtual override {
        super.setUp(); // SetupCore → TestBase

        treasuryFacet = new TreasuryFacet();
        payrollFacet = new PayrollFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(treasuryFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getTreasuryFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(payrollFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getPayrollFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }
}
