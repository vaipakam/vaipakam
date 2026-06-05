// test/WorkflowComplianceAndRejection.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {HelperTest} from "./HelperTest.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract MockRentableNFT721Test is ERC721 {
    mapping(uint256 => address) private _users;
    mapping(uint256 => uint64) private _expires;

    constructor() ERC721("MockRentableNFT", "MRNFT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function setUser(uint256 tokenId, address user, uint64 expires_) external {
        _users[tokenId] = user;
        _expires[tokenId] = expires_;
    }

    function userOf(uint256 tokenId) external view returns (address) {
        if (_expires[tokenId] < block.timestamp) return address(0);
        return _users[tokenId];
    }

    function userExpires(uint256 tokenId) external view returns (uint256) {
        return _expires[tokenId];
    }
}

/**
 * @title WorkflowComplianceAndRejection
 * @notice Tests compliance (sanctions/KYC), ERC20-only rejection for NFT rentals,
 *         option 3 wait-to-maturity, and vault upgrade workflows.
 */
contract WorkflowComplianceAndRejection is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    address sanctionedUser;
    address newLender;

    ERC20Mock mockUsdc;
    ERC20Mock mockWeth;
    MockRentableNFT721Test mockNft;

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
    EarlyWithdrawalFacet earlyFacet;
    PrecloseFacet precloseFacet;
    RefinanceFacet refinanceFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    uint256 activeLoanId;
    uint256 nftLoanId;
    uint256 constant PRINCIPAL = 1000 ether;
    uint256 constant COLLATERAL = 1800 ether;

    function mockLiquidity(address asset, LibVaipakam.LiquidityStatus status) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset),
            abi.encode(status)
        );
    }

    function mockPrice(address asset, uint256 price, uint8 dec) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encode(price, dec)
        );
    }

    function setUp() public {
        owner = address(this);
        lender = makeAddr("lender");
        borrower = makeAddr("borrower");
        sanctionedUser = makeAddr("sanctionedUser");
        newLender = makeAddr("newLender");

        // Deploy mock tokens
        mockUsdc = new ERC20Mock("MockUSDC", "USDC", 18);
        mockWeth = new ERC20Mock("MockWETH", "WETH", 18);
        mockNft = new MockRentableNFT721Test();

        // Mint tokens to all actors
        mockUsdc.mint(lender, 100000 ether);
        mockUsdc.mint(borrower, 100000 ether);
        mockUsdc.mint(sanctionedUser, 100000 ether);
        mockUsdc.mint(newLender, 100000 ether);
        mockWeth.mint(lender, 100000 ether);
        mockWeth.mint(borrower, 100000 ether);
        mockWeth.mint(sanctionedUser, 100000 ether);
        mockWeth.mint(newLender, 100000 ether);

        // Deploy facets
        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        offerCreateFacet = new OfferCreateFacet();
        offerAcceptFacet = new OfferAcceptFacet();
        offerCancelFacet = new OfferCancelFacet();
        profileFacet = new ProfileFacet();
        oracleFacet = new OracleFacet();
        nftFacet = new VaipakamNFTFacet();
        vaultFacet = new VaultFactoryFacet();
        loanFacet = new LoanFacet();
        riskFacet = new RiskFacet();
        repayFacet = new RepayFacet();
        defaultFacet = new DefaultedFacet();
        adminFacet = new AdminFacet();
        claimFacet = new ClaimFacet();
        addCollateralFacet = new AddCollateralFacet();
        earlyFacet = new EarlyWithdrawalFacet();
        precloseFacet = new PrecloseFacet();
        refinanceFacet = new RefinanceFacet();
        accessControlFacet = new AccessControlFacet();
        TestMutatorFacet testMutatorFacet = new TestMutatorFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](20);
        cuts[0]  = IDiamondCut.FacetCut({facetAddress: address(offerCreateFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCreateFacetSelectors()});
        cuts[19] = IDiamondCut.FacetCut({
            facetAddress: address(offerAcceptFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferAcceptFacetSelectors()
        });
        cuts[1]  = IDiamondCut.FacetCut({facetAddress: address(profileFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getProfileFacetSelectors()});
        cuts[2]  = IDiamondCut.FacetCut({facetAddress: address(oracleFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOracleFacetSelectors()});
        cuts[3]  = IDiamondCut.FacetCut({facetAddress: address(nftFacet),            action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaipakamNFTFacetSelectors()});
        cuts[4]  = IDiamondCut.FacetCut({facetAddress: address(vaultFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaultFactoryFacetSelectors()});
        cuts[5]  = IDiamondCut.FacetCut({facetAddress: address(loanFacet),           action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getLoanFacetSelectors()});
        cuts[6]  = IDiamondCut.FacetCut({facetAddress: address(riskFacet),           action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskFacetSelectors()});
        cuts[7]  = IDiamondCut.FacetCut({facetAddress: address(repayFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRepayFacetSelectors()});
        cuts[8]  = IDiamondCut.FacetCut({facetAddress: address(adminFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAdminFacetSelectors()});
        cuts[9]  = IDiamondCut.FacetCut({facetAddress: address(defaultFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getDefaultedFacetSelectors()});
        cuts[10] = IDiamondCut.FacetCut({facetAddress: address(claimFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getClaimFacetSelectors()});
        cuts[11] = IDiamondCut.FacetCut({facetAddress: address(addCollateralFacet),  action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAddCollateralFacetSelectors()});
        cuts[12] = IDiamondCut.FacetCut({facetAddress: address(earlyFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getEarlyWithdrawalFacetSelectors()});
        cuts[13] = IDiamondCut.FacetCut({facetAddress: address(precloseFacet),       action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getPrecloseFacetSelectors()});
        cuts[14] = IDiamondCut.FacetCut({facetAddress: address(refinanceFacet),      action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRefinanceFacetSelectors()});
        cuts[15] = IDiamondCut.FacetCut({facetAddress: address(accessControlFacet),  action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getAccessControlFacetSelectors()});
        cuts[16] = IDiamondCut.FacetCut({facetAddress: address(testMutatorFacet),    action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getTestMutatorFacetSelectors()});
        cuts[17] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});
        cuts[18] = IDiamondCut.FacetCut({facetAddress: address(new RiskMatchLiquidationFacet()), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getRiskMatchLiquidationFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();

        // Initialize diamond services
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(makeAddr("zeroEx"));
        AdminFacet(address(diamond)).setallowanceTarget(makeAddr("zeroEx"));

        // Approvals for diamond
        vm.prank(lender);    ERC20(address(mockUsdc)).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);  ERC20(address(mockUsdc)).approve(address(diamond), type(uint256).max);
        vm.prank(sanctionedUser); ERC20(address(mockUsdc)).approve(address(diamond), type(uint256).max);
        vm.prank(newLender); ERC20(address(mockUsdc)).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);  ERC20(address(mockWeth)).approve(address(diamond), type(uint256).max);
        vm.prank(sanctionedUser); ERC20(address(mockWeth)).approve(address(diamond), type(uint256).max);
        vm.prank(newLender); ERC20(address(mockWeth)).approve(address(diamond), type(uint256).max);

        // Trade allowances: US<->US = true, NO US<->IR allowance (default false)
        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "US", true);

        // Set user countries
        vm.prank(lender);          ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(borrower);        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(newLender);       ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(sanctionedUser);  ProfileFacet(address(diamond)).setUserCountry("IR");

        // KYC: Tier2 for lender, borrower, newLender. sanctionedUser gets Tier2 too (to isolate sanctions testing)
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(newLender, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(sanctionedUser, LibVaipakam.KYCTier.Tier2);

        // Risk params for mockUsdc
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(address(mockUsdc), 8000, 300, 1000);
        // Risk params for mockWeth (used as distinct collateral asset after SelfCollateralizedOffer invariant)
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(address(mockWeth), 8000, 300, 1000);

        // Mock oracle: mockUsdc = Liquid, $1 price
        mockLiquidity(address(mockUsdc), LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(address(mockUsdc), 1e8, 8);
        // mockWeth = Liquid, $1 price (for simplicity)
        mockLiquidity(address(mockWeth), LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(address(mockWeth), 1e8, 8);
        // mockNft = Illiquid
        mockLiquidity(address(mockNft), LibVaipakam.LiquidityStatus.Illiquid);

        // Mock HF and LTV for loan initiation
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(2e18)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(6666)
        );

        // Create vaults and approve them
        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        address sanctionedVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(sanctionedUser);
        address newLenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(newLender);

        vm.prank(lender);    ERC20(address(mockUsdc)).approve(lenderVault, type(uint256).max);
        vm.prank(borrower);  ERC20(address(mockUsdc)).approve(borrowerVault, type(uint256).max);
        vm.prank(sanctionedUser); ERC20(address(mockUsdc)).approve(sanctionedVault, type(uint256).max);
        vm.prank(newLender); ERC20(address(mockUsdc)).approve(newLenderVault, type(uint256).max);
        vm.prank(borrower);  ERC20(address(mockWeth)).approve(borrowerVault, type(uint256).max);
        vm.prank(sanctionedUser); ERC20(address(mockWeth)).approve(sanctionedVault, type(uint256).max);
        vm.prank(newLender); ERC20(address(mockWeth)).approve(newLenderVault, type(uint256).max);

        // Mint tokens to diamond for internal transfers
        mockUsdc.mint(address(diamond), 100000 ether);

        // ── Create active ERC20 loan (lender creates offer, borrower accepts) ──
        vm.prank(lender);
        uint256 erc20OfferId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUsdc),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWeth),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(mockUsdc),
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
                fillMode: LibVaipakam.FillMode.Partial
            })
        );
        vm.prank(borrower);
        activeLoanId = OfferAcceptFacet(address(diamond)).acceptOffer(erc20OfferId, true);

        // ── Create active NFT rental loan ──
        // Mint NFT to lender, approve to diamond
        mockNft.mint(lender, 1);
        vm.prank(lender);
        mockNft.approve(address(diamond), 1);

        // Approve NFT to lender's vault
        vm.prank(lender);
        mockNft.setApprovalForAll(lenderVault, true);

        // Mock decimals on NFT address (needed for price calculation)
        vm.mockCall(
            address(mockNft),
            abi.encodeWithSelector(bytes4(keccak256("decimals()"))),
            abi.encode(uint8(18))
        );

        // Mock vaultSetNFTUser to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultSetNFTUser.selector),
            abi.encode(true)
        );

        // Borrower needs mockUsdc approved for prepay (fee * days + buffer)
        // NFT rental: lender creates offer with dailyFee=1 ether, 30 days
        // Prepay = 1 ether * 30 = 30 ether + 5% buffer = 31.5 ether
        vm.prank(lender);
        uint256 nftOfferId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockNft),
                amount: 1 ether,
                interestRateBps: 500,
                collateralAsset: address(mockUsdc),
                collateralAmount: 0,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: 1,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(mockUsdc),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        // Borrower accepts the NFT rental offer (pays prepay from mockUsdc)
        vm.prank(borrower);
        nftLoanId = OfferAcceptFacet(address(diamond)).acceptOffer(nftOfferId, true);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Sanctions / Country Tests
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice sanctionedUser (IR) tries to accept lender's ERC20 offer -> reverts CountriesNotCompatible
    function test_Sanctions_AcceptOffer_Blocked() public {
        // PHASE 1: country-pair sanctions disabled at protocol level. Re-enable
        // when a Phase-2 upgrade reactivates pairwise sanctions.
        vm.skip(true);
        // Lender creates a new offer
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUsdc),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWeth),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(mockUsdc),
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
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        // sanctionedUser (IR) tries to accept -> CountriesNotCompatible
        vm.prank(sanctionedUser);
        vm.expectRevert(IVaipakamErrors.CountriesNotCompatible.selector);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
    }

    /// @notice sanctionedUser creates a borrower offer. Borrower tries transferObligationViaOffer -> reverts CountriesNotCompatible
    function test_Sanctions_TransferObligation_Blocked() public {
        // PHASE 1: country-pair sanctions disabled at protocol level.
        vm.skip(true);
        // Allow IR<->IR trade so sanctionedUser can create an offer (createOffer itself does not check country)
        // sanctionedUser creates a Borrower offer
        vm.prank(sanctionedUser);
        uint256 sanctionedOfferId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: address(mockUsdc),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWeth),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(mockUsdc),
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
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        // Borrower (US) tries to transfer obligation to sanctionedUser (IR) -> CountriesNotCompatible
        // transferObligationViaOffer checks _enforceCountryAndKYC(newBorrower=sanctionedUser, existingParty=loan.lender)
        // sanctionedUser(IR) vs lender(US) -> no trade allowance -> revert
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.CountriesNotCompatible.selector);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(activeLoanId, sanctionedOfferId);
    }

    /// @notice sanctionedUser creates a lender offer. Original lender tries sellLoanViaBuyOffer -> reverts CountriesNotCompatible
    function test_Sanctions_SellLoan_Blocked() public {
        // PHASE 1: country-pair sanctions disabled at protocol level.
        vm.skip(true);
        // sanctionedUser creates a Lender offer
        vm.prank(sanctionedUser);
        uint256 sanctionedOfferId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUsdc),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWeth),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(mockUsdc),
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
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        // Lender (US) tries to sell to sanctionedUser (IR) -> CountriesNotCompatible
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.CountriesNotCompatible.selector);
        EarlyWithdrawalFacet(address(diamond)).sellLoanViaBuyOffer(activeLoanId, sanctionedOfferId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // KYC Tests
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice A small loan (below $1000) can be accepted by a Tier0 (no KYC) user
    function test_KYC_BelowThreshold_NoKYCRequired() public {
        // Create a new user with Tier0 KYC (default, no explicit tier set needed)
        address noKycUser = makeAddr("noKycUser");
        mockUsdc.mint(noKycUser, 100000 ether);
        mockWeth.mint(noKycUser, 100000 ether);
        vm.prank(noKycUser); ERC20(address(mockUsdc)).approve(address(diamond), type(uint256).max);
        vm.prank(noKycUser); ERC20(address(mockWeth)).approve(address(diamond), type(uint256).max);
        vm.prank(noKycUser); ProfileFacet(address(diamond)).setUserCountry("US");
        // Tier0 is default - no updateKYCTier call needed

        address noKycVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(noKycUser);
        vm.prank(noKycUser); ERC20(address(mockUsdc)).approve(noKycVault, type(uint256).max);
        vm.prank(noKycUser); ERC20(address(mockWeth)).approve(noKycVault, type(uint256).max);

        // Create a small offer: 100 USDC (= $100 at $1 price, well below $1000 threshold)
        vm.prank(lender);
        uint256 smallOfferId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUsdc),
                amount: 100 ether,
                interestRateBps: 500,
                collateralAsset: address(mockWeth),
                collateralAmount: 180 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(mockUsdc),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 100 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 180 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        // Tier0 user can accept small offer (no KYC required)
        vm.prank(noKycUser);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(smallOfferId, true);
        assertTrue(loanId > 0, "Loan should be created for small amount without KYC");
    }

    /// @notice A user with Tier0 KYC tries to accept a $10000+ offer -> reverts KYCRequired
    function test_KYC_AboveThreshold_RequiresTier2() public {
        // README §16 Phase 1 default is pass-through; this test exercises
        // the retained tiered-threshold path, so flip enforcement on.
        AdminFacet(address(diamond)).setKYCEnforcement(true);
        address noKycUser = makeAddr("noKycUser2");
        mockUsdc.mint(noKycUser, 100000 ether);
        vm.prank(noKycUser); ERC20(address(mockUsdc)).approve(address(diamond), type(uint256).max);
        vm.prank(noKycUser); ProfileFacet(address(diamond)).setUserCountry("US");
        // Tier0 is default

        address noKycVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(noKycUser);
        vm.prank(noKycUser); ERC20(address(mockUsdc)).approve(noKycVault, type(uint256).max);

        // Create a large offer: 10000 USDC (= $10000 at $1 price, requires Tier2)
        vm.prank(lender);
        uint256 largeOfferId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUsdc),
                amount: 10000 ether,
                interestRateBps: 500,
                collateralAsset: address(mockWeth),
                collateralAmount: 18000 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(mockUsdc),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 10000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 18000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        // Tier0 user cannot accept large offer -> KYCRequired
        vm.prank(noKycUser);
        vm.expectRevert(IVaipakamErrors.KYCRequired.selector);
        OfferAcceptFacet(address(diamond)).acceptOffer(largeOfferId, true);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC20-Only Rejection Tests (NFT Rental loans blocked from early withdrawal/refinance)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice NFT rental loan: sellLoanViaBuyOffer reverts InvalidSaleOffer
    function test_EarlyWithdrawal_RejectsNFTRental_Option1() public {
        // Create a buy offer from newLender (Lender type)
        vm.prank(newLender);
        uint256 buyOfferId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUsdc),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWeth),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(mockUsdc),
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
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        // Lender tries to sell NFT rental loan -> InvalidSaleOffer (assetType != ERC20)
        vm.prank(lender);
        vm.expectRevert(EarlyWithdrawalFacet.InvalidSaleOffer.selector);
        EarlyWithdrawalFacet(address(diamond)).sellLoanViaBuyOffer(nftLoanId, buyOfferId);
    }

    /// @notice NFT rental loan: createLoanSaleOffer reverts InvalidSaleOffer
    function test_EarlyWithdrawal_RejectsNFTRental_Option2() public {
        // Lender tries to create a sale offer for NFT rental loan -> InvalidSaleOffer
        vm.prank(lender);
        vm.expectRevert(EarlyWithdrawalFacet.InvalidSaleOffer.selector);
        EarlyWithdrawalFacet(address(diamond)).createLoanSaleOffer(nftLoanId, 500, true);
    }

    /// @notice NFT rental loan: refinanceLoan reverts InvalidRefinanceOffer
    function test_Refinance_RejectsNFTRental() public {
        // Borrower creates a Borrower offer for refinancing
        vm.prank(borrower);
        uint256 refiOfferId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: address(mockUsdc),
                amount: PRINCIPAL,
                interestRateBps: 400,
                collateralAsset: address(mockWeth),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(mockUsdc),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: 400,
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );

        // Borrower tries to refinance NFT rental loan -> InvalidRefinanceOffer (assetType != ERC20)
        vm.prank(borrower);
        vm.expectRevert(RefinanceFacet.InvalidRefinanceOffer.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(nftLoanId, refiOfferId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Option 3: Wait-to-Maturity Test
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice ERC20 loan: warp to maturity, borrower repays, lender claims. No early withdrawal needed.
    function test_EarlyWithdrawal_Option3_WaitToMaturity() public {
        // Warp to maturity (30 days)
        vm.warp(block.timestamp + 30 days);

        // Mock cross-facet calls for repayLoan
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            ""
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.burnNFT.selector),
            ""
        );

        // Borrower repays the loan at maturity
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(activeLoanId);

        // Verify loan is now Repaid
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(activeLoanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid), "Loan should be Repaid");

        // Lender claims: mock the NFT ownerOf check and vault withdrawal
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(bytes4(keccak256("ownerOf(uint256)")), loan.lenderTokenId),
            abi.encode(lender)
        );

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(activeLoanId);

        // If no revert, lender claimed successfully without any early-withdrawal action
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Vault Upgrade Test
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Verify vault mandatory upgrade: set mandatory version, user blocked, then upgrade resumes interaction
    function test_VaultUpgrade_MandatoryBlocking() public {
        // Step 1: Deploy a new vault implementation to bump version
        VaipakamVaultImplementation newImpl = new VaipakamVaultImplementation();

        // Step 2: Owner upgrades the vault implementation (bumps currentVaultVersion to 2)
        vm.prank(owner);
        VaultFactoryFacet(address(diamond)).upgradeVaultImplementation(address(newImpl));

        // Step 3: Owner sets mandatory version to 1 (current version after upgrade).
        // Vaults created before upgrade have version 0, so 0 < 1 triggers the block.
        vm.prank(owner);
        VaultFactoryFacet(address(diamond)).setMandatoryVaultUpgrade(1);

        // Step 4: lender's vault was created at version 0. Calling getOrCreateUserVault
        // should revert with VaultUpgradeRequired because version 0 < mandatory 1.
        vm.expectRevert(VaultFactoryFacet.VaultUpgradeRequired.selector);
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);

        // Step 5: User upgrades their vault via upgradeUserVault.
        // The UUPS upgradeToAndCall on the proxy requires mocking since we cannot
        // perform a real UUPS upgrade in this test environment.
        // Read lender's proxy address directly from storage to mock the call on it.
        address lenderProxy = _getLenderVaultDirect();

        // Mock any call to the proxy's upgradeToAndCall to succeed
        vm.mockCall(
            lenderProxy,
            abi.encodeWithSelector(
                bytes4(keccak256("upgradeToAndCall(address,bytes)"))
            ),
            ""
        );

        VaultFactoryFacet(address(diamond)).upgradeUserVault(lender);

        // Clear any stale mocks that might interfere
        vm.clearMockedCalls();

        // Re-mock oracle calls needed for getOrCreateUserVault (it may check liquidity/price)
        mockLiquidity(address(mockUsdc), LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(address(mockUsdc), 1e8, 8);
        mockLiquidity(address(mockWeth), LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(address(mockWeth), 1e8, 8);
        mockLiquidity(address(mockNft), LibVaipakam.LiquidityStatus.Illiquid);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(2e18)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(6666)
        );

        // Step 6: After upgrade, getOrCreateUserVault should succeed
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        assertTrue(vault != address(0), "Vault should be accessible after upgrade");
    }

    /// @dev Helper to get lender's vault address directly from storage,
    ///      bypassing the production `getOrCreateUserVault` path's
    ///      mandatory-version check (which would revert in the
    ///      upgrade-required scenario this test exercises). Routes
    ///      through `TestMutatorFacet.getUserVaipakamVaultRaw` so the
    ///      lookup uses the named-field storage path (layout-resilient
    ///      vs the previous hardcoded `vm.load` at slot offset 1, which
    ///      broke when the Storage struct shifted under T-048's PAD
    ///      additions).
    function _getLenderVaultDirect() internal view returns (address) {
        return TestMutatorFacet(address(diamond)).getUserVaipakamVaultRaw(lender);
    }
}
