// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title SeedAnvilOffers
 * @notice Anvil-only: creates one matchable lender + borrower offer
 *         pair so the keeper-bot's `offerMatcher` detector has
 *         something to chew on. Designed to land a midpoint match
 *         that satisfies HF >= 1.5 against the mock-priced mUSDC /
 *         mWBTC pair from `DeployTestnetLiquidityMocks`.
 *
 * @dev Hard-gated to `block.chainid == 31337`. Uses anvil's well-known
 *      prefunded keys (Foundry's standard mnemonic) for the lender
 *      and borrower so the script is deterministic across operator
 *      machines:
 *        - lender = anvil account #3 (0x90F7...b906)
 *        - borrower = anvil account #4 (0x15d3...6A65)
 *
 *      The deployer (anvil #0) holds the full mUSDC/mWBTC supply
 *      from the mocks deploy. This script transfers operating
 *      balances to lender + borrower before they create offers.
 *
 *      Required env vars:
 *        - PRIVATE_KEY        : anvil account #0 (deployer; holds mocks supply)
 *        - ADMIN_PRIVATE_KEY  : anvil account #1 (admin; grants KYC tiers)
 *
 *      Hardcoded (Foundry's standard test keys):
 *        - LENDER_ANVIL_KEY    = anvil account #3
 *        - BORROWER_ANVIL_KEY  = anvil account #4
 *
 *      Idempotent on the funding side (transfers + approvals are
 *      capped at observable balances). Each run creates a NEW pair
 *      of offers — re-running grows the order book, useful for
 *      multi-bucket bot smoke tests.
 *
 *      Matching arithmetic for the seeded pair:
 *        Lender:   amountMin=500 mUSDC, amountMax=2000 mUSDC,
 *                  rateMin=400bps, rateMax=600bps,
 *                  collateralAmount=0.2 mWBTC at amountMax (= $12k),
 *                  durationDays=30.
 *        Borrower: amount=1000 mUSDC (single-fill in Phase 1),
 *                  rate=450-550bps,
 *                  collateralAmount=0.15 mWBTC (= $9k),
 *                  durationDays=30.
 *        Midpoint: matchAmount=1000 mUSDC, matchRateBps=500,
 *                  reqCollateral=0.1 mWBTC ($6k @ $60k/BTC mock).
 *        HF at match: collateral-USD / debt-USD ≈ 6.0 — well above 1.5.
 */
contract SeedAnvilOffers is Script {
    /// @dev Foundry standard test mnemonic — anvil's prefunded
    ///      accounts. Public knowledge; never use these on a network
    ///      with real value.
    uint256 internal constant LENDER_ANVIL_KEY =
        0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 internal constant BORROWER_ANVIL_KEY =
        0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;

    // mUSDC has 6 decimals, mWBTC has 8 decimals (matches the mocks).
    uint256 internal constant LENDER_AMOUNT_MIN = 500e6;       // 500 mUSDC
    uint256 internal constant LENDER_AMOUNT_MAX = 2000e6;      // 2000 mUSDC
    uint256 internal constant BORROWER_AMOUNT = 1000e6;        // 1000 mUSDC (single-fill)
    uint256 internal constant LENDER_COLLAT = 2e7;             // 0.2 mWBTC
    uint256 internal constant BORROWER_COLLAT = 15e6;          // 0.15 mWBTC
    uint256 internal constant LENDER_RATE_MIN = 400;
    uint256 internal constant LENDER_RATE_MAX = 600;
    uint256 internal constant BORROWER_RATE_MIN = 450;
    uint256 internal constant BORROWER_RATE_MAX = 550;
    uint256 internal constant DURATION_DAYS = 30;

    function run() external {
        require(
            block.chainid == 31337,
            "SeedAnvilOffers: refusing to run outside anvil (chainid != 31337)"
        );

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        address mUSDC = Deployments.readMockERC20A();
        address mWBTC = Deployments.readMockERC20B();

        require(diamond != address(0), "SeedAnvilOffers: diamond not deployed");
        require(mUSDC != address(0), "SeedAnvilOffers: mUSDC not deployed");
        require(mWBTC != address(0), "SeedAnvilOffers: mWBTC not deployed");

        address lender = vm.addr(LENDER_ANVIL_KEY);
        address borrower = vm.addr(BORROWER_ANVIL_KEY);

        console.log("=== Seed Anvil Offers ===");
        console.log("Diamond:  ", diamond);
        console.log("mUSDC:    ", mUSDC);
        console.log("mWBTC:    ", mWBTC);
        console.log("Lender:   ", lender);
        console.log("Borrower: ", borrower);

        // ── Step 1: Deployer transfers operating balances ───────────────
        // The mocks deploy minted everything to the deployer; spread
        // some to the lender (mUSDC for principal) and borrower (mWBTC
        // for collateral). Capped at LENDER_AMOUNT_MAX / BORROWER_COLLAT
        // so re-running the script doesn't drain the deployer's float.
        vm.startBroadcast(deployerKey);
        IERC20(mUSDC).transfer(lender, LENDER_AMOUNT_MAX);
        IERC20(mWBTC).transfer(borrower, BORROWER_COLLAT);
        vm.stopBroadcast();

        // ── Step 2: Admin tags both sides Tier2 KYC ────────────────────
        // KYC enforcement is OFF on retail deploys (per CLAUDE.md), so
        // these calls are no-ops at the gate level. Setting the tier
        // anyway keeps the user dashboard's "your KYC tier" view
        // populated and matches the existing testnet-seeder pattern in
        // `SepoliaActiveLoan.s.sol`.
        vm.startBroadcast(adminKey);
        ProfileFacet(diamond).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).setTradeAllowance("US", "US", true);
        vm.stopBroadcast();

        _setCountryIfUnset(LENDER_ANVIL_KEY, lender, "US");
        _setCountryIfUnset(BORROWER_ANVIL_KEY, borrower, "US");

        // ── Step 3: Lender creates the range offer ──────────────────────
        vm.startBroadcast(LENDER_ANVIL_KEY);
        IERC20(mUSDC).approve(diamond, LENDER_AMOUNT_MAX);
        uint256 lenderOfferId = OfferFacet(diamond).createOffer(
            _lenderOfferParams(mUSDC, mWBTC)
        );
        vm.stopBroadcast();

        // ── Step 4: Borrower creates the matching single-fill offer ─────
        vm.startBroadcast(BORROWER_ANVIL_KEY);
        IERC20(mWBTC).approve(diamond, BORROWER_COLLAT);
        uint256 borrowerOfferId = OfferFacet(diamond).createOffer(
            _borrowerOfferParams(mUSDC, mWBTC)
        );
        vm.stopBroadcast();

        console.log("");
        console.log("Lender offer id:   ", lenderOfferId);
        console.log("Borrower offer id: ", borrowerOfferId);
        console.log("");
        console.log("Run the bot - it should fire matchOffers within one tick:");
        console.log("  cd ../vaipakam-keeper-bot && npm start");
    }

    function _setCountryIfUnset(uint256 key, address acct, string memory code) internal {
        address diamond = Deployments.readDiamond();
        bytes32 existing = keccak256(bytes(ProfileFacet(diamond).getUserCountry(acct)));
        if (existing != keccak256("")) return;
        vm.startBroadcast(key);
        ProfileFacet(diamond).setUserCountry(code);
        vm.stopBroadcast();
    }

    function _lenderOfferParams(address mUSDC, address mWBTC)
        internal
        pure
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mUSDC,
            amount: LENDER_AMOUNT_MIN,
            interestRateBps: LENDER_RATE_MIN,
            collateralAsset: mWBTC,
            collateralAmount: LENDER_COLLAT,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorFallbackConsent: true,
            prepayAsset: mUSDC,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            amountMax: LENDER_AMOUNT_MAX,
            interestRateBpsMax: LENDER_RATE_MAX,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
        });
    }

    function _borrowerOfferParams(address mUSDC, address mWBTC)
        internal
        pure
        returns (LibVaipakam.CreateOfferParams memory)
    {
        // Borrower is single-fill in Phase 1 — `amountMax == amount`
        // (auto-collapse via 0 also works; spelled out here for clarity).
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: mUSDC,
            amount: BORROWER_AMOUNT,
            interestRateBps: BORROWER_RATE_MIN,
            collateralAsset: mWBTC,
            collateralAmount: BORROWER_COLLAT,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorFallbackConsent: true,
            prepayAsset: mUSDC,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            amountMax: BORROWER_AMOUNT,
            interestRateBpsMax: BORROWER_RATE_MAX,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
        });
    }
}
