// test/PartialWithdrawalFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibTestCollateralCut} from "./helpers/LibTestCollateralCut.sol";
import {LibTestTermsCut} from "./helpers/LibTestTermsCut.sol";
import {LibTestProtectedCut} from "./helpers/LibTestProtectedCut.sol";
import {LibTestProtection} from "./helpers/LibTestProtection.sol";
import {VaultOutflowTypes} from "../src/vault/VaultOutflowTypes.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {LibPositionNFT} from "../src/libraries/LibPositionNFT.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {Test} from "forge-std/Test.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VaultPayoutFacet} from "../src/facets/VaultPayoutFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultOutflowFacet} from "../src/facets/VaultOutflowFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {FeeEntitlementFacet} from "../src/facets/FeeEntitlementFacet.sol";
import {OfferAcceptFeeFacet} from "../src/facets/OfferAcceptFeeFacet.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {FallbackCustodyFacet} from "../src/facets/FallbackCustodyFacet.sol";
import {SwapAttemptFacet} from "../src/facets/SwapAttemptFacet.sol";
import {TreasuryFeeFacet} from "../src/facets/TreasuryFeeFacet.sol";
import {NumeraireValueFacet} from "../src/facets/NumeraireValueFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferBookFacet} from "../src/facets/OfferBookFacet.sol";
import {TestOfferFloor} from "./helpers/TestOfferFloor.sol";
import {HelperTest} from "./HelperTest.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockVaultWithdraw, VaultOutflowStubFailure} from "./helpers/MockVaultWithdraw.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";

/**
 * @title PartialWithdrawalFacetTest
 * @notice Tests PartialWithdrawalFacet: partialWithdrawCollateral and calculateMaxWithdrawable.
 */
