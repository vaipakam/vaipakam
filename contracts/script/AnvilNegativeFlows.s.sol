// script/AnvilNegativeFlows.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title AnvilNegativeFlows
 * @notice Negative-path scenarios verified against a freshly-bootstrapped
 *         Anvil diamond. Each NEG-* assertion proves a specific gate
 *         reverts as expected.
 *
 *         Pattern: every negative case uses `vm.prank(<caller>)` +
 *         `address(diamond).call(badCalldata)` OUTSIDE any
 *         `vm.startBroadcast(...)` block. Without `startBroadcast`
 *         the call is simulation-only — forge does NOT add it to the
 *         broadcast tx queue, so the broadcast pre-flight never
 *         re-attempts the failing call (the issue that bit us in
 *         positive-flow N11 / N18 / N19 when we tried to test reverts
 *         inside `vm.startBroadcast`). Each NEG case asserts
 *         `ok == false` via `require(!ok, ...)`.
 *
 *         Setup operations (mocks, KYC, oracle wiring, fresh loan
 *         creation when needed for terminal-path negatives) DO run
 *         inside `vm.startBroadcast` so the live chain reflects the
 *         expected pre-state.
 *
 *         What this file does NOT cover: per-facet revert paths that
 *         are already exhaustively unit-tested in `forge test`. The
 *         goal here is to prove the diamond-routed entry points
 *         enforce gates end-to-end against a real Anvil chain. Per-
 *         facet unit tests use `vm.expectRevert` for fine-grained
 *         message matching; that's the right surface for them.
 *
 *         Mapping to docs/TestScopes/AdvancedUserGuideTestMatrix.md:
 *           NEG-RA1  amountMax < amount        → InvalidAmountRange
 *           NEG-RA2  interestRateBpsMax < bps  → InvalidRateRange
 *           NEG-RA3  rateMax > MAX_INTEREST    → InterestRateAboveCeiling
 *           NEG-2    creatorFallbackConsent=0  → FallbackConsentRequired
 *           NEG-3    lending == collateral     → SelfCollateralizedOffer
 *           NEG-4    durationDays == 0         → InvalidOfferType
 *           NEG-9    lender collateral < floor → MinCollateralBelowFloor
 *           NEG-15   claim before terminal     → not-claimable revert
 *           NEG-20   partial repay when off    → PartialRepayNotAllowed
 */
