// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../../src/facets/RiskMatchLiquidationFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {EncumbranceMutateFacet} from "../../src/facets/EncumbranceMutateFacet.sol";
import {DefaultedFacet} from "../../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {MetricsFacet} from "../../src/facets/MetricsFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "../HelperTest.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";

/**
 * @title InvariantBase
 * @notice Shared deploy + mock ceremony for invariant / property test suites.
 *         Mirrors the Scenario1 setup (two liquid ERC-20s, mocked oracle,
 *         mocked HF/LTV), but exposes the deployed diamond + assets for use
 *         by a Handler or direct invariant assertions.
 *
 *         This is NOT an abstract base the invariant suites inherit as a
 *         Test — each suite instantiates it directly, keeps a reference, and
 *         adds its own `targetContract` bindings.
 */
contract InvariantBase is Test {
    VaipakamDiamond public diamond;
    address public owner;
    address public mockUsdc;
    address public mockWeth;

    HelperTest public helperTest;

    // Pre-funded actor pool — invariant suites pull from these rather than
    // spraying calls from `msg.sender` (which would churn vault creation
    // and leave most calls reverting on KYC / country checks).
    address[3] public lenders;
    address[3] public borrowers;

    uint256 public constant MINT_AMOUNT = 1_000_000 ether;

    function deploy() public {
        owner = address(this);

        mockUsdc = address(new ERC20Mock("MockUSDC", "USDC", 18));
        mockWeth = address(new ERC20Mock("MockWETH", "WETH", 18));

        for (uint256 i = 0; i < 3; i++) {
            lenders[i] = makeAddr(string.concat("lender", vm.toString(i)));
            borrowers[i] = makeAddr(string.concat("borrower", vm.toString(i)));
            ERC20Mock(mockUsdc).mint(lenders[i], MINT_AMOUNT);
            ERC20Mock(mockUsdc).mint(borrowers[i], MINT_AMOUNT);
            ERC20Mock(mockWeth).mint(lenders[i], MINT_AMOUNT);
            ERC20Mock(mockWeth).mint(borrowers[i], MINT_AMOUNT);
        }

        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));

        helperTest = new HelperTest();

        _cutAllFacets();

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(makeAddr("zeroEx"));
        AdminFacet(address(diamond)).setallowanceTarget(makeAddr("zeroExAllowance"));

        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        RiskFacet(address(diamond)).updateRiskParams(mockUsdc, 8000, 300, 1000);
        RiskFacet(address(diamond)).updateRiskParams(mockWeth, 8000, 300, 1000);

        _mockOracle();

        for (uint256 i = 0; i < 3; i++) {
            _onboardActor(lenders[i]);
            _onboardActor(borrowers[i]);
        }
    }

    function _cutAllFacets() internal {
        OfferCreateFacet offerCreateFacet = new OfferCreateFacet();
        OfferAcceptFacet offerAcceptFacet = new OfferAcceptFacet();
        OfferCancelFacet offerCancelFacet = new OfferCancelFacet();
        ProfileFacet profileFacet = new ProfileFacet();
        OracleFacet oracleFacet = new OracleFacet();
        VaipakamNFTFacet nftFacet = new VaipakamNFTFacet();
        VaultFactoryFacet vaultFacet = new VaultFactoryFacet();
        LoanFacet loanFacet = new LoanFacet();
        RiskFacet riskFacet = new RiskFacet();
        RepayFacet repayFacet = new RepayFacet();
        DefaultedFacet defaultFacet = new DefaultedFacet();
        AdminFacet adminFacet = new AdminFacet();
        ClaimFacet claimFacet = new ClaimFacet();
        AddCollateralFacet addCollateralFacet = new AddCollateralFacet();
        AccessControlFacet accessControlFacet = new AccessControlFacet();
        TestMutatorFacet mutatorFacet = new TestMutatorFacet();
        MetricsFacet metricsFacet = new MetricsFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](19);
        cuts[0] = IDiamondCut.FacetCut({facetAddress: address(offerCreateFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCreateFacetSelectors()});
        cuts[17] = IDiamondCut.FacetCut({
            facetAddress: address(offerAcceptFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferAcceptFacetSelectors()
        });
        // OfferCancelFacet — cancelOffer + read views, carved out for
        // the EIP-170 split. Same selectors land on the diamond.
        cuts[1] = IDiamondCut.FacetCut({facetAddress: address(profileFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getProfileFacetSelectors()});
        cuts[2] = IDiamondCut.FacetCut({facetAddress: address(oracleFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOracleFacetSelectors()});
        cuts[3] = IDiamondCut.FacetCut({facetAddress: address(nftFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaipakamNFTFacetSelectors()});
        cuts[4] = IDiamondCut.FacetCut({facetAddress: address(vaultFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaultFactoryFacetSelectors()});
        cuts[5] = IDiamondCut.FacetCut({facetAddress: address(loanFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getLoanFacetSelectors()});
        cuts[6] = IDiamondCut.FacetCut({facetAddress: address(riskFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskFacetSelectors()});
        cuts[7] = IDiamondCut.FacetCut({facetAddress: address(repayFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRepayFacetSelectors()});
        cuts[8] = IDiamondCut.FacetCut({facetAddress: address(adminFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAdminFacetSelectors()});
        cuts[9] = IDiamondCut.FacetCut({facetAddress: address(defaultFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getDefaultedFacetSelectors()});
        cuts[10] = IDiamondCut.FacetCut({facetAddress: address(claimFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getClaimFacetSelectors()});
        cuts[11] = IDiamondCut.FacetCut({facetAddress: address(addCollateralFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAddCollateralFacetSelectors()});
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(accessControlFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAccessControlFacetSelectors()});
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(mutatorFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getTestMutatorFacetSelectors()});
        cuts[14] = IDiamondCut.FacetCut({facetAddress: address(metricsFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getMetricsFacetSelectors()});
        cuts[15] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});

        cuts[16] = IDiamondCut.FacetCut({facetAddress: address(new RiskMatchLiquidationFacet()), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()});
        // #407 PR 4 (T-407-B, 2026-06-12) — encumbrance mutate facet,
        // required so the loan-lifecycle terminals' cross-facet release
        // call (e.g. {RepayFacet.repayLoan}) resolves on the invariant
        // suite's minimal diamond cut.
        cuts[18] = IDiamondCut.FacetCut({
            facetAddress: address(new EncumbranceMutateFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getEncumbranceMutateFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    function _mockOracle() internal {
        _mockLiquidity(mockUsdc, LibVaipakam.LiquidityStatus.Liquid);
        _mockLiquidity(mockWeth, LibVaipakam.LiquidityStatus.Liquid);
        _mockPrice(mockUsdc, 1e8, 8);
        _mockPrice(mockWeth, 2000e8, 8);

        // HF 2.0, LTV 50% — comfortably above MIN_HEALTH_FACTOR and max LTV
        // so acceptOffer / initiateLoan succeed without reverts.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(2e18))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(5000))
        );
    }

    function _mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset),
            abi.encode(status)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidityOnActiveNetwork.selector, asset),
            abi.encode(status)
        );
    }

    function _mockPrice(address asset, uint256 price, uint8 decs) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encode(price, decs)
        );
    }

    function _onboardActor(address user) internal {
        vm.prank(user);
        ProfileFacet(address(diamond)).setUserCountry("US");
        ProfileFacet(address(diamond)).updateKYCTier(user, LibVaipakam.KYCTier.Tier2);

        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user);
        vm.startPrank(user);
        ERC20(mockUsdc).approve(address(diamond), type(uint256).max);
        ERC20(mockWeth).approve(address(diamond), type(uint256).max);
        ERC20(mockUsdc).approve(vault, type(uint256).max);
        ERC20(mockWeth).approve(vault, type(uint256).max);
        vm.stopPrank();
    }

    // ─── Helpers available to invariant suites ─────────────────────────

    function lenderAt(uint256 i) external view returns (address) {
        return lenders[i % 3];
    }

    function borrowerAt(uint256 i) external view returns (address) {
        return borrowers[i % 3];
    }
}
