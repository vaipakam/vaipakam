// script/BaseSepoliaPartialFlows.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {ERC4907Mock} from "../test/mocks/ERC4907Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title BaseSepoliaPartialFlows
 * @notice Drives a handful of positive flows on the deployed Diamond and
 *         intentionally STOPS each one at a UI-testable midpoint. The
 *         remaining steps are meant to be performed manually through the
 *         frontend so each on-chain surface gets exercised end-to-end.
 *
 *         States left after a successful run:
 *           A. Open lender offer  — accept from the borrower UI.
 *           B. Open borrower offer — accept from the lender UI.
 *           C. Active liquid loan — repay / add collateral / preclose
 *              from the borrower UI; observe HF/LTV from either side.
 *           D. Repaid-but-unclaimed loan — Claim Center on both sides.
 *           E. Active ERC721-collateral loan — NFT collateral surfaces.
 *           F. Active rental loan — rental position UI.
 */
contract BaseSepoliaPartialFlows is Script {
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

    ERC20Mock usdc;
    ERC20Mock weth;
    ERC4907Mock nft721;

    uint256 constant LOAN_AMOUNT = 1_000e6;       // 1000 mUSDC
    uint256 constant COLLATERAL_AMOUNT = 1e18;    // 1 mWETH
    uint256 constant INTEREST_BPS = 500;          // 5% APR
    uint256 constant DURATION_DAYS = 30;
    uint256 constant DAILY_FEE = 10e6;            // 10 mUSDC / day rental

    function run() external {
        diamond = Deployments.readDiamond();
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

        console.log("=== Base Sepolia Partial Flows ===");
        console.log("Diamond:    ", diamond);
        console.log("Lender:     ", lender);
        console.log("Borrower:   ", borrower);
        console.log("NewLender:  ", newLender);
        console.log("NewBorrower:", newBorrower);

        // ── Phase 1a: deployer mocks + mints ────────────────────────────
        vm.startBroadcast(deployerKey);
        usdc = new ERC20Mock("Mock USDC", "mUSDC", 6);
        weth = new ERC20Mock("Mock WETH", "mWETH", 18);
        nft721 = new ERC4907Mock("Rentable NFT 721", "rNFT");
        console.log("mUSDC: ", address(usdc));
        console.log("mWETH: ", address(weth));
        console.log("NFT721:", address(nft721));

        usdc.mint(lender, 100_000e6);
        usdc.mint(borrower, 100_000e6);
        usdc.mint(newLender, 100_000e6);
        usdc.mint(newBorrower, 100_000e6);
        weth.mint(lender, 10e18);
        weth.mint(borrower, 10e18);
        weth.mint(newLender, 10e18);
        weth.mint(newBorrower, 10e18);
        // tokenIds: 100-104 lender, 110-114 borrower, 120-124 newLender, 130-134 newBorrower
        for (uint256 i = 0; i < 5; i++) {
            nft721.mint(lender, 100 + i);
            nft721.mint(borrower, 110 + i);
            nft721.mint(newLender, 120 + i);
            nft721.mint(newBorrower, 130 + i);
        }

        MockChainlinkRegistry registry = new MockChainlinkRegistry();
        MockChainlinkFeed usdcFeed = new MockChainlinkFeed(1e8, 8);
        MockChainlinkFeed wethFeed = new MockChainlinkFeed(2000e8, 8);
        address USD_DENOM = 0x0000000000000000000000000000000000000348;
        registry.setFeed(address(usdc), USD_DENOM, address(usdcFeed));
        registry.setFeed(address(weth), USD_DENOM, address(wethFeed));

        MockUniswapV3Factory univ3Factory = new MockUniswapV3Factory();
        uint160 mockSqrtPriceX96 = 79228162514264337593543950336;
        univ3Factory.createPool(address(usdc), address(weth), 3000, mockSqrtPriceX96, 1e24);
        vm.stopBroadcast();

        // ── Phase 1b: admin role-gated config + gas funding ─────────────
        vm.startBroadcast(adminKey);
        _fundIfNeeded(lender, 0.02 ether);
        _fundIfNeeded(borrower, 0.02 ether);
        _fundIfNeeded(newLender, 0.02 ether);
        _fundIfNeeded(newBorrower, 0.02 ether);

        OracleAdminFacet(diamond).setChainlinkRegistry(address(registry));
        OracleAdminFacet(diamond).setUsdChainlinkDenominator(USD_DENOM);
        OracleAdminFacet(diamond).setWethContract(address(weth));
        OracleAdminFacet(diamond).setEthUsdFeed(address(wethFeed));
        OracleAdminFacet(diamond).setUniswapV3Factory(address(univ3Factory));

        RiskFacet(diamond).updateRiskParams(address(weth), 8000, 8500, 300, 1000);
        RiskFacet(diamond).updateRiskParams(address(usdc), 8000, 8500, 300, 1000);

        ProfileFacet(diamond).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(newLender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(newBorrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).setTradeAllowance("US", "US", true);
        vm.stopBroadcast();

        _setCountryIfUnset(lenderKey, lender, "US");
        _setCountryIfUnset(borrowerKey, borrower, "US");
        _setCountryIfUnset(newLenderKey, newLender, "US");
        _setCountryIfUnset(newBorrowerKey, newBorrower, "US");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO A — Open lender offer (left for borrower to accept)
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO A: Open Lender Offer ===");
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerA = OfferFacet(diamond).createOffer(_lenderOfferParams());
        vm.stopBroadcast();
        console.log("Open lender offer id:", offerA);
        console.log("Action: have a borrower accept this from the UI.");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO B — Open borrower offer (left for lender to accept)
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO B: Open Borrower Offer ===");
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 offerB = OfferFacet(diamond).createOffer(_borrowerOfferParams());
        vm.stopBroadcast();
        console.log("Open borrower offer id:", offerB);
        console.log("Action: have a lender accept this from the UI.");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO C — Active liquid loan (newLender / newBorrower)
        //   Stops with loan in Active state for repay / add-collateral /
        //   preclose / liquidate testing on the Loan Details page.
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO C: Active Liquid Loan ===");
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerC = OfferFacet(diamond).createOffer(_lenderOfferParams());
        vm.stopBroadcast();
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanC = OfferFacet(diamond).acceptOffer(offerC, true);
        vm.stopBroadcast();
        console.log("Active loan id:", loanC);
        console.log("Action: open Loan Details and exercise repay / preclose / etc.");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO D — Repaid-but-unclaimed (lender / borrower)
        //   Stops with funds sitting in Diamond custody so both Claim
        //   Center surfaces have something to act on.
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO D: Repaid-But-Unclaimed Loan ===");
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerD = OfferFacet(diamond).createOffer(_lenderOfferParams());
        vm.stopBroadcast();
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanD = OfferFacet(diamond).acceptOffer(offerD, true);
        vm.stopBroadcast();
        vm.startBroadcast(borrowerKey);
        uint256 repayAmtD = RepayFacet(diamond).calculateRepaymentAmount(loanD);
        usdc.approve(diamond, repayAmtD);
        RepayFacet(diamond).repayLoan(loanD);
        vm.stopBroadcast();
        console.log("Repaid (unclaimed) loan id:", loanD);
        console.log("Action: claim from BOTH lender and borrower sides via Claim Center.");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO E — Active loan with ERC721 collateral
        //   Borrower offer locking an NFT, lender accepts. Stops Active.
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO E: Active ERC721-Collateral Loan ===");
        uint256 nftTokenId = 110; // belongs to borrower
        vm.startBroadcast(borrowerKey);
        nft721.approve(diamond, nftTokenId);
        uint256 offerE = OfferFacet(diamond).createOffer(
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
                collateralTokenId: nftTokenId,
                collateralQuantity: 0,
                allowsPartialRepay: false
            })
        );
        vm.stopBroadcast();
        vm.startBroadcast(lenderKey);
        address lEsc = EscrowFactoryFacet(diamond).getOrCreateUserEscrow(lender);
        usdc.transfer(lEsc, LOAN_AMOUNT);
        uint256 loanE = OfferFacet(diamond).acceptOffer(offerE, true);
        vm.stopBroadcast();
        console.log("Active NFT-collateral loan id:", loanE);
        console.log("Token id locked:", nftTokenId);
        console.log("Action: inspect the NFT collateral surface on Loan Details.");

        // ════════════════════════════════════════════════════════════════
        // SCENARIO F — Active rental loan (newLender lends an NFT)
        //   Borrower has prepaid the full rental fee; the rental position
        //   is live. Stops before borrower repays / claims — the rental
        //   position UI is the test surface.
        // ════════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== SCENARIO F: Active Rental Loan ===");
        uint256 rentTokenId = 120; // belongs to newLender
        vm.startBroadcast(newLenderKey);
        nft721.approve(diamond, rentTokenId);
        uint256 offerF = OfferFacet(diamond).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: address(nft721),
                amount: DAILY_FEE,
                interestRateBps: 0,
                collateralAsset: address(usdc), // placeholder; rentals don't use collateral
                collateralAmount: 0,
                durationDays: 7,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: rentTokenId,
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
        uint256 totalPrepay = DAILY_FEE * 7 + (DAILY_FEE * 7 * 500) / 10000; // 5% buffer
        vm.startBroadcast(newBorrowerKey);
        usdc.approve(diamond, totalPrepay);
        uint256 loanF = OfferFacet(diamond).acceptOffer(offerF, true);
        vm.stopBroadcast();
        console.log("Active rental loan id:", loanF);
        console.log("Rented token id:", rentTokenId);
        console.log("Action: open the rental position page; close it via repay + claim.");

        // ── Summary ─────────────────────────────────────────────────────
        console.log("");
        console.log("================ SUMMARY ================");
        console.log("Mock USDC :", address(usdc));
        console.log("Mock WETH :", address(weth));
        console.log("NFT721    :", address(nft721));
        console.log("");
        console.log("A. Open lender offer    : id", offerA);
        console.log("B. Open borrower offer  : id", offerB);
        console.log("C. Active liquid loan   : id", loanC);
        console.log("D. Repaid-unclaimed loan: id", loanD);
        console.log("E. NFT-collat loan      : id", loanE);
        console.log("F. Active rental loan   : id", loanF);
    }

    // ── Helpers ────────────────────────────────────────────────────────

    function _fundIfNeeded(address acct, uint256 amount) internal {
        if (acct.balance < amount) payable(acct).transfer(amount);
    }

    function _setCountryIfUnset(uint256 key, address acct, string memory code) internal {
        if (bytes(ProfileFacet(diamond).getUserCountry(acct)).length != 0) return;
        vm.startBroadcast(key);
        ProfileFacet(diamond).setUserCountry(code);
        vm.stopBroadcast();
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
}
