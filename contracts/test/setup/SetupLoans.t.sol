// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupOffers} from "./SetupOffers.t.sol";

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
// VaipakamNFTFacet moved to SetupCore (Stage 2 reshape — broadly needed
// across families). Available via inherited `nftFacet` field.
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
    // nftFacet inherited from SetupCore (Stage 2 reshape).
    RiskFacet internal riskFacet;
    RiskMatchLiquidationFacet internal riskMatchLiquidationFacet;
    RepayFacet internal repayFacet;
    AddCollateralFacet internal addCollateralFacet;
    DefaultedFacet internal defaultFacet;
    ClaimFacet internal claimFacet;

    function setUp() public virtual override {
        super.setUp(); // SetupOffers → SetupCore → TestBase

        loanFacet = new LoanFacet();
        riskFacet = new RiskFacet();
        riskMatchLiquidationFacet = new RiskMatchLiquidationFacet();
        repayFacet = new RepayFacet();
        addCollateralFacet = new AddCollateralFacet();
        defaultFacet = new DefaultedFacet();
        claimFacet = new ClaimFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](7);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(loanFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getLoanFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(riskFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRiskFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(riskMatchLiquidationFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(repayFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRepayFacetSelectors()
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(addCollateralFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAddCollateralFacetSelectors()
        });
        cuts[5] = IDiamondCut.FacetCut({
            facetAddress: address(defaultFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getDefaultedFacetSelectors()
        });
        cuts[6] = IDiamondCut.FacetCut({
            facetAddress: address(claimFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getClaimFacetSelectors()
        });

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Loan-family runtime defaults — match the values the old
        // `SetupTest.setupHelper()` seeded so migrated tests find the
        // same risk-params state. 8000 BPS init-LTV, 300 BPS liq bonus,
        // 1000 BPS volatility threshold on both ERC20 legs.
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 300, 1000);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 300, 1000);

        // The old `SetupTest.setupHelper()` blanket-mocked RiskFacet's
        // HF + LTV calculations so most loan tests don't have to wire
        // realistic oracle scenarios to satisfy the loan-init gates.
        // Tests that exercise the real math (HealthFactorTest,
        // RiskFacetTest's HF-specific cases) call `vm.clearMockedCalls`
        // or selector-specific mocks in their own setUp.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(2e18)) // HF 2.0, well above 1.5 floor
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(6666)) // 66.66 %, well below 8000 BPS init cap
        );
    }
}