contract AnvilNegativeFlows is Script {
    address diamond;
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

    uint256 constant LOAN_AMOUNT = 1000e6;
    uint256 constant COLLATERAL_AMOUNT = 1e18;
    uint256 constant INTEREST_BPS = 500;
    uint256 constant DURATION_DAYS = 30;

    function run() external {
        _loadEnv();
        diamond = Deployments.readDiamond();

        console.log("=== Anvil Negative Flows (gate verification) ===");
        console.log("Diamond:    ", diamond);

        _deployMocksAndConfigure();

        _negRA1_amountMaxLessThanAmount();
        _negRA2_rateMaxLessThanRate();
        _negRA3_rateAboveCeiling();
        _neg2_fallbackConsentRequired();
        _neg3_selfCollateralizedOffer();
        _neg4_zeroDuration();
        _neg9_collateralBelowFloor();
        _neg15_claimBeforeTerminal();
        _neg20_partialRepayWhenOff();

        console.log("");
        console.log("============================================");
        console.log("  NEGATIVE FLOWS PASSED:");
        console.log("    NEG-RA1, RA2, RA3, NEG-2, NEG-3, NEG-4, NEG-9, NEG-15, NEG-20");
        console.log("");
        console.log("  Per-facet unit tests cover the rest of the NEG suite:");
        console.log("    OfferFacetTest.t.sol, RangeOffersTest.t.sol,");
        console.log("    RepayFacetTest.t.sol, ClaimFacetTest.t.sol, ConfigFacetTest.t.sol");
        console.log("============================================");
    }

    // ─── Setup ────────────────────────────────────────────────────────────

    function _loadEnv() internal {
        deployerKey = vm.envUint("PRIVATE_KEY");
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
    }

    function _deployMocksAndConfigure() internal {
        vm.startBroadcast(deployerKey);
        usdc = new ERC20Mock("Mock USDC NF", "mUSDCnf", 6);
        weth = new ERC20Mock("Mock WETH NF", "mWETHnf", 18);
        usdc.mint(lender, 100_000e6);
        usdc.mint(borrower, 100_000e6);
        usdc.mint(newLender, 100_000e6);
        usdc.mint(newBorrower, 100_000e6);
        weth.mint(lender, 10e18);
        weth.mint(borrower, 10e18);
        weth.mint(newLender, 10e18);
        weth.mint(newBorrower, 10e18);

        MockChainlinkRegistry registry = new MockChainlinkRegistry();
        MockChainlinkFeed usdcFeed = new MockChainlinkFeed(1e8, 8);
        MockChainlinkFeed wethFeed = new MockChainlinkFeed(2000e8, 8);
        address USD_DENOM = 0x0000000000000000000000000000000000000348;
        registry.setFeed(address(usdc), USD_DENOM, address(usdcFeed));
        registry.setFeed(address(weth), USD_DENOM, address(wethFeed));

        MockUniswapV3Factory univ3 = new MockUniswapV3Factory();
        univ3.createPool(
            address(usdc),
            address(weth),
            3000,
            79228162514264337593543950336,
            1e24
        );
        vm.stopBroadcast();

        vm.startBroadcast(adminKey);
        OracleAdminFacet(diamond).setChainlinkRegistry(address(registry));
        OracleAdminFacet(diamond).setUsdChainlinkDenominator(USD_DENOM);
        OracleAdminFacet(diamond).setWethContract(address(weth));
        OracleAdminFacet(diamond).setEthUsdFeed(address(wethFeed));
        OracleAdminFacet(diamond).setUniswapV3Factory(address(univ3));
        RiskFacet(diamond).updateRiskParams(address(usdc), 8000, 8500, 300, 1000);
        RiskFacet(diamond).updateRiskParams(address(weth), 8000, 8500, 300, 1000);
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

        console.log("Setup OK");
    }

    function _setCountryIfUnset(uint256 key, address user, string memory country) internal {
        string memory cur = ProfileFacet(diamond).getUserCountry(user);
        if (bytes(cur).length == 0) {
            vm.startBroadcast(key);
            ProfileFacet(diamond).setUserCountry(country);
            vm.stopBroadcast();
        }
    }

    // ─── NEG-RA1: amountMax < amount ────────────────────────────────────

    function _negRA1_amountMaxLessThanAmount() internal {
        console.log("");
        console.log("=== NEG-RA1: amountMax < amount reverts ===");
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.amountMax = LOAN_AMOUNT - 1; // amountMax < amount
        bool ok = _simulateCreateOffer(lender, p);
        require(!ok, "NEG-RA1: should revert");
        console.log(">>> NEG-RA1 PASSED <<<");
    }

    // ─── NEG-RA2: interestRateBpsMax < interestRateBps ──────────────────

    function _negRA2_rateMaxLessThanRate() internal {
        console.log("");
        console.log("=== NEG-RA2: interestRateBpsMax < interestRateBps reverts ===");
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.interestRateBpsMax = INTEREST_BPS - 1;
        bool ok = _simulateCreateOffer(lender, p);
        require(!ok, "NEG-RA2: should revert");
        console.log(">>> NEG-RA2 PASSED <<<");
    }

    // ─── NEG-RA3: interestRateBpsMax > MAX_INTEREST_BPS (10000) ─────────

    function _negRA3_rateAboveCeiling() internal {
        console.log("");
        console.log("=== NEG-RA3: rate above MAX_INTEREST_BPS reverts ===");
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.interestRateBpsMax = 10_001; // 100.01% — above ceiling
        bool ok = _simulateCreateOffer(lender, p);
        require(!ok, "NEG-RA3: should revert");
        console.log(">>> NEG-RA3 PASSED <<<");
    }

    // ─── NEG-2: creatorFallbackConsent = false reverts ──────────────────

    function _neg2_fallbackConsentRequired() internal {
        console.log("");
        console.log("=== NEG-2: creatorFallbackConsent=false reverts ===");
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.creatorFallbackConsent = false;
        bool ok = _simulateCreateOffer(lender, p);
        require(!ok, "NEG-2: should revert");
        console.log(">>> NEG-2 PASSED <<<");
    }

    // ─── NEG-3: lendingAsset == collateralAsset reverts ─────────────────

    function _neg3_selfCollateralizedOffer() internal {
        console.log("");
        console.log("=== NEG-3: lendingAsset == collateralAsset reverts ===");
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.collateralAsset = p.lendingAsset; // same asset both sides
        bool ok = _simulateCreateOffer(lender, p);
        require(!ok, "NEG-3: should revert");
        console.log(">>> NEG-3 PASSED <<<");
    }

    // ─── NEG-4: durationDays == 0 reverts ───────────────────────────────

    function _neg4_zeroDuration() internal {
        console.log("");
        console.log("=== NEG-4: durationDays=0 reverts ===");
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.durationDays = 0;
        bool ok = _simulateCreateOffer(lender, p);
        require(!ok, "NEG-4: should revert");
        console.log(">>> NEG-4 PASSED <<<");
    }

    // ─── NEG-9: lender collateralAmount < floor reverts ─────────────────

    function _neg9_collateralBelowFloor() internal {
        console.log("");
        console.log("=== NEG-9: lender offer with collateralAmount < floor reverts ===");
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        // Tiny collateral — way below the floor. With LOAN_AMOUNT=1k USDC,
        // WETH @ $2000, 8500bps liqThreshold, minimum is ~0.59 WETH.
        p.collateralAmount = 1e15; // 0.001 WETH — well below floor
        bool ok = _simulateCreateOffer(lender, p);
        require(!ok, "NEG-9: should revert");
        console.log(">>> NEG-9 PASSED <<<");
    }

    // ─── NEG-15: claim before loan terminates reverts ───────────────────

    function _neg15_claimBeforeTerminal() internal {
        console.log("");
        console.log("=== NEG-15: claim before loan terminates reverts ===");

        // Spin up a fresh active loan.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferFacet(diamond).acceptOffer(offerId, true);
        vm.stopBroadcast();

        // Try claimAsLender on the still-Active loan.
        vm.prank(lender);
        (bool ok, ) = address(diamond).call(
            abi.encodeWithSelector(ClaimFacet.claimAsLender.selector, loanId)
        );
        require(!ok, "NEG-15: claim on Active loan should revert");
        console.log("Loan", loanId, "active; lender claim correctly reverted");
        console.log(">>> NEG-15 PASSED <<<");
    }

    // ─── NEG-20: partial repay when allowsPartialRepay=false reverts ────

    function _neg20_partialRepayWhenOff() internal {
        console.log("");
        console.log("=== NEG-20: partial repay when allowsPartialRepay=false reverts ===");

        // Lender offer WITHOUT allowsPartialRepay opt-in.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.allowsPartialRepay = false;
        uint256 offerId = OfferFacet(diamond).createOffer(p);
        vm.stopBroadcast();

        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferFacet(diamond).acceptOffer(offerId, true);
        vm.stopBroadcast();

        // Try a partial repay.
        vm.prank(borrower);
        (bool ok, ) = address(diamond).call(
            abi.encodeWithSelector(
                RepayFacet.repayPartial.selector,
                loanId,
                LOAN_AMOUNT / 5
            )
        );
        require(!ok, "NEG-20: partial repay without opt-in should revert");
        console.log("Loan", loanId, "rejects repayPartial as expected");
        console.log(">>> NEG-20 PASSED <<<");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    /// @dev Simulation-only createOffer attempt. NOT wrapped in
    ///      vm.startBroadcast so forge does not enqueue this call as
    ///      a broadcast tx — the failing call lives entirely in the
    ///      simulation phase.
    function _simulateCreateOffer(
        address caller,
        LibVaipakam.CreateOfferParams memory p
    ) internal returns (bool ok) {
        vm.prank(caller);
        (ok, ) = address(diamond).call(
            abi.encodeWithSelector(OfferFacet.createOffer.selector, p)
        );
    }

    function _lenderOfferStandard() internal view returns (LibVaipakam.CreateOfferParams memory) {
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
            allowsPartialRepay: false,
            amountMax: 0,
            interestRateBpsMax: 0,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
        });
    }
}