contract PartialWithdrawalFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    uint256 borrowerPk;
    address mockERC20;
    address mockCollateralERC20;
    address mockZeroExProxy;

    DiamondCutFacet cutFacet;
    OfferCreateFacet offerCreateFacet;
    OfferAcceptFacet offerAcceptFacet;
    OfferCancelFacet offerCancelFacet;
    ProfileFacet profileFacet;
    OracleFacet oracleFacet;
    VaipakamNFTFacet nftFacet;
    VaultFactoryFacet vaultFacet;
    LoanFacet loanFacet;
    RiskFacet riskFacet;
    RepayFacet repayFacet;
    DefaultedFacet defaultFacet;
    AdminFacet adminFacet;
    ClaimFacet claimFacet;
    AddCollateralFacet addCollateralFacet;
    PartialWithdrawalFacet partialFacet;
    AccessControlFacet accessControlFacet;
    TestMutatorFacet testMutatorFacet;
    HelperTest helperTest;

    uint256 activeLoanId;
    uint256 constant PRINCIPAL   = 1000 ether;
    uint256 constant COLLATERAL  = 1800 ether;

    function mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset), abi.encode(status));
    }
    function mockPrice(address asset, uint256 price, uint8 dec) internal {
        vm.mockCall(LibTestPriceGuard.guardOf(address(diamond)), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset), abi.encode(price, dec));
    }

    function setUp() public {
        owner = address(this);
        lender = makeAddr("lender");
        (borrower, borrowerPk) = makeAddrAndKey("borrower");

        mockERC20 = address(new ERC20Mock("Token", "TKN", 18));
        mockCollateralERC20 = address(new ERC20Mock("MockCollateral", "MCK", 18));
        mockZeroExProxy = makeAddr("zeroEx");

        ERC20Mock(mockERC20).mint(lender, 100000 ether);
        ERC20Mock(mockERC20).mint(borrower, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(lender, 100000 ether);
        ERC20Mock(mockCollateralERC20).mint(borrower, 100000 ether);

        cutFacet = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond  = new VaipakamDiamond(owner, address(cutFacet));
        offerCreateFacet = OfferCreateFacet(ArtifactDeploy.deploy(type(OfferCreateFacet).name));
        offerAcceptFacet = OfferAcceptFacet(ArtifactDeploy.deploy(type(OfferAcceptFacet).name));
        offerCancelFacet = OfferCancelFacet(ArtifactDeploy.deploy(type(OfferCancelFacet).name));
        profileFacet = ProfileFacet(ArtifactDeploy.deploy(type(ProfileFacet).name));
        oracleFacet = OracleFacet(ArtifactDeploy.deploy(type(OracleFacet).name));
        nftFacet = VaipakamNFTFacet(ArtifactDeploy.deploy(type(VaipakamNFTFacet).name));
        vaultFacet = VaultFactoryFacet(ArtifactDeploy.deploy(type(VaultFactoryFacet).name));
        loanFacet = LoanFacet(ArtifactDeploy.deploy(type(LoanFacet).name));
        riskFacet = RiskFacet(ArtifactDeploy.deploy(type(RiskFacet).name));
        repayFacet = RepayFacet(ArtifactDeploy.deploy(type(RepayFacet).name));
        defaultFacet = DefaultedFacet(ArtifactDeploy.deploy(type(DefaultedFacet).name));
        adminFacet = AdminFacet(ArtifactDeploy.deploy(type(AdminFacet).name));
        claimFacet = ClaimFacet(ArtifactDeploy.deploy(type(ClaimFacet).name));
        addCollateralFacet = AddCollateralFacet(ArtifactDeploy.deploy(type(AddCollateralFacet).name));
        partialFacet = PartialWithdrawalFacet(ArtifactDeploy.deploy(type(PartialWithdrawalFacet).name));
        accessControlFacet = AccessControlFacet(ArtifactDeploy.deploy(type(AccessControlFacet).name));
        testMutatorFacet = new TestMutatorFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](28);
        cuts[0]  = IDiamondCut.FacetCut({facetAddress: address(offerCreateFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCreateFacetSelectors()});
        cuts[17] = IDiamondCut.FacetCut({
            facetAddress: address(offerAcceptFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferAcceptFacetSelectors()
        });
        // #1835 — the borrower-LIF charge `_acceptOffer` self-calls, split off
        // OfferAcceptFacet for EIP-170 headroom. Same selector, its own host:
        // cut it or every ERC-20 accept reverts FunctionDoesNotExist at the
        // self-call, with the accept facet itself looking perfectly fine.
        cuts[19] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(OfferAcceptFeeFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferAcceptFeeFacetSelectors()
        });
        cuts[1]  = IDiamondCut.FacetCut({facetAddress: address(profileFacet),       action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getProfileFacetSelectors()});
        cuts[2]  = IDiamondCut.FacetCut({facetAddress: address(oracleFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOracleFacetSelectors()});
        cuts[3]  = IDiamondCut.FacetCut({facetAddress: address(nftFacet),           action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaipakamNFTFacetSelectors()});
        cuts[4]  = IDiamondCut.FacetCut({facetAddress: address(vaultFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaultFactoryFacetSelectors()});
        cuts[5]  = IDiamondCut.FacetCut({facetAddress: address(loanFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getLoanFacetSelectors()});
        cuts[6]  = IDiamondCut.FacetCut({facetAddress: address(riskFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskFacetSelectors()});
        cuts[7]  = IDiamondCut.FacetCut({facetAddress: address(repayFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRepayFacetSelectors()});
        cuts[8]  = IDiamondCut.FacetCut({facetAddress: address(adminFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAdminFacetSelectors()});
        cuts[9]  = IDiamondCut.FacetCut({facetAddress: address(defaultFacet),       action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getDefaultedFacetSelectors()});
        cuts[10] = IDiamondCut.FacetCut({facetAddress: address(claimFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getClaimFacetSelectors()});
        cuts[11] = IDiamondCut.FacetCut({facetAddress: address(addCollateralFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAddCollateralFacetSelectors()});
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(partialFacet),       action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getPartialWithdrawalFacetSelectors()});
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(accessControlFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAccessControlFacetSelectors()});
        cuts[14] = IDiamondCut.FacetCut({facetAddress: address(testMutatorFacet),   action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getTestMutatorFacetSelectors()});
        cuts[15] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});
        cuts[16] = IDiamondCut.FacetCut({facetAddress: ArtifactDeploy.deploy(type(RiskMatchLiquidationFacet).name), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()});
        // #569 (2026-06-13) — encumbrance mutate facet for lien wires.
        cuts[18] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(EncumbranceMutateFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getEncumbranceMutateFacetSelectors()
        });

        // #1566 S2a - RiskFacet, DefaultedFacet and ClaimFacet reach the
        // fallback custody flows (entry, retry swap, in-kind distribution)
        // through a Diamond self-call into FallbackCustodyFacet, the one host
        // of those flows. A hand-built Diamond that cuts any of the three must
        // cut this host too, or a failed-swap liquidation or default and the
        // fallback claim revert FunctionDoesNotExist at that self-call.
        cuts[20] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(FallbackCustodyFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getFallbackCustodyFacetSelectors()
        });
        // #2472 - every failover seller (Risk, Defaulted, RepayPeriodic,
        // Treasury, SwapToRepay, FallbackCustody) runs each swap attempt by a
        // self-call into SwapAttemptFacet. A hand-built Diamond that cuts any
        // of them must cut this host too, or every attempt is refused
        // SwapAttemptHostMissing.
        cuts[21] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(SwapAttemptFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getSwapAttemptFacetSelectors()
        });
        // #2440 - every fee-charging facet (Repay, Preclose, Refinance,
        // EarlyWithdrawal, Defaulted, RepayPeriodic, OfferAcceptFee) moves a
        // fee into the treasury by a self-call into TreasuryFeeFacet. A
        // hand-built Diamond that cuts any of them must cut this host too, or
        // the fee reverts FunctionDoesNotExist at that self-call.
        cuts[22] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(TreasuryFeeFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getTreasuryFeeFacetSelectors()
        });
        // #2419 - RiskFacet (LTV / HF) and the offer facets value every amount
        // through NumeraireValueFacet by self-call, so a hand-built Diamond
        // that cuts any of them must cut this host too.
        cuts[23] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(NumeraireValueFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getNumeraireValueFacetSelectors()
        });
        // #3009 - offer creation and mutation admit a periodic-interest
        // cadence through a self-call to OfferPreviewFacet's one copy of the
        // rule, so a hand-built Diamond that cuts OfferCreateFacet must cut it.
        cuts[24] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(OfferPreviewFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferPreviewFacetSelectors()
        });
        // #3242 — every creation enters the book through OfferBookFacet.
        cuts[25] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(OfferBookFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferBookFacetSelectors()
        });

        // #3360 - every ERC-20 accept stamps the loan's fee-entitlement record
        // (its loan-side reward cap) through a self-call to FeeEntitlementFacet.
        cuts[26] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(FeeEntitlementFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getFeeEntitlementFacetSelectors()
        });
        // #3562 — every lender token's holder is recorded by the accumulator
        // facet, so a Diamond that mints position NFTs must route it.
        cuts[27] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(VPFIDiscountAccumulatorFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVpfiDiscountAccumulatorFacetSelectors()
        });
        cuts = LibTestCollateralCut.withCollateralHosts(cuts); // #3685
        cuts = LibTestTermsCut.withTermsHost(cuts); // #3734
        IDiamondCut(address(diamond)).diamondCut(LibTestProtectedCut.withProtected(cuts), address(0), "");
        // #3242 — wei-sized offers below the $10 floor; see {TestOfferFloor}.
        TestOfferFloor.lower(address(diamond));

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();
        LibTestVaultBeacon.install(address(diamond), address(this));
        LibTestPositionNFT.install(address(diamond), address(this));
        LibTestVaultBeacon.setTreasury(address(diamond), address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(mockZeroExProxy);
        AdminFacet(address(diamond)).setallowanceTarget(mockZeroExProxy);

        vm.prank(lender);   ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower); ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);   ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower); ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);

        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);
        vm.prank(lender);   ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower); ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);

        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockERC20, 8000, 300);
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 300);
        TestMutatorFacet(address(diamond)).setTierLiquidationLtvBpsAllRaw(8500, 8500, 8500);

        mockLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockERC20, 1e8, 8);
        mockLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(mockCollateralERC20, 1e8, 8);

        address lenderVault  = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.prank(lender);   ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        vm.prank(borrower); ERC20(mockERC20).approve(borrowerVault, type(uint256).max);
        vm.prank(lender);   ERC20(mockCollateralERC20).approve(lenderVault, type(uint256).max);
        vm.prank(borrower); ERC20(mockCollateralERC20).approve(borrowerVault, type(uint256).max);

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
        activeLoanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);
    }

    // ─── partialWithdrawCollateral reverts ───────────────────────────────────

    function testPartialWithdrawRevertsNotNFTOwner() public {
        // #569 round-10 P1 — partialWithdrawCollateral now authorizes the
        // current borrower-position NFT holder (not the stored
        // `loan.borrower`), so a non-holder caller reverts NotNFTOwner.
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 100 ether);
    }

    function testPartialWithdrawRevertsLoanNotActive() public {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        loan.status = LibVaipakam.LoanStatus.Repaid;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.LoanNotActive.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 100 ether);
        // Restore status to Active
        loan.status = LibVaipakam.LoanStatus.Active;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);
    }

    function testPartialWithdrawRevertsAmountTooHigh() public {
        vm.prank(borrower);
        vm.expectRevert(PartialWithdrawalFacet.AmountTooHigh.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, COLLATERAL + 1);
    }

    /// @dev #951 (Codex #959 round-5) — a live lender-sale listing freezes the
    ///      position's collateral: `partialWithdrawCollateral` reverts
    ///      `SaleListingActive` so a pending buyer can't be handed a loan whose
    ///      collateral was silently drained after the listing was posted.
    function testPartialWithdrawBlockedWhileSaleListed() public {
        TestMutatorFacet(address(diamond)).setLoanToSaleOfferIdRaw(activeLoanId, 42);
        vm.prank(borrower);
        vm.expectRevert(PartialWithdrawalFacet.SaleListingActive.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 1);
        // Clearing the listing re-enables the withdraw path (state hygiene).
        TestMutatorFacet(address(diamond)).setLoanToSaleOfferIdRaw(activeLoanId, 0);
    }

    function testPartialWithdrawRevertsAmountZero() public {
        vm.prank(borrower);
        vm.expectRevert(PartialWithdrawalFacet.AmountTooHigh.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 0);
    }

    function testPartialWithdrawRevertsIlliquidAsset() public {
        // Override liquidity to Illiquid
        mockLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Illiquid);

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.IlliquidAsset.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 100 ether);
    }

    function testPartialWithdrawRevertsHealthFactorTooLow() public {
        // Withdraw nearly all collateral → HF too low
        // 1800 - 1700 = 100 ether remaining collateral; HF = 100 * 0.85 / 1000 = 0.085 < 1.5
        MockVaultWithdraw.deliversAll(address(diamond));

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.HealthFactorTooLow.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 1700 ether);
    }

    // ─── partialWithdrawCollateral success ───────────────────────────────────

    function testPartialWithdrawSuccess() public {
        // Withdraw small amount so HF stays above 1.5
        // After withdrawal: collateral = 1800 - 100 = 1700; HF = 1700 * 0.85 / 1000 = 1.445... < 1.5
        // Need to be more careful. Let's try 200 ether withdrawal:
        // After: 1800 - 200 = 1600; HF = 1600 * 0.85 / 1000 = 1.36 < 1.5. Still too low.
        // Let's try 100 ether: 1800 - 100 = 1700; still < 1.5.
        // With PRINCIPAL=1000, COLLATERAL=1800, price $1 each, liqThreshold=8500 bps:
        // HF = (collateral * 0.85) / principal
        // For HF >= 1.5: collateral * 0.85 >= 1500 → collateral >= 1765
        // Max withdrawal: 1800 - 1765 = 35 ether
        MockVaultWithdraw.deliversAll(address(diamond));

        vm.expectEmit(true, true, false, false);
        // (loanId, borrower, amount, newCollateralAmount, newHf, newLtv) —
        // data=false in expectEmit, so the non-indexed args are placeholders.
        emit PartialWithdrawalFacet.PartialCollateralWithdrawn(activeLoanId, borrower, 30 ether, 0, 0, 0);
        vm.prank(borrower);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(loan.collateralAmount, COLLATERAL - 30 ether);
    }

    // ─── calculateMaxWithdrawable ─────────────────────────────────────────────

    function testCalculateMaxWithdrawableReturnsZeroInactiveLoan() public view {
        assertEq(PartialWithdrawalFacet(address(diamond)).calculateMaxWithdrawable(999), 0);
    }

    function testCalculateMaxWithdrawableReturnsZeroIlliquid() public {
        mockLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Illiquid);
        assertEq(PartialWithdrawalFacet(address(diamond)).calculateMaxWithdrawable(activeLoanId), 0);
    }

    function testCalculateMaxWithdrawableReturnsPositive() public {
        uint256 maxAmount = PartialWithdrawalFacet(address(diamond)).calculateMaxWithdrawable(activeLoanId);
        // With 1800 collateral, 1000 principal, price $1, liqThreshold 8500 bps:
        // HF = (col * 0.85) / 1000 >= 1.5 → col >= 1765
        // max withdrawal = 1800 - 1765 = 35
        assertGt(maxAmount, 0);
        assertLe(maxAmount, 36 ether);
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Covers LTVExceeded branch in partialWithdrawCollateral.
    ///      Set a low loanInitMaxLtvBps via updateRiskParams so post-withdrawal LTV exceeds it.
    function testPartialWithdrawRevertsLTVExceeded() public {
        // Set risk params: loanInitMaxLtvBps=1000 (10% — the new T-033 floor;
        // previously used 100 (1%) but the audit floor rejects that
        // as a degenerate setting). liqThresholdBps must be > maxLtv
        // and ≥ the 1500-floor; liqBonus unchanged.
        // With principal=1000, collateral_after=1770:
        //   LTV ≈ 56.5% > loanInitMaxLtvBps=10% → LTVExceeded still triggers.
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 1000, 300);

        // Set principal = 1000 ether; collateral = 1800 ether via mutator.
        // After withdrawal of 30: LTV = 1000/1770 * 10000 ≈ 5650 → LTVExceeded.
        // #394 Lever A (Codex #647 round-3 P1) — the withdrawal LTV gate now
        // enforces the loan's SNAPSHOTTED admission init-LTV cap
        // (`initLtvCapBpsAtInit`), not the live per-asset `loanInitMaxLtvBps`
        // (so a governance retune can't retroactively re-gate an open loan).
        // Snapshot a 10% cap onto the loan to exercise the gate; the
        // `updateRiskParams(1000)` above keeps the live + snapshot consistent.
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        loan.principal = 1000 ether;
        loan.collateralAmount = 1800 ether;
        loan.initLtvCapBpsAtInit = 1000;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);

        MockVaultWithdraw.deliversAll(address(diamond));

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.LTVExceeded.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);
        vm.clearMockedCalls();

        // Restore risk params
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 300);
        TestMutatorFacet(address(diamond)).setTierLiquidationLtvBpsAllRaw(8500, 8500, 8500);
    }

    /// @dev Covers CrossFacetCallFailed("Withdraw failed") in partialWithdrawCollateral
    function testPartialWithdrawCrossFacetFails() public {
        MockVaultWithdraw.fails(address(diamond), VaultOutflowTypes.AssetKind.ERC20);

        vm.expectRevert(abi.encodeWithSelector(VaultOutflowStubFailure.selector, uint8(0)));
        vm.prank(borrower);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);
        vm.clearMockedCalls();
    }

    /// @dev Covers calculateMaxWithdrawable returns 0 when collateralAmount == 0
    function testCalculateMaxWithdrawableReturnsZeroWhenNoCollateral() public {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        loan.collateralAmount = 0;
        TestMutatorFacet(address(diamond)).setLoan(activeLoanId, loan);

        assertEq(PartialWithdrawalFacet(address(diamond)).calculateMaxWithdrawable(activeLoanId), 0);
    }

    // ─── #394 Lever A (Codex #647 P1) — admission-floor snapshot ──────────────

    /// @dev An open loan keeps the admission HF floor it was created under for
    ///      every post-admission withdrawal — a later governance retune of the
    ///      live floor is PROSPECTIVE only and must NOT retroactively move an
    ///      open position's buffer. The loan here was admitted at the default
    ///      1.5e18; raising the live floor to 1.8e18 must not block a 30-ether
    ///      withdrawal that leaves HF ≈ 1.5045 (clears the 1.5 snapshot, would
    ///      fail the 1.8 live floor). If the gate read the live knob this would
    ///      revert HealthFactorTooLow.
    function testPartialWithdraw_usesAdmissionFloorSnapshot_notLiveKnob() public {
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(activeLoanId).minHealthFactorAtInit,
            uint64(150 * 1e16),
            "admission floor snapshotted at 1.5e18"
        );

        // Governance raises the GLOBAL admission floor (applies to NEW loans).
        RiskFacet(address(diamond)).setMinHealthFactor(180 * 1e16); // 1.8e18

        MockVaultWithdraw.deliversAll(address(diamond));
        vm.prank(borrower);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);

        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(activeLoanId).collateralAmount,
            COLLATERAL - 30 ether,
            "withdrawal honored under the 1.5 snapshot despite the raised 1.8 live floor"
        );
    }

    // ─── #3413 transfer cooldown after a value-out ───────────────────────

    /// @dev Transfer `tokenId` from its holder, expecting `revertData` (empty
    ///      for success). Holder read first, so the expectation and the prank
    ///      land on the transfer itself.
    function _tryMove(uint256 tokenId, bytes memory revertData) internal {
        PositionNFT nft = LibTestPositionNFT.core(address(diamond));
        address holder = nft.ownerOf(tokenId);
        address buyer = makeAddr("buyer");
        if (revertData.length != 0) vm.expectRevert(revertData);
        vm.prank(holder);
        nft.transferFrom(holder, buyer, tokenId);
    }

    /// @dev The borrower withdraws: its own move for itself, so its token
    ///      takes the long wait; the lender's token the short one.
    function _withdrawSome() internal returns (uint64 atBlock, uint64 borrowerReady, uint64 lenderReady) {
        // The real outflow policy runs: it is the seam that gives the
        // holder's own move its long wait.
        vm.prank(borrower);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);
        atBlock = uint64(block.number);
        borrowerReady = uint64(block.timestamp) + 900;
        lenderReady = uint64(block.timestamp) + 60;
    }

    /// @dev A direct accept turns the offer's own token into the loan's
    ///      token, and the borrower side took its principal: the new loan's
    ///      tokens wait from its start, then both sides move freely.
    function testCooldown_ANewLoanCoolsDownFromItsStartThenMoves() public {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        (uint256 n, uint64 b, uint64 r) = VaipakamNFTFacet(address(diamond)).positionState(loan.lenderTokenId);
        assertGt(b, 0, "the accept stamped the loan");
        assertGt(n, 0, "and moved the lender token's state number");
        (, uint64 b2, uint64 r2) = VaipakamNFTFacet(address(diamond)).positionState(loan.borrowerTokenId);
        uint64 last = b2 > b ? b2 : b;
        uint64 ready = r2 > r ? r2 : r;
        vm.roll(uint256(last) + 1);
        if (vm.getBlockTimestamp() < ready) vm.warp(ready);
        _tryMove(loan.lenderTokenId, "");
        _tryMove(loan.borrowerTokenId, "");
    }

    function testCooldown_WithdrawalHoldsBothSidesTheBorrowersLonger() public {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        (uint256 nB0,,) = VaipakamNFTFacet(address(diamond)).positionState(loan.borrowerTokenId);
        (uint256 nL0,,) = VaipakamNFTFacet(address(diamond)).positionState(loan.lenderTokenId);
        (uint64 atBlock, uint64 borrowerReady, uint64 lenderReady) = _withdrawSome();

        (uint256 nB, uint64 b, uint64 r) = VaipakamNFTFacet(address(diamond)).positionState(loan.borrowerTokenId);
        assertEq(b, atBlock, "stamped in this block");
        assertEq(r, borrowerReady, "the holder's own move: the 15-minute wait");
        assertGt(nB, nB0, "the borrower token's state number went up");
        (uint256 nL,, uint64 rL) = VaipakamNFTFacet(address(diamond)).positionState(loan.lenderTokenId);
        assertEq(rL, lenderReady, "the other side: the 60-second wait");
        assertGt(nL, nL0, "the lender token's state number went up");

        bytes memory borrowerErr = abi.encodeWithSelector(
            VaipakamNFTFacet.PositionCoolingDown.selector, loan.borrowerTokenId, atBlock, borrowerReady
        );
        bytes memory lenderErr = abi.encodeWithSelector(
            VaipakamNFTFacet.PositionCoolingDown.selector, loan.lenderTokenId, atBlock, lenderReady
        );
        // Same block: neither side moves, whatever the time.
        vm.warp(block.timestamp + 3600);
        _tryMove(loan.borrowerTokenId, borrowerErr);
        _tryMove(loan.lenderTokenId, lenderErr);

        // A later block at the short wait's end: the lender's moves, the
        // borrower's does not.
        vm.roll(block.number + 1);
        vm.warp(lenderReady);
        _tryMove(loan.lenderTokenId, "");
        _tryMove(loan.borrowerTokenId, borrowerErr);
        vm.warp(borrowerReady - 1);
        _tryMove(loan.borrowerTokenId, borrowerErr);
        vm.warp(borrowerReady);
        _tryMove(loan.borrowerTokenId, "");
    }

    /// @dev #3710 — a price is a price for one state number: the fill check
    ///      passes for the current number and refuses after a value-out.
    function testState_RequirePositionStateRefusesAfterAValueOut() public {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        (uint256 n,,) = VaipakamNFTFacet(address(diamond)).positionState(loan.borrowerTokenId);
        VaipakamNFTFacet(address(diamond)).requirePositionState(loan.borrowerTokenId, n);
        _withdrawSome();
        (uint256 n2,,) = VaipakamNFTFacet(address(diamond)).positionState(loan.borrowerTokenId);
        vm.expectRevert(
            abi.encodeWithSelector(LibPositionNFT.PositionStateChanged.selector, loan.borrowerTokenId, n, n2)
        );
        VaipakamNFTFacet(address(diamond)).requirePositionState(loan.borrowerTokenId, n);
        VaipakamNFTFacet(address(diamond)).requirePositionState(loan.borrowerTokenId, n2);
    }

    /// @dev #3710 — the withdrawal flags both tokens' metadata for refresh
    ///      (ERC-4906, from the core), and the core reports the interface.
    function testRefresh_WithdrawalEmitsMetadataUpdateForBothTokens() public {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        PositionNFT nft = LibTestPositionNFT.core(address(diamond));
        assertTrue(nft.supportsInterface(0x49064906), "ERC-4906 reported");
        vm.expectEmit(false, false, false, true, address(nft));
        emit PositionNFT.MetadataUpdate(loan.lenderTokenId);
        vm.expectEmit(false, false, false, true, address(nft));
        emit PositionNFT.MetadataUpdate(loan.borrowerTokenId);
        _withdrawSome();
    }

    /// @dev #3710 — the core's refresh entry is the Diamond's only.
    function testRefresh_OnlyTheDiamondMayAskTheCore() public {
        PositionNFT nft = LibTestPositionNFT.core(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.NotDiamond.selector, address(this)));
        nft.refreshMetadata(1, 2);
    }

    function testCooldown_AdminSetsItWithinBounds() public {
        (uint32 sec, uint32 minSec, uint32 maxSec) = VaipakamNFTFacet(address(diamond)).positionTransferCooldownSec();
        assertEq(sec, 60, "default");
        assertEq(minSec, 1);
        assertEq(maxSec, 600);

        vm.expectRevert(abi.encodeWithSelector(VaipakamNFTFacet.InvalidPositionTransferCooldown.selector, uint32(0)));
        VaipakamNFTFacet(address(diamond)).setPositionTransferCooldownSec(0);
        vm.expectRevert(abi.encodeWithSelector(VaipakamNFTFacet.InvalidPositionTransferCooldown.selector, uint32(601)));
        VaipakamNFTFacet(address(diamond)).setPositionTransferCooldownSec(601);

        vm.prank(lender);
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).setPositionTransferCooldownSec(30);

        vm.expectEmit(false, false, false, true, address(diamond));
        emit VaipakamNFTFacet.PositionTransferCooldownSet(30);
        VaipakamNFTFacet(address(diamond)).setPositionTransferCooldownSec(30);
        (sec,,) = VaipakamNFTFacet(address(diamond)).positionTransferCooldownSec();
        assertEq(sec, 30);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        // Past the loan's opening wait, which a shorter setting never cuts.
        vm.warp(block.timestamp + 120);
        vm.roll(block.number + 1);
        (uint64 atBlock,,) = _withdrawSome();
        (,, uint64 r) = VaipakamNFTFacet(address(diamond)).positionState(loan.lenderTokenId);
        assertEq(r, uint64(block.timestamp) + 30, "the set short wait applies to the other side");
        vm.roll(atBlock + 1);
        vm.warp(block.timestamp + 29);
        _tryMove(
            loan.lenderTokenId,
            abi.encodeWithSelector(VaipakamNFTFacet.PositionCoolingDown.selector, loan.lenderTokenId, atBlock, r)
        );
        vm.warp(r);
        _tryMove(loan.lenderTokenId, "");
    }

    function testOwnMoveWait_AdminSetsItWithinBounds() public {
        (uint32 sec, uint32 minSec, uint32 maxSec) = VaipakamNFTFacet(address(diamond)).positionOwnMoveWaitSec();
        assertEq(sec, 900, "default");
        assertEq(minSec, 60);
        assertEq(maxSec, 3600);
        vm.expectRevert(abi.encodeWithSelector(VaipakamNFTFacet.InvalidPositionOwnMoveWait.selector, uint32(59)));
        VaipakamNFTFacet(address(diamond)).setPositionOwnMoveWaitSec(59);
        vm.expectRevert(abi.encodeWithSelector(VaipakamNFTFacet.InvalidPositionOwnMoveWait.selector, uint32(3601)));
        VaipakamNFTFacet(address(diamond)).setPositionOwnMoveWaitSec(3601);
        vm.prank(lender);
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).setPositionOwnMoveWaitSec(120);
        vm.expectEmit(false, false, false, true, address(diamond));
        emit VaipakamNFTFacet.PositionOwnMoveWaitSet(120);
        VaipakamNFTFacet(address(diamond)).setPositionOwnMoveWaitSec(120);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        _withdrawSome();
        (,, uint64 r) = VaipakamNFTFacet(address(diamond)).positionState(loan.borrowerTokenId);
        assertEq(r, uint64(block.timestamp) + 120, "the set long wait applies to the holder's own token");
    }

    /// @dev The depository getter (VaultDepositoryFacet), read by the
    ///      #3710 release tests.
    function _cutDepository() internal {
        IDiamondCut.FacetCut[] memory c = new IDiamondCut.FacetCut[](1);
        c[0] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(VaultDepositoryFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaultDepositoryFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(c, address(0), "");
    }

    /// @dev #3710 (owner decision 2026-11-19) — the released collateral lands
    ///      in the borrower token holder's vault as free balance; nothing
    ///      reaches a wallet. The holder owns the paying vault, so nothing
    ///      moves: the lien drops and the amount becomes its own.
    function testVaultRelease_StaysInTheHoldersVaultAsFree() public {
        _cutDepository();
        address v = VaultFactoryFacet(address(diamond)).getUserVaultAddress(borrower);
        uint256 walletBefore = ERC20Mock(mockCollateralERC20).balanceOf(borrower);
        uint256 vaultBefore = ERC20Mock(mockCollateralERC20).balanceOf(v);
        uint256 freeBefore = VaultDepositoryFacet(address(diamond)).getDepositoryHolding(borrower, mockCollateralERC20, 0);
        vm.prank(borrower);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);
        assertEq(ERC20Mock(mockCollateralERC20).balanceOf(borrower), walletBefore, "nothing reached the wallet");
        assertEq(ERC20Mock(mockCollateralERC20).balanceOf(v), vaultBefore, "nothing left the vault");
        assertEq(
            VaultDepositoryFacet(address(diamond)).getDepositoryHolding(borrower, mockCollateralERC20, 0),
            freeBefore + 30 ether,
            "the released amount is the holder's free balance"
        );
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(loan.collateralAmount, COLLATERAL - 30 ether, "the loan's collateral fell");
    }

    /// @dev #3710 / #3568 — a protected holder's release is not a payout:
    ///      nothing is queued and nothing reaches the wallet; leaving the
    ///      vault later is its own withdrawal, under its delay.
    function testVaultRelease_ProtectedHolderIsNotQueued() public {
        IDiamondCut.FacetCut[] memory pay = new IDiamondCut.FacetCut[](1);
        pay[0] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(VaultPayoutFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaultPayoutFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(pay, address(0), "");
        LibTestProtection.enable(address(diamond), borrower, 2 days);
        uint256 before = ERC20Mock(mockCollateralERC20).balanceOf(borrower);
        vm.prank(borrower);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(activeLoanId, 30 ether);
        assertEq(ERC20Mock(mockCollateralERC20).balanceOf(borrower), before, "nothing reached the wallet");
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(loan.collateralAmount, COLLATERAL - 30 ether, "the loan's collateral fell");
        assertEq(VaultPayoutFacet(address(diamond)).getPendingPayoutIds(borrower).length, 0, "no payout queued");
    }

    // ─── #3710 — another holder is paid into its own vault ────────────────
    //
    // The withdrawal route consolidates a transferred side first, so its
    // payee is normally the paying vault's own owner. The other-holder branch
    // is driven here through the policy itself: the borrower token reads as
    // held by `newHolder`, and the borrower's vault holds free collateral.

    address internal newHolder = makeAddr("newHolder");

    function testVaultRelease_AnotherHolderIsPaidIntoItsVault() public {
        _cutDepository();
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(activeLoanId).borrowerTokenId;
        ERC20Mock(mockCollateralERC20).mint(borrower, 30 ether);
        vm.prank(borrower);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), 30 ether);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC20(borrower, mockCollateralERC20, 30 ether);
        LibTestPositionNFT.mockHolder(address(diamond), tokenId, newHolder);
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);

        (uint256 n0,,) = VaipakamNFTFacet(address(diamond)).positionState(tokenId);
        vm.prank(address(diamond));
        VaultOutflowFacet(address(diamond)).vaultOutflowArgs(
            borrower,
            uint8(VaultOutflowTypes.AssetKind.ERC20),
            mockCollateralERC20,
            0,
            30 ether,
            address(0),
            uint8(VaultOutflowTypes.OutflowClass.PositionHolder),
            activeLoanId,
            tokenId,
            19 // PARTIAL_WITHDRAWAL
        );
        (uint256 n1, uint64 b1, uint64 r1) = VaipakamNFTFacet(address(diamond)).positionState(tokenId);
        assertEq(n1, n0 + 1, "one value-out");
        assertEq(b1, uint64(block.number), "value left in this block");
        assertEq(r1, uint64(block.timestamp) + 60, "the short wait");
        address v = VaultFactoryFacet(address(diamond)).getUserVaultAddress(newHolder);
        assertEq(ERC20Mock(mockCollateralERC20).balanceOf(newHolder), 0, "nothing at the wallet");
        assertEq(ERC20Mock(mockCollateralERC20).balanceOf(v), 30 ether, "the whole amount in the holder's vault");
        assertEq(
            VaultDepositoryFacet(address(diamond)).getDepositoryHolding(newHolder, mockCollateralERC20, 0),
            30 ether,
            "as its free balance"
        );
    }
}
