// script/SepoliaPositiveFlows.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {ERC4907Mock} from "../test/mocks/ERC4907Mock.sol";
import {ERC1155RentableMock} from "../test/mocks/ERC1155RentableMock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title SepoliaPositiveFlows
 * @notice End-to-end positive flow tests against the deployed Vaipakam Diamond on Sepolia.
 *
 * Accounts:
 *   - admin: platform admin (RBAC roles, KYC, etc.)
 *   - lender/borrower: basic flow participants (Scenarios 1-6)
 *   - newLender/newBorrower: advanced flow participants (Scenarios 7-9: preclose, early withdrawal, refinance)
 */
contract SepoliaPositiveFlows is Script {
    // ── Addresses ───────────────────────────────────────────────────────
    address diamond;
    address deployer;
    address admin;
    address lender;
    address borrower;
    address newLender;
    address newBorrower;
    uint256 deployerKey;
    uint256 adminKey;
    uint256 lenderKey;
    uint256 borrowerKey;
    uint256 newLenderKey;
    uint256 newBorrowerKey;

    // ── Mock tokens deployed by this script ─────────────────────────────
    ERC20Mock usdc;            // Liquid ERC20 (lending asset)
    ERC20Mock weth;            // Liquid ERC20 (collateral)
    ERC20Mock illiquidToken;   // Illiquid ERC20 (no liquidity override) — collateral side
    ERC20Mock illiquidLending; // Illiquid ERC20 — lending side (Scenario 14)
    ERC4907Mock nft721;        // Rentable ERC721 (for rental + collateral)
    ERC1155RentableMock nft1155; // Rentable ERC1155 (for rental + collateral)

    // ── Constants ───────────────────────────────────────────────────────
    uint256 constant LOAN_AMOUNT = 1000e6;      // 1000 USDC (6 decimals)
    uint256 constant COLLATERAL_AMOUNT = 1e18;  // 1 WETH (18 decimals)
    uint256 constant DAILY_FEE = 10e6;          // 10 USDC daily rental fee
    uint256 constant NFT_TOKEN_ID_BASE = 100;   // Base token ID for NFTs
    uint256 constant INTEREST_BPS = 500;        // 5% APR
    uint256 constant DURATION_DAYS = 30;

    function run() external {
        // ── Load env ────────────────────────────────────────────────────
        // Phase-1 2-EOA topology: deployerKey (PRIVATE_KEY) funds accounts
        // and deploys mocks (gas-heavy, holds no roles post-handover);
        // adminKey (ADMIN_PRIVATE_KEY) signs role-gated calls on the Diamond.
        deployerKey = vm.envUint("PRIVATE_KEY");
        deployer = vm.addr(deployerKey);
        adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        admin = vm.envAddress("ADMIN_ADDRESS");
        lenderKey = vm.envUint("LENDER_PRIVATE_KEY");
        lender = vm.envAddress("LENDER_ADDRESS");
        borrowerKey = vm.envUint("BORROWER_PRIVATE_KEY");
        borrower = vm.envAddress("BORROWER_ADDRESS");
        newLenderKey = vm.envUint("NEW_LENDER_PRIVATE_KEY");
        newLender = vm.envAddress("NEW_LENDER_ADDRESS");
        newBorrowerKey = vm.envUint("NEW_BORROWER_PRIVATE_KEY");
        newBorrower = vm.envAddress("NEW_BORROWER_ADDRESS");
        diamond = Deployments.readDiamond();

        console.log("=== Sepolia Positive Flow Tests ===");
        console.log("Diamond: ", diamond);
        console.log("Admin:   ", admin);
        console.log("Lender:  ", lender);
        console.log("Borrower:", borrower);
        console.log("NewLender: ", newLender);
        console.log("NewBorrower:", newBorrower);

        // ════════════════════════════════════════════════════════════════
        // PHASE 1a: DEPLOYER SETUP (mocks + mints)
        // Signed by deployerKey — owns the mock tokens so it can mint to
        // participants. Account gas funding is handled by admin in Phase
        // 1b instead: post-handover the deployer may be light on gas while
        // admin (ERC-173 owner) holds the operational budget.
        // ════════════════════════════════════════════════════════════════
        vm.startBroadcast(deployerKey);

        // Deploy mock tokens. All deploys happen here in Phase 1a so that
        // forge's broadcast pre-check sees every token address after its
        // CREATE tx — deploying a token mid-script and then approving it
        // in a later scenario trips the "transaction to address with no
        // code" warning and aborts the broadcast.
        usdc = new ERC20Mock("Mock USDC", "mUSDC", 6);
        weth = new ERC20Mock("Mock WETH", "mWETH", 18);
        illiquidToken = new ERC20Mock("Illiquid Token", "ILLIQ", 18);
        illiquidLending = new ERC20Mock("Illiquid Lending", "ILLEND", 18);
        nft721 = new ERC4907Mock("Rentable NFT 721", "rNFT");
        nft1155 = new ERC1155RentableMock();
        console.log("MockUSDC:", address(usdc));
        console.log("MockWETH:", address(weth));
        console.log("IlliquidToken:", address(illiquidToken));
        console.log("IlliquidLending:", address(illiquidLending));
        console.log("NFT721:", address(nft721));
        console.log("NFT1155:", address(nft1155));

        // Mint ERC20 tokens to all participants
        usdc.mint(lender, 500_000e6);
        usdc.mint(borrower, 500_000e6);
        usdc.mint(newLender, 500_000e6);
        usdc.mint(newBorrower, 500_000e6);
        usdc.mint(admin, 100_000e6);
        weth.mint(lender, 100e18);
        weth.mint(borrower, 100e18);
        weth.mint(newLender, 100e18);
        weth.mint(newBorrower, 100e18);
        illiquidToken.mint(lender, 10_000e18);
        illiquidToken.mint(borrower, 10_000e18);
        illiquidToken.mint(newLender, 10_000e18);
        illiquidToken.mint(newBorrower, 10_000e18);
        illiquidLending.mint(lender, 10_000e18);
        illiquidLending.mint(borrower, 10_000e18);

        // Mint NFTs
        // ERC721: tokenIds 100-109 for lender, 110-119 for borrower, 120-129 for newLender, 130-139 for newBorrower
        for (uint256 i = 0; i < 10; i++) {
            nft721.mint(lender, 100 + i);
            nft721.mint(borrower, 110 + i);
            nft721.mint(newLender, 120 + i);
            nft721.mint(newBorrower, 130 + i);
        }
        // ERC1155: tokenId 1, quantity 100 each
        nft1155.forceMint(lender, 1, 100);
        nft1155.forceMint(borrower, 1, 100);
        nft1155.forceMint(newLender, 1, 100);
        nft1155.forceMint(newBorrower, 1, 100);

        // ── Mock oracle infra (deployed by deployer) ────────────────────
        MockChainlinkRegistry mockRegistry = new MockChainlinkRegistry();
        MockChainlinkFeed usdcFeed = new MockChainlinkFeed(1e8, 8);       // $1.00
        MockChainlinkFeed wethFeed = new MockChainlinkFeed(2000e8, 8);    // $2000.00
        address USD_DENOM = 0x0000000000000000000000000000000000000348;    // Chainlink Denominations.USD
        // Register feeds for liquid mock tokens only (illiquid tokens have NO feed → naturally Illiquid)
        mockRegistry.setFeed(address(usdc), USD_DENOM, address(usdcFeed));
        mockRegistry.setFeed(address(weth), USD_DENOM, address(wethFeed));

        // Mock v3-style AMM factory + mUSDC/mWETH 0.3% pool. OracleFacet
        // looks up pools via `factory.getPool(tokenA, tokenB, fee)` (no
        // CREATE2 derivation), so any ABI-compatible mock works. Pool
        // liquidity is set well above the MIN_LIQUIDITY_USD floor so
        // mUSDC and mWETH classify Liquid; illiquidToken/illiquidLending
        // have no pool registered and classify Illiquid naturally.
        MockUniswapV3Factory univ3Factory = new MockUniswapV3Factory();
        uint160 mockSqrtPriceX96 = 79228162514264337593543950336; // 2^96 ≈ price 1
        univ3Factory.createPool(address(usdc), address(weth), 3000, mockSqrtPriceX96, 1e24);
        console.log("MockUniswapV3Factory:", address(univ3Factory));

        vm.stopBroadcast();

        // ════════════════════════════════════════════════════════════════
        // PHASE 1b: ADMIN SETUP (account funding + role-gated config)
        // Signed by adminKey — needs ORACLE_ADMIN_ROLE, RISK_ADMIN_ROLE,
        // KYC_ADMIN_ROLE, ADMIN_ROLE (all held by admin after handover).
        // Admin also funds the participant EOAs with gas; after handover
        // it holds the operational ETH budget, deployer may be depleted.
        // ════════════════════════════════════════════════════════════════
        vm.startBroadcast(adminKey);

        // Fund participant EOAs with enough gas for the scenario run.
        // 0.05 ETH is generous for L2s (Base, Polygon) and sufficient for
        // Sepolia L1 with typical testnet gas (~1-3 gwei). Top up the
        // deployer side of .env and re-run if any scenario hits OOG.
        _fundIfNeeded(lender, 0.05 ether);
        _fundIfNeeded(borrower, 0.05 ether);
        _fundIfNeeded(newLender, 0.05 ether);
        _fundIfNeeded(newBorrower, 0.05 ether);

        // Configure Diamond oracle with mock registry
        OracleAdminFacet(diamond).setChainlinkRegistry(address(mockRegistry));
        OracleAdminFacet(diamond).setUsdChainlinkDenominator(USD_DENOM);
        OracleAdminFacet(diamond).setWethContract(address(weth));
        OracleAdminFacet(diamond).setEthUsdFeed(address(wethFeed));
        OracleAdminFacet(diamond).setUniswapV3Factory(address(univ3Factory));
        console.log("Oracle configured: registry, feeds set");

        // Configure risk parameters for mock tokens
        // maxLtvBps=8000 (80%), liqThreshold=8500 (85%), liqBonus=500 (5%), reserveFactor=1000 (10%)
        RiskFacet(diamond).updateRiskParams(address(weth), 8000, 8500, 300, 1000);
        RiskFacet(diamond).updateRiskParams(address(usdc), 8000, 8500, 300, 1000);
        console.log("Risk params configured for mock tokens");

        // KYC & trade allowances
        ProfileFacet(diamond).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(newLender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(newBorrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).setTradeAllowance("US", "US", true);
        console.log("KYC & trade configured for all accounts");

        vm.stopBroadcast();

        // Set countries (each user sets their own)
        _setCountryIfNeeded(lenderKey, lender, "US");
        _setCountryIfNeeded(borrowerKey, borrower, "US");
        _setCountryIfNeeded(newLenderKey, newLender, "US");
        _setCountryIfNeeded(newBorrowerKey, newBorrower, "US");
        console.log("All countries set");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 1: ERC-20 Lending Full Lifecycle
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 1: ERC-20 Lending Full Lifecycle ===");
        uint256 loanId1 = _scenario_lenderOffer_borrowerAccepts_repay_claim(
            lenderKey, lender, borrowerKey, borrower
        );
        console.log(">>> SCENARIO 1 PASSED <<< loanId:", loanId1);

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 2: Third-Party Repayment
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 2: Third-Party Repayment ===");

        // Create & accept offer
        uint256 offerId2 = _createLenderOffer(lenderKey, lender);
        uint256 loanId2 = _acceptOffer(borrowerKey, borrower, offerId2);
        console.log("Loan initiated, loanId:", loanId2);

        // Admin repays on behalf of borrower
        vm.startBroadcast(adminKey);
        uint256 repayAmt2 = RepayFacet(diamond).calculateRepaymentAmount(loanId2);
        usdc.approve(diamond, repayAmt2);
        RepayFacet(diamond).repayLoan(loanId2);
        vm.stopBroadcast();
        console.log("Admin (third-party) repaid loan");

        _claimBoth(lenderKey, borrowerKey, loanId2);
        console.log(">>> SCENARIO 2 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 3: Borrower Creates Offer
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 3: Borrower Creates Offer ===");

        // Borrower creates offer (locks collateral)
        uint256 offerId3;
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        offerId3 = OfferFacet(diamond).createOffer(_borrowerOfferParams());
        vm.stopBroadcast();
        console.log("Borrower created offer:", offerId3);

        // Lender transfers USDC directly to their escrow then accepts
        vm.startBroadcast(lenderKey);
        address lenderEscrow = EscrowFactoryFacet(diamond).getOrCreateUserEscrow(lender);
        usdc.transfer(lenderEscrow, LOAN_AMOUNT);
        uint256 loanId3 = OfferFacet(diamond).acceptOffer(offerId3, true);
        vm.stopBroadcast();
        console.log("Lender accepted, loanId:", loanId3);

        // Repay & claim
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt3 = RepayFacet(diamond).calculateRepaymentAmount(loanId3);
        usdc.approve(diamond, repayAmt3);
        RepayFacet(diamond).repayLoan(loanId3);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId3);
        console.log(">>> SCENARIO 3 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 4: Add Collateral
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 4: Add Collateral ===");

        uint256 offerId4 = _createLenderOffer(lenderKey, lender);
        uint256 loanId4 = _acceptOffer(borrowerKey, borrower, offerId4);
        console.log("Loan initiated, loanId:", loanId4);

        // Borrower adds 0.5 WETH
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, 0.5e18);
        AddCollateralFacet(diamond).addCollateral(loanId4, 0.5e18);
        vm.stopBroadcast();
        console.log("Borrower added 0.5 WETH collateral");

        // Repay & claim
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt4 = RepayFacet(diamond).calculateRepaymentAmount(loanId4);
        usdc.approve(diamond, repayAmt4);
        RepayFacet(diamond).repayLoan(loanId4);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId4);
        console.log(">>> SCENARIO 4 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 5: Cancel Lender Offer
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 5: Cancel Lender Offer ===");

        uint256 balBefore5 = usdc.balanceOf(lender);
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId5 = OfferFacet(diamond).createOffer(_lenderOfferParams());
        OfferFacet(diamond).cancelOffer(offerId5);
        vm.stopBroadcast();
        console.log("Offer created & cancelled. USDC returned:", usdc.balanceOf(lender) >= balBefore5 ? "YES" : "NO");
        console.log(">>> SCENARIO 5 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 6: Cancel Borrower Offer
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 6: Cancel Borrower Offer ===");

        uint256 balBefore6 = weth.balanceOf(borrower);
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 offerId6 = OfferFacet(diamond).createOffer(_borrowerOfferParams());
        OfferFacet(diamond).cancelOffer(offerId6);
        vm.stopBroadcast();
        console.log("Offer created & cancelled. WETH returned:", weth.balanceOf(borrower) >= balBefore6 ? "YES" : "NO");
        console.log(">>> SCENARIO 6 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 7: Preclose Direct (Early Repayment)
        //   Uses newLender & newBorrower
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 7: Preclose Direct ===");

        uint256 offerId7 = _createLenderOffer(newLenderKey, newLender);
        uint256 loanId7 = _acceptOffer(newBorrowerKey, newBorrower, offerId7);
        console.log("Loan initiated, loanId:", loanId7);

        // Borrower precloses early
        vm.startBroadcast(newBorrowerKey);
        uint256 fullTermInterest = (LOAN_AMOUNT * INTEREST_BPS * DURATION_DAYS) / (365 * 10000);
        uint256 precloseApproval = LOAN_AMOUNT + fullTermInterest + fullTermInterest; // generous approval
        usdc.approve(diamond, precloseApproval);
        PrecloseFacet(diamond).precloseDirect(loanId7);
        vm.stopBroadcast();
        console.log("Borrower preclosed loan");

        _claimBoth(newLenderKey, newBorrowerKey, loanId7);
        console.log(">>> SCENARIO 7 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 8: Early Withdrawal by Lender (Sell via Buy Offer)
        //   newLender creates offer, newBorrower accepts,
        //   then lender (original) creates a buy offer, newLender sells to lender
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 8: Early Withdrawal (Lender sells position) ===");

        // newLender creates offer, newBorrower accepts
        uint256 offerId8 = _createLenderOffer(newLenderKey, newLender);
        uint256 loanId8 = _acceptOffer(newBorrowerKey, newBorrower, offerId8);
        console.log("Loan initiated, loanId:", loanId8);

        // Original lender creates a buy offer (lender-type offer to buy the position)
        uint256 buyOfferId;
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        buyOfferId = OfferFacet(diamond).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(usdc),
                amount: LOAN_AMOUNT,
                interestRateBps: INTEREST_BPS,
                collateralAsset: address(weth),
                collateralAmount: COLLATERAL_AMOUNT,
                durationDays: DURATION_DAYS,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(usdc),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false
            })
        );
        vm.stopBroadcast();
        console.log("Buy offer created:", buyOfferId);

        // newLender sells position via the buy offer
        vm.startBroadcast(newLenderKey);
        EarlyWithdrawalFacet(diamond).sellLoanViaBuyOffer(loanId8, buyOfferId);
        vm.stopBroadcast();
        console.log("Lender sold position to new lender");

        // newBorrower repays the loan (now owed to the new lender)
        vm.startBroadcast(newBorrowerKey);
        uint256 repayAmt8 = RepayFacet(diamond).calculateRepaymentAmount(loanId8);
        usdc.approve(diamond, repayAmt8);
        RepayFacet(diamond).repayLoan(loanId8);
        vm.stopBroadcast();
        console.log("Borrower repaid");

        // New lender (original lender) claims
        vm.startBroadcast(lenderKey);
        ClaimFacet(diamond).claimAsLender(loanId8);
        vm.stopBroadcast();
        // Borrower claims collateral
        vm.startBroadcast(newBorrowerKey);
        ClaimFacet(diamond).claimAsBorrower(loanId8);
        vm.stopBroadcast();
        console.log(">>> SCENARIO 8 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 9: Illiquid ERC20 Collateral with Liquid Lending
        //   Liquid USDC lending + illiquid ERC20 collateral
        //   LTV/HF checks skipped for illiquid collateral
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 9: Illiquid ERC20 Collateral ===");

        // Lender creates offer: lend USDC (liquid), collateral = illiquidToken
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId9 = OfferFacet(diamond).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(usdc),
                amount: LOAN_AMOUNT,
                interestRateBps: INTEREST_BPS,
                collateralAsset: address(illiquidToken),
                collateralAmount: 200e18, // 200 ILLIQ tokens
                durationDays: DURATION_DAYS,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(usdc),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false
            })
        );
        vm.stopBroadcast();
        console.log("Lender offer created:", offerId9);

        // Borrower accepts with illiquid consent
        vm.startBroadcast(borrowerKey);
        illiquidToken.approve(diamond, 200e18);
        uint256 loanId9 = OfferFacet(diamond).acceptOffer(offerId9, true);
        vm.stopBroadcast();
        console.log("Loan initiated, loanId:", loanId9);

        // Borrower repays
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt9 = RepayFacet(diamond).calculateRepaymentAmount(loanId9);
        usdc.approve(diamond, repayAmt9);
        RepayFacet(diamond).repayLoan(loanId9);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId9);
        console.log(">>> SCENARIO 9 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 10: NFT ERC721 as Collateral
        //   Liquid USDC lending + ERC721 NFT collateral
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 10: NFT ERC721 as Collateral ===");

        // Borrower creates offer: wants USDC loan, offers ERC721 NFT as collateral
        vm.startBroadcast(borrowerKey);
        nft721.approve(diamond, 110); // tokenId 110
        uint256 offerId10 = OfferFacet(diamond).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: address(usdc),
                amount: LOAN_AMOUNT,
                interestRateBps: INTEREST_BPS,
                collateralAsset: address(nft721),
                collateralAmount: 1,
                durationDays: DURATION_DAYS,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(usdc),
                collateralAssetType: LibVaipakam.AssetType.ERC721,
                collateralTokenId: 110,
                collateralQuantity: 0,
                allowsPartialRepay: false
            })
        );
        vm.stopBroadcast();
        console.log("Borrower offer with NFT721 collateral:", offerId10);

        // Lender accepts: deposit USDC to escrow, then accept
        vm.startBroadcast(lenderKey);
        address lenderEscrow10 = EscrowFactoryFacet(diamond).getOrCreateUserEscrow(lender);
        usdc.transfer(lenderEscrow10, LOAN_AMOUNT);
        uint256 loanId10 = OfferFacet(diamond).acceptOffer(offerId10, true);
        vm.stopBroadcast();
        console.log("Loan initiated, loanId:", loanId10);

        // Borrower repays
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt10 = RepayFacet(diamond).calculateRepaymentAmount(loanId10);
        usdc.approve(diamond, repayAmt10);
        RepayFacet(diamond).repayLoan(loanId10);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId10);
        console.log(">>> SCENARIO 10 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 11: NFT ERC1155 as Collateral
        //   Liquid USDC lending + ERC1155 NFT collateral
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 11: NFT ERC1155 as Collateral ===");

        // Borrower creates offer: wants USDC, offers ERC1155 (tokenId=1, qty=10) as collateral
        vm.startBroadcast(borrowerKey);
        nft1155.setApprovalForAll(diamond, true);
        uint256 offerId11 = OfferFacet(diamond).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: address(usdc),
                amount: LOAN_AMOUNT,
                interestRateBps: INTEREST_BPS,
                collateralAsset: address(nft1155),
                collateralAmount: 10,
                durationDays: DURATION_DAYS,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(usdc),
                collateralAssetType: LibVaipakam.AssetType.ERC1155,
                collateralTokenId: 1,
                collateralQuantity: 10,
                allowsPartialRepay: false
            })
        );
        vm.stopBroadcast();
        console.log("Borrower offer with ERC1155 collateral:", offerId11);

        // Lender accepts
        vm.startBroadcast(lenderKey);
        address lenderEscrow11 = EscrowFactoryFacet(diamond).getOrCreateUserEscrow(lender);
        usdc.transfer(lenderEscrow11, LOAN_AMOUNT);
        uint256 loanId11 = OfferFacet(diamond).acceptOffer(offerId11, true);
        vm.stopBroadcast();
        console.log("Loan initiated, loanId:", loanId11);

        // Borrower repays
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt11 = RepayFacet(diamond).calculateRepaymentAmount(loanId11);
        usdc.approve(diamond, repayAmt11);
        RepayFacet(diamond).repayLoan(loanId11);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId11);
        console.log(">>> SCENARIO 11 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 12: NFT ERC721 Renting
        //   Lender offers ERC721 for rent, borrower prepays rental fees
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 12: NFT ERC721 Renting ===");
        {
            // Lender creates rental offer: lend ERC721 (tokenId=100), daily fee=10 USDC, 7 days
            vm.startBroadcast(newLenderKey);
            nft721.approve(diamond, 120); // tokenId 120 belongs to newLender
            uint256 offerId12 = OfferFacet(diamond).createOffer(
                LibVaipakam.CreateOfferParams({
                    offerType: LibVaipakam.OfferType.Lender,
                    lendingAsset: address(nft721),
                    amount: DAILY_FEE,          // daily rental fee in prepayAsset
                    interestRateBps: 0,         // not applicable for NFT rental
                    // Rentals don't use collateral; use the prepay token
                    // (usdc) as a non-zero, distinct placeholder so the
                    // SelfCollateralizedOffer check (lendingAsset ==
                    // collateralAsset ⇒ revert) passes.
                    collateralAsset: address(usdc),
                    collateralAmount: 0,
                    durationDays: 7,
                    assetType: LibVaipakam.AssetType.ERC721,
                    tokenId: 120,
                    quantity: 1,
                    creatorFallbackConsent: true,
                    prepayAsset: address(usdc),
                    collateralAssetType: LibVaipakam.AssetType.ERC20,
                    collateralTokenId: 0,
                    collateralQuantity: 0,
                    allowsPartialRepay: false
                })
            );
            vm.stopBroadcast();
            console.log("Lender rental offer (ERC721):", offerId12);

            // Borrower accepts: prepay = DAILY_FEE * 7 days + 5% buffer
            // prepay = 10e6 * 7 = 70e6, buffer = 70e6 * 5% = 3.5e6, total = 73.5e6
            uint256 totalPrepay12 = DAILY_FEE * 7 + (DAILY_FEE * 7 * 500) / 10000;
            vm.startBroadcast(newBorrowerKey);
            usdc.approve(diamond, totalPrepay12);
            uint256 loanId12 = OfferFacet(diamond).acceptOffer(offerId12, true);
            vm.stopBroadcast();
            console.log("Rental loan initiated, loanId:", loanId12);

            // Borrower repays rental (settles the rental period)
            vm.startBroadcast(newBorrowerKey);
            RepayFacet(diamond).repayLoan(loanId12);
            vm.stopBroadcast();
            console.log("Rental repaid");

            // Claims: lender gets rental fees + NFT back, borrower gets unused prepay refund
            vm.startBroadcast(newLenderKey);
            ClaimFacet(diamond).claimAsLender(loanId12);
            vm.stopBroadcast();
            vm.startBroadcast(newBorrowerKey);
            ClaimFacet(diamond).claimAsBorrower(loanId12);
            vm.stopBroadcast();
            console.log("Both parties claimed for loanId:", loanId12);
            console.log(">>> SCENARIO 12 PASSED <<<");
        }

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 13: NFT ERC1155 Renting
        //   Lender offers ERC1155 for rent, borrower prepays rental fees
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 13: NFT ERC1155 Renting ===");
        {
            // Lender creates rental offer: lend ERC1155 (tokenId=1, qty=5), daily fee=5 USDC, 7 days
            uint256 dailyFee1155 = 5e6;
            vm.startBroadcast(newLenderKey);
            nft1155.setApprovalForAll(diamond, true);
            uint256 offerId13 = OfferFacet(diamond).createOffer(
                LibVaipakam.CreateOfferParams({
                    offerType: LibVaipakam.OfferType.Lender,
                    lendingAsset: address(nft1155),
                    amount: dailyFee1155,        // daily rental fee
                    interestRateBps: 0,
                    // Rentals don't use collateral; use the prepay token
                    // (usdc) as a non-zero, distinct placeholder so the
                    // SelfCollateralizedOffer check passes.
                    collateralAsset: address(usdc),
                    collateralAmount: 0,
                    durationDays: 7,
                    assetType: LibVaipakam.AssetType.ERC1155,
                    tokenId: 1,
                    quantity: 5,
                    creatorFallbackConsent: true,
                    prepayAsset: address(usdc),
                    collateralAssetType: LibVaipakam.AssetType.ERC20,
                    collateralTokenId: 0,
                    collateralQuantity: 0,
                    allowsPartialRepay: false
                })
            );
            vm.stopBroadcast();
            console.log("Lender rental offer (ERC1155):", offerId13);

            // Borrower accepts: prepay = 5e6 * 7 + 5% buffer
            uint256 totalPrepay13 = dailyFee1155 * 7 + (dailyFee1155 * 7 * 500) / 10000;
            vm.startBroadcast(newBorrowerKey);
            usdc.approve(diamond, totalPrepay13);
            uint256 loanId13 = OfferFacet(diamond).acceptOffer(offerId13, true);
            vm.stopBroadcast();
            console.log("Rental loan initiated, loanId:", loanId13);

            // Borrower repays rental
            vm.startBroadcast(newBorrowerKey);
            RepayFacet(diamond).repayLoan(loanId13);
            vm.stopBroadcast();
            console.log("Rental repaid");

            // Claims
            vm.startBroadcast(newLenderKey);
            ClaimFacet(diamond).claimAsLender(loanId13);
            vm.stopBroadcast();
            vm.startBroadcast(newBorrowerKey);
            ClaimFacet(diamond).claimAsBorrower(loanId13);
            vm.stopBroadcast();
            console.log("Both parties claimed for loanId:", loanId13);
            console.log(">>> SCENARIO 13 PASSED <<<");
        }

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 14: Illiquid ERC20 Lending + Illiquid ERC20 Collateral
        //   Both assets illiquid, both parties consent, no LTV/HF checks
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 14: Illiquid Lending + Illiquid Collateral ===");

        // illiquidLending was deployed in Phase 1a (see note there about
        // forge's broadcast pre-check).

        // Lender creates offer: lend illiquidLending, collateral = illiquidToken
        vm.startBroadcast(lenderKey);
        illiquidLending.approve(diamond, 500e18);
        uint256 offerId14 = OfferFacet(diamond).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(illiquidLending),
                amount: 500e18,            // 500 ILLEND tokens
                interestRateBps: INTEREST_BPS,
                collateralAsset: address(illiquidToken),
                collateralAmount: 1000e18, // 1000 ILLIQ tokens
                durationDays: DURATION_DAYS,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(illiquidLending),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false
            })
        );
        vm.stopBroadcast();
        console.log("Lender offer (both illiquid):", offerId14);

        // Borrower accepts with illiquid consent
        vm.startBroadcast(borrowerKey);
        illiquidToken.approve(diamond, 1000e18);
        uint256 loanId14 = OfferFacet(diamond).acceptOffer(offerId14, true);
        vm.stopBroadcast();
        console.log("Loan initiated, loanId:", loanId14);

        // Borrower repays with illiquidLending tokens
        vm.startBroadcast(borrowerKey);
        illiquidLending.approve(diamond, 600e18); // generous approval for principal + interest
        RepayFacet(diamond).repayLoan(loanId14);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId14);
        console.log(">>> SCENARIO 14 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO 15: Illiquid ERC20 Lending + Liquid ERC20 Collateral
        //   Illiquid lending asset, liquid WETH collateral
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO 15: Illiquid Lending + Liquid Collateral ===");

        // Lender creates offer: lend illiquidToken, collateral = WETH (liquid)
        vm.startBroadcast(lenderKey);
        illiquidToken.approve(diamond, 200e18);
        uint256 offerId15 = OfferFacet(diamond).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(illiquidToken),
                amount: 200e18,
                interestRateBps: INTEREST_BPS,
                collateralAsset: address(weth),
                collateralAmount: COLLATERAL_AMOUNT, // 1 WETH
                durationDays: DURATION_DAYS,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: address(illiquidToken),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false
            })
        );
        vm.stopBroadcast();
        console.log("Lender offer (illiquid lending, liquid collateral):", offerId15);

        // Borrower accepts with illiquid consent
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId15 = OfferFacet(diamond).acceptOffer(offerId15, true);
        vm.stopBroadcast();
        console.log("Loan initiated, loanId:", loanId15);

        // Borrower repays with illiquidToken
        vm.startBroadcast(borrowerKey);
        illiquidToken.approve(diamond, 300e18); // generous approval
        RepayFacet(diamond).repayLoan(loanId15);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId15);
        console.log(">>> SCENARIO 15 PASSED <<<");

        // ════════════════════════════════════════════════════════════════
        // FINAL SUMMARY
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("============================================");
        console.log("  ALL 15 POSITIVE FLOW SCENARIOS PASSED!");
        console.log("============================================");
        console.log("Scenarios 1-8:  Liquid ERC20 flows");
        console.log("Scenario 9:     Illiquid ERC20 collateral");
        console.log("Scenario 10:    NFT ERC721 collateral");
        console.log("Scenario 11:    NFT ERC1155 collateral");
        console.log("Scenario 12:    NFT ERC721 renting");
        console.log("Scenario 13:    NFT ERC1155 renting");
        console.log("Scenario 14:    Illiquid lending + illiquid collateral");
        console.log("Scenario 15:    Illiquid lending + liquid collateral");
    }

    // ══════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ══════════════════════════════════════════════════════════════════

    function _fundIfNeeded(address acct, uint256 amount) internal {
        if (acct.balance < amount) {
            payable(acct).transfer(amount);
            console.log("Funded", acct);
        }
    }

    function _setCountryIfNeeded(uint256 key, address acct, string memory country) internal {
        if (bytes(ProfileFacet(diamond).getUserCountry(acct)).length == 0) {
            vm.startBroadcast(key);
            ProfileFacet(diamond).setUserCountry(country);
            vm.stopBroadcast();
        }
    }

    function _lenderOfferParams() internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: address(usdc),
            amount: LOAN_AMOUNT,
            interestRateBps: INTEREST_BPS,
            collateralAsset: address(weth),
            collateralAmount: COLLATERAL_AMOUNT,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorFallbackConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false
        });
    }

    function _borrowerOfferParams() internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: address(usdc),
            amount: LOAN_AMOUNT,
            interestRateBps: INTEREST_BPS,
            collateralAsset: address(weth),
            collateralAmount: COLLATERAL_AMOUNT,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorFallbackConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false
        });
    }

    function _createLenderOffer(uint256 key, address acct) internal returns (uint256 offerId) {
        vm.startBroadcast(key);
        usdc.approve(diamond, LOAN_AMOUNT);
        offerId = OfferFacet(diamond).createOffer(_lenderOfferParams());
        vm.stopBroadcast();
        console.log("Lender offer created:", offerId);
    }

    function _acceptOffer(uint256 key, address acct, uint256 offerId) internal returns (uint256 loanId) {
        vm.startBroadcast(key);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        loanId = OfferFacet(diamond).acceptOffer(offerId, true);
        vm.stopBroadcast();
    }

    function _claimBoth(uint256 lKey, uint256 bKey, uint256 loanId) internal {
        vm.startBroadcast(lKey);
        ClaimFacet(diamond).claimAsLender(loanId);
        vm.stopBroadcast();
        vm.startBroadcast(bKey);
        ClaimFacet(diamond).claimAsBorrower(loanId);
        vm.stopBroadcast();
        console.log("Both parties claimed for loanId:", loanId);
    }

    function _scenario_lenderOffer_borrowerAccepts_repay_claim(
        uint256 lKey, address lAddr, uint256 bKey, address bAddr
    ) internal returns (uint256 loanId) {
        uint256 offerId = _createLenderOffer(lKey, lAddr);
        loanId = _acceptOffer(bKey, bAddr, offerId);
        console.log("Loan initiated, loanId:", loanId);

        // Verify loan
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        console.log("Loan active:", loan.status == LibVaipakam.LoanStatus.Active ? "YES" : "NO");

        // Repay
        vm.startBroadcast(bKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        console.log("Repayment amount:", repayAmt);
        usdc.approve(diamond, repayAmt);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        console.log("Loan repaid");

        _claimBoth(lKey, bKey, loanId);
    }
}
