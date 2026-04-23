// script/SepoliaActiveLoan.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3.sol";

/**
 * @title SepoliaActiveLoan
 * @notice Minimal positive-flow driver that leaves exactly ONE active loan
 *         on the deployed Sepolia Diamond so the frontend dashboard can be
 *         eyeballed against real state. Flow:
 *           1) Admin: fund gas, deploy mock USDC/WETH, configure oracle +
 *              risk params + KYC + trade allowance.
 *           2) Lender: createOffer (1000 mUSDC, 30-day term, 5% APR).
 *           3) Borrower: acceptOffer with 1 mWETH collateral.
 *         After the run, the loan is Active — both NFTs held by their
 *         originators so the Dashboard shows the position for both sides.
 */
contract SepoliaActiveLoan is Script {
    address diamond;
    uint256 deployerKey;
    uint256 adminKey;
    uint256 lenderKey;
    address lender;
    uint256 borrowerKey;
    address borrower;

    ERC20Mock usdc;
    ERC20Mock weth;

    uint256 constant LOAN_AMOUNT = 1_000e6;       // 1000 mUSDC
    uint256 constant COLLATERAL_AMOUNT = 1e18;    // 1 mWETH (~$2000 @ $2000/ETH)

    function run() external {
        diamond = vm.envAddress("DIAMOND_ADDRESS");
        // Phase-1 2-EOA topology: deployerKey funds + deploys mocks,
        // adminKey signs role-gated Diamond calls.
        deployerKey = vm.envUint("PRIVATE_KEY");
        adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        lenderKey = vm.envUint("LENDER_PRIVATE_KEY");
        lender = vm.envAddress("LENDER_ADDRESS");
        borrowerKey = vm.envUint("BORROWER_PRIVATE_KEY");
        borrower = vm.envAddress("BORROWER_ADDRESS");

        console.log("Diamond:", diamond);
        console.log("Lender: ", lender);
        console.log("Borrower:", borrower);

        // ── Deployer: mocks + mints + mock oracle infra ─────────────────
        // Account gas funding moved to admin below (deployer may be thin
        // on ETH post-handover; admin holds the operational budget).
        vm.startBroadcast(deployerKey);

        usdc = new ERC20Mock("Mock USDC", "mUSDC", 6);
        weth = new ERC20Mock("Mock WETH", "mWETH", 18);
        console.log("mUSDC:", address(usdc));
        console.log("mWETH:", address(weth));

        usdc.mint(lender, 10_000e6);
        weth.mint(borrower, 5e18);

        MockChainlinkRegistry registry = new MockChainlinkRegistry();
        MockChainlinkFeed usdcFeed = new MockChainlinkFeed(1e8, 8);
        MockChainlinkFeed wethFeed = new MockChainlinkFeed(2000e8, 8);
        address USD_DENOM = 0x0000000000000000000000000000000000000348;
        registry.setFeed(address(usdc), USD_DENOM, address(usdcFeed));
        registry.setFeed(address(weth), USD_DENOM, address(wethFeed));

        // Mock v3-style AMM infra: factory + mUSDC/mWETH 0.3% pool above the
        // MIN_LIQUIDITY_USD threshold so OracleFacet._checkLiquidity
        // classifies both assets Liquid. sqrtPriceX96 is non-zero; the
        // pool-depth check uses `liquidity() * ethUsd` which with 1e24
        // liquidity and 2000e8 ETH clears the 1e12 floor with huge margin.
        MockUniswapV3Factory univ3Factory = new MockUniswapV3Factory();
        uint160 mockSqrtPriceX96 = 79228162514264337593543950336; // 2^96, price = 1
        univ3Factory.createPool(address(usdc), address(weth), 3000, mockSqrtPriceX96, 1e24);
        vm.stopBroadcast();

        // ── Admin: account funding + role-gated Diamond config ──────────
        vm.startBroadcast(adminKey);
        if (lender.balance < 0.05 ether) payable(lender).transfer(0.05 ether);
        if (borrower.balance < 0.05 ether) payable(borrower).transfer(0.05 ether);
        OracleAdminFacet(diamond).setChainlinkRegistry(address(registry));
        OracleAdminFacet(diamond).setUsdChainlinkDenominator(USD_DENOM);
        OracleAdminFacet(diamond).setWethContract(address(weth));
        OracleAdminFacet(diamond).setEthUsdFeed(address(wethFeed));
        OracleAdminFacet(diamond).setUniswapV3Factory(address(univ3Factory));

        RiskFacet(diamond).updateRiskParams(address(weth), 8000, 8500, 300, 1000);
        RiskFacet(diamond).updateRiskParams(address(usdc), 8000, 8500, 300, 1000);

        ProfileFacet(diamond).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).setTradeAllowance("US", "US", true);
        vm.stopBroadcast();

        _setCountryIfUnset(lenderKey, lender, "US");
        _setCountryIfUnset(borrowerKey, borrower, "US");

        // ── Lender creates offer ────────────────────────────────────────
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferFacet(diamond).createOffer(_offerParams());
        vm.stopBroadcast();
        console.log("Offer created:", offerId);

        // ── Borrower accepts ────────────────────────────────────────────
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferFacet(diamond).acceptOffer(offerId, true);
        vm.stopBroadcast();

        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        console.log("Loan ID:", loanId);
        console.log("Active:", loan.status == LibVaipakam.LoanStatus.Active ? "YES" : "NO");
        console.log("");
        console.log(">>> Active loan left on-chain for dashboard verification <<<");
    }

    function _setCountryIfUnset(uint256 key, address acct, string memory code) internal {
        bytes32 existing = keccak256(bytes(ProfileFacet(diamond).getUserCountry(acct)));
        if (existing != keccak256("")) return; // already registered
        vm.startBroadcast(key);
        ProfileFacet(diamond).setUserCountry(code);
        vm.stopBroadcast();
    }

    function _offerParams() internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: address(usdc),
            amount: LOAN_AMOUNT,
            interestRateBps: 500,
            collateralAsset: address(weth),
            collateralAmount: COLLATERAL_AMOUNT,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorFallbackConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            keeperAccessEnabled: false
        });
    }
}
