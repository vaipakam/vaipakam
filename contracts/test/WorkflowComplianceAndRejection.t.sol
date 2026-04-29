// test/WorkflowComplianceAndRejection.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
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
 *         option 3 wait-to-maturity, and escrow upgrade workflows.
 */
contract WorkflowComplianceAndRejection is Test {
    VaipakamDiamond diamond;
    address owner;
    address lender;
    address borrower;
    address sanctionedUser;
    address newLender;

    ERC20Mock mockUSDC;
    ERC20Mock mockWETH;
    MockRentableNFT721Test mockNFT;

    DiamondCutFacet cutFacet;
    OfferFacet offerFacet;
    ProfileFacet profileFacet;
    OracleFacet oracleFacet;
    VaipakamNFTFacet nftFacet;
    EscrowFactoryFacet escrowFacet;
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
        mockUSDC = new ERC20Mock("MockUSDC", "USDC", 18);
        mockWETH = new ERC20Mock("MockWETH", "WETH", 18);
        mockNFT = new MockRentableNFT721Test();

        // Mint tokens to all actors
        mockUSDC.mint(lender, 100000 ether);
        mockUSDC.mint(borrower, 100000 ether);
        mockUSDC.mint(sanctionedUser, 100000 ether);
        mockUSDC.mint(newLender, 100000 ether);
        mockWETH.mint(lender, 100000 ether);
        mockWETH.mint(borrower, 100000 ether);
        mockWETH.mint(sanctionedUser, 100000 ether);
        mockWETH.mint(newLender, 100000 ether);

        // Deploy facets
        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        offerFacet = new OfferFacet();
        profileFacet = new ProfileFacet();
        oracleFacet = new OracleFacet();
        nftFacet = new VaipakamNFTFacet();
        escrowFacet = new EscrowFactoryFacet();
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
        helperTest = new HelperTest();

        // Cut 14 facets + 3 phase-2 facets into diamond
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](16);
        cuts[0]  = IDiamondCut.FacetCut({facetAddress: address(offerFacet),          action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferFacetSelectors()});
        cuts[1]  = IDiamondCut.FacetCut({facetAddress: address(profileFacet),        action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getProfileFacetSelectors()});
        cuts[2]  = IDiamondCut.FacetCut({facetAddress: address(oracleFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOracleFacetSelectors()});
        cuts[3]  = IDiamondCut.FacetCut({facetAddress: address(nftFacet),            action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getVaipakamNFTFacetSelectors()});
        cuts[4]  = IDiamondCut.FacetCut({facetAddress: address(escrowFacet),         action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getEscrowFactoryFacetSelectors()});
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
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Initialize diamond services
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        AdminFacet(address(diamond)).setZeroExProxy(makeAddr("zeroEx"));
        AdminFacet(address(diamond)).setallowanceTarget(makeAddr("zeroEx"));

        // Approvals for diamond
        vm.prank(lender);    ERC20(address(mockUSDC)).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);  ERC20(address(mockUSDC)).approve(address(diamond), type(uint256).max);
        vm.prank(sanctionedUser); ERC20(address(mockUSDC)).approve(address(diamond), type(uint256).max);
        vm.prank(newLender); ERC20(address(mockUSDC)).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);  ERC20(address(mockWETH)).approve(address(diamond), type(uint256).max);
        vm.prank(sanctionedUser); ERC20(address(mockWETH)).approve(address(diamond), type(uint256).max);
        vm.prank(newLender); ERC20(address(mockWETH)).approve(address(diamond), type(uint256).max);

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

        // Risk params for mockUSDC
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(address(mockUSDC), 8000, 8500, 300, 1000);
        // Risk params for mockWETH (used as distinct collateral asset after SelfCollateralizedOffer invariant)
        vm.prank(owner);
        RiskFacet(address(diamond)).updateRiskParams(address(mockWETH), 8000, 8500, 300, 1000);

        // Mock oracle: mockUSDC = Liquid, $1 price
        mockLiquidity(address(mockUSDC), LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(address(mockUSDC), 1e8, 8);
        // mockWETH = Liquid, $1 price (for simplicity)
        mockLiquidity(address(mockWETH), LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(address(mockWETH), 1e8, 8);
        // mockNFT = Illiquid
        mockLiquidity(address(mockNFT), LibVaipakam.LiquidityStatus.Illiquid);

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

        // Create escrows and approve them
        address lenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        address borrowerEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(borrower);
        address sanctionedEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(sanctionedUser);
        address newLenderEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(newLender);

        vm.prank(lender);    ERC20(address(mockUSDC)).approve(lenderEscrow, type(uint256).max);
        vm.prank(borrower);  ERC20(address(mockUSDC)).approve(borrowerEscrow, type(uint256).max);
        vm.prank(sanctionedUser); ERC20(address(mockUSDC)).approve(sanctionedEscrow, type(uint256).max);
        vm.prank(newLender); ERC20(address(mockUSDC)).approve(newLenderEscrow, type(uint256).max);
        vm.prank(borrower);  ERC20(address(mockWETH)).approve(borrowerEscrow, type(uint256).max);
        vm.prank(sanctionedUser); ERC20(address(mockWETH)).approve(sanctionedEscrow, type(uint256).max);
        vm.prank(newLender); ERC20(address(mockWETH)).approve(newLenderEscrow, type(uint256).max);

        // Mint tokens to diamond for internal transfers
        mockUSDC.mint(address(diamond), 100000 ether);

        // ── Create active ERC20 loan (lender creates offer, borrower accepts) ──
        vm.prank(lender);
        uint256 erc20OfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUSDC),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWETH),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(mockUSDC),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
            })
        );
        vm.prank(borrower);
        activeLoanId = OfferFacet(address(diamond)).acceptOffer(erc20OfferId, true);

        // ── Create active NFT rental loan ──
        // Mint NFT to lender, approve to diamond
        mockNFT.mint(lender, 1);
        vm.prank(lender);
        mockNFT.approve(address(diamond), 1);

        // Approve NFT to lender's escrow
        vm.prank(lender);
        mockNFT.setApprovalForAll(lenderEscrow, true);

        // Mock decimals on NFT address (needed for price calculation)
        vm.mockCall(
            address(mockNFT),
            abi.encodeWithSelector(bytes4(keccak256("decimals()"))),
            abi.encode(uint8(18))
        );

        // Mock escrowSetNFTUser to succeed
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.escrowSetNFTUser.selector),
            abi.encode(true)
        );

        // Borrower needs mockUSDC approved for prepay (fee * days + buffer)
        // NFT rental: lender creates offer with dailyFee=1 ether, 30 days
        // Prepay = 1 ether * 30 = 30 ether + 5% buffer = 31.5 ether
        vm.prank(lender);
        uint256 nftOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockNFT),
                amount: 1 ether,
                interestRateBps: 500,
                collateralAsset: address(mockUSDC),
                collateralAmount: 0,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: 1,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(mockUSDC),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
            })
        );

        // Borrower accepts the NFT rental offer (pays prepay from mockUSDC)
        vm.prank(borrower);
        nftLoanId = OfferFacet(address(diamond)).acceptOffer(nftOfferId, true);
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
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUSDC),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWETH),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(mockUSDC),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
            })
        );

        // sanctionedUser (IR) tries to accept -> CountriesNotCompatible
        vm.prank(sanctionedUser);
        vm.expectRevert(IVaipakamErrors.CountriesNotCompatible.selector);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
    }

    /// @notice sanctionedUser creates a borrower offer. Borrower tries transferObligationViaOffer -> reverts CountriesNotCompatible
    function test_Sanctions_TransferObligation_Blocked() public {
        // PHASE 1: country-pair sanctions disabled at protocol level.
        vm.skip(true);
        // Allow IR<->IR trade so sanctionedUser can create an offer (createOffer itself does not check country)
        // sanctionedUser creates a Borrower offer
        vm.prank(sanctionedUser);
        uint256 sanctionedOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: address(mockUSDC),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWETH),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(mockUSDC),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
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
        uint256 sanctionedOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUSDC),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWETH),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(mockUSDC),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
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
        mockUSDC.mint(noKycUser, 100000 ether);
        mockWETH.mint(noKycUser, 100000 ether);
        vm.prank(noKycUser); ERC20(address(mockUSDC)).approve(address(diamond), type(uint256).max);
        vm.prank(noKycUser); ERC20(address(mockWETH)).approve(address(diamond), type(uint256).max);
        vm.prank(noKycUser); ProfileFacet(address(diamond)).setUserCountry("US");
        // Tier0 is default - no updateKYCTier call needed

        address noKycEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(noKycUser);
        vm.prank(noKycUser); ERC20(address(mockUSDC)).approve(noKycEscrow, type(uint256).max);
        vm.prank(noKycUser); ERC20(address(mockWETH)).approve(noKycEscrow, type(uint256).max);

        // Create a small offer: 100 USDC (= $100 at $1 price, well below $1000 threshold)
        vm.prank(lender);
        uint256 smallOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUSDC),
                amount: 100 ether,
                interestRateBps: 500,
                collateralAsset: address(mockWETH),
                collateralAmount: 180 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(mockUSDC),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
            })
        );

        // Tier0 user can accept small offer (no KYC required)
        vm.prank(noKycUser);
        uint256 loanId = OfferFacet(address(diamond)).acceptOffer(smallOfferId, true);
        assertTrue(loanId > 0, "Loan should be created for small amount without KYC");
    }

    /// @notice A user with Tier0 KYC tries to accept a $10000+ offer -> reverts KYCRequired
    function test_KYC_AboveThreshold_RequiresTier2() public {
        // README §16 Phase 1 default is pass-through; this test exercises
        // the retained tiered-threshold path, so flip enforcement on.
        AdminFacet(address(diamond)).setKYCEnforcement(true);
        address noKycUser = makeAddr("noKycUser2");
        mockUSDC.mint(noKycUser, 100000 ether);
        vm.prank(noKycUser); ERC20(address(mockUSDC)).approve(address(diamond), type(uint256).max);
        vm.prank(noKycUser); ProfileFacet(address(diamond)).setUserCountry("US");
        // Tier0 is default

        address noKycEscrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(noKycUser);
        vm.prank(noKycUser); ERC20(address(mockUSDC)).approve(noKycEscrow, type(uint256).max);

        // Create a large offer: 10000 USDC (= $10000 at $1 price, requires Tier2)
        vm.prank(lender);
        uint256 largeOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUSDC),
                amount: 10000 ether,
                interestRateBps: 500,
                collateralAsset: address(mockWETH),
                collateralAmount: 18000 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(mockUSDC),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
            })
        );

        // Tier0 user cannot accept large offer -> KYCRequired
        vm.prank(noKycUser);
        vm.expectRevert(IVaipakamErrors.KYCRequired.selector);
        OfferFacet(address(diamond)).acceptOffer(largeOfferId, true);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC20-Only Rejection Tests (NFT Rental loans blocked from early withdrawal/refinance)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice NFT rental loan: sellLoanViaBuyOffer reverts InvalidSaleOffer
    function test_EarlyWithdrawal_RejectsNFTRental_Option1() public {
        // Create a buy offer from newLender (Lender type)
        vm.prank(newLender);
        uint256 buyOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(mockUSDC),
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: address(mockWETH),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(mockUSDC),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
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
        uint256 refiOfferId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: address(mockUSDC),
                amount: PRINCIPAL,
                interestRateBps: 400,
                collateralAsset: address(mockWETH),
                collateralAmount: COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(mockUSDC),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
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
            abi.encodeWithSelector(EscrowFactoryFacet.escrowWithdrawERC20.selector),
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

        // Lender claims: mock the NFT ownerOf check and escrow withdrawal
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
    // Escrow Upgrade Test
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Verify escrow mandatory upgrade: set mandatory version, user blocked, then upgrade resumes interaction
    function test_EscrowUpgrade_MandatoryBlocking() public {
        // Step 1: Deploy a new escrow implementation to bump version
        VaipakamEscrowImplementation newImpl = new VaipakamEscrowImplementation();

        // Step 2: Owner upgrades the escrow implementation (bumps currentEscrowVersion to 2)
        vm.prank(owner);
        EscrowFactoryFacet(address(diamond)).upgradeEscrowImplementation(address(newImpl));

        // Step 3: Owner sets mandatory version to 1 (current version after upgrade).
        // Escrows created before upgrade have version 0, so 0 < 1 triggers the block.
        vm.prank(owner);
        EscrowFactoryFacet(address(diamond)).setMandatoryEscrowUpgrade(1);

        // Step 4: lender's escrow was created at version 0. Calling getOrCreateUserEscrow
        // should revert with EscrowUpgradeRequired because version 0 < mandatory 1.
        vm.expectRevert(EscrowFactoryFacet.EscrowUpgradeRequired.selector);
        EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);

        // Step 5: User upgrades their escrow via upgradeUserEscrow.
        // The UUPS upgradeToAndCall on the proxy requires mocking since we cannot
        // perform a real UUPS upgrade in this test environment.
        // Read lender's proxy address directly from storage to mock the call on it.
        address lenderProxy = _getLenderEscrowDirect();

        // Mock any call to the proxy's upgradeToAndCall to succeed
        vm.mockCall(
            lenderProxy,
            abi.encodeWithSelector(
                bytes4(keccak256("upgradeToAndCall(address,bytes)"))
            ),
            ""
        );

        EscrowFactoryFacet(address(diamond)).upgradeUserEscrow(lender);

        // Clear any stale mocks that might interfere
        vm.clearMockedCalls();

        // Re-mock oracle calls needed for getOrCreateUserEscrow (it may check liquidity/price)
        mockLiquidity(address(mockUSDC), LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(address(mockUSDC), 1e8, 8);
        mockLiquidity(address(mockWETH), LibVaipakam.LiquidityStatus.Liquid);
        mockPrice(address(mockWETH), 1e8, 8);
        mockLiquidity(address(mockNFT), LibVaipakam.LiquidityStatus.Illiquid);
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

        // Step 6: After upgrade, getOrCreateUserEscrow should succeed
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(lender);
        assertTrue(escrow != address(0), "Escrow should be accessible after upgrade");
    }

    /// @dev Helper to get lender's escrow address directly from storage (bypassing the mandatory check)
    function _getLenderEscrowDirect() internal view returns (address) {
        // Read the userVaipakamEscrows mapping from diamond storage.
        // Storage struct position: LibVaipakam.VANGKI_STORAGE_POSITION
        // userVaipakamEscrows is the second field (offset 1) in the Storage struct.
        bytes32 baseSlot = LibVaipakam.VANGKI_STORAGE_POSITION;
        bytes32 mappingSlot = bytes32(uint256(baseSlot) + 1);
        bytes32 entrySlot = keccak256(abi.encode(lender, mappingSlot));
        bytes32 value = vm.load(address(diamond), entrySlot);
        return address(uint160(uint256(value)));
    }
}
