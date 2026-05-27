// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupOffers} from "./SetupOffers.t.sol";

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../../src/facets/RiskMatchLiquidationFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {DefaultedFacet} from "../../src/facets/DefaultedFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";

/// @title SetupLoans — SetupOffers + the 8 loan-flow facets.
/// @notice Adds Loan, position-NFT, Risk, RiskMatchLiquidation, Repay,
///         AddCollateral, Defaulted, and Claim on top of the Offer surface.
///         Target tests: `LoanFacetTest`, `RiskFacetTest`, `RepayFacetTest`,
///         `DefaultedFacetTest`, `ClaimFacetTest`, `AddCollateralTest`.
///
/// @dev Compile cost: 21 facet TYPE imports vs the old `SetupTest`'s 39.
abstract contract SetupLoans is SetupOffers {
    LoanFacet internal loanFacet;
    VaipakamNFTFacet internal nftFacet;
    RiskFacet internal riskFacet;
    RiskMatchLiquidationFacet internal riskMatchLiquidationFacet;
    RepayFacet internal repayFacet;
    AddCollateralFacet internal addCollateralFacet;
    DefaultedFacet internal defaultFacet;
    ClaimFacet internal claimFacet;

    function setUp() public virtual override {
        super.setUp(); // SetupOffers → SetupCore → TestBase

        loanFacet = new LoanFacet();
        nftFacet = new VaipakamNFTFacet();
        riskFacet = new RiskFacet();
        riskMatchLiquidationFacet = new RiskMatchLiquidationFacet();
        repayFacet = new RepayFacet();
        addCollateralFacet = new AddCollateralFacet();
        defaultFacet = new DefaultedFacet();
        claimFacet = new ClaimFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](8);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(loanFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getLoanFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(nftFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaipakamNFTFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(riskFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRiskFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(riskMatchLiquidationFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(repayFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRepayFacetSelectors()
        });
        cuts[5] = IDiamondCut.FacetCut({
            facetAddress: address(addCollateralFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAddCollateralFacetSelectors()
        });
        cuts[6] = IDiamondCut.FacetCut({
            facetAddress: address(defaultFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getDefaultedFacetSelectors()
        });
        cuts[7] = IDiamondCut.FacetCut({
            facetAddress: address(claimFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getClaimFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }
}
