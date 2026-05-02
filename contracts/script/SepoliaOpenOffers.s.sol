// script/SepoliaOpenOffers.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title SepoliaOpenOffers
 * @notice Seeds the deployed Sepolia Diamond with a spread of OPEN offers so
 *         the OfferBook has browsable inventory after earlier positive-flow
 *         runs consumed everything. Zero accepts: every offer stays open
 *         (lender offers sit with lending funds escrowed via the Diamond's
 *         transferFrom approval; borrower offers sit with collateral locked
 *         in the borrower's per-user escrow).
 *
 *         Accounts mirror SepoliaActiveLoan — lender creates lender offers,
 *         borrower creates borrower offers, admin signs role-gated config.
 *         Oracle/risk/KYC setters are idempotent, so re-running after a
 *         prior seed just lays down more offers on top.
 *
 *         The Diamond address is resolved from `block.chainid` against the
 *         per-chain env vars below — so a single `--rpc-url` flip targets
 *         the correct deploy without touching any other env.
 *
 * Env:
 *   SEPOLIA_DIAMOND_ADDRESS       (chainId 11155111)
 *   BASE_SEPOLIA_DIAMOND_ADDRESS  (chainId 84532)
 *   OP_SEPOLIA_DIAMOND_ADDRESS    (chainId 11155420)
 *   ARB_SEPOLIA_DIAMOND_ADDRESS   (chainId 421614)
 *   POLYGON_AMOY_DIAMOND_ADDRESS  (chainId 80002)
 *   DIAMOND_ADDRESS               — optional fallback for unknown chains
 *   PRIVATE_KEY (deployer), ADMIN_PRIVATE_KEY, ADMIN_ADDRESS,
 *   LENDER_PRIVATE_KEY, LENDER_ADDRESS, BORROWER_PRIVATE_KEY, BORROWER_ADDRESS
 */
contract SepoliaOpenOffers is Script {
    address diamond;
    uint256 deployerKey;
    uint256 adminKey;
    address admin;
    uint256 lenderKey;
    address lender;
    uint256 borrowerKey;
    address borrower;

    ERC20Mock usdc;
    ERC20Mock weth;

    // Per-tier parameters are deliberately varied (principal / rate / duration)
    // so the OfferBook reads as a real market rather than a cloned-row dump.
    // All LTVs are ~50% against the $2000 mock WETH feed — well clear of the
    // MIN_HEALTH_FACTOR=1.5e18 gate so the offers are actually acceptable.
    struct OfferTier {
        uint256 principal;      // mUSDC (6 decimals)
        uint256 collateral;     // mWETH (18 decimals)
        uint16 interestBps;
        uint16 durationDays;
    }

    function run() external {
        diamond = _resolveDiamond();
        deployerKey = vm.envUint("PRIVATE_KEY");
        adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        admin = vm.envAddress("ADMIN_ADDRESS");
        lenderKey = vm.envUint("LENDER_PRIVATE_KEY");
        lender = vm.envAddress("LENDER_ADDRESS");
        borrowerKey = vm.envUint("BORROWER_PRIVATE_KEY");
        borrower = vm.envAddress("BORROWER_ADDRESS");

        console.log("=== Sepolia Open-Offer Seeder ===");
        console.log("Diamond: ", diamond);
        console.log("Lender:  ", lender);
        console.log("Borrower:", borrower);

        // ── Deployer: mocks + mints + mock oracle infra ─────────────────
        // Fresh mock USDC/WETH pair per run. Re-using an earlier seeder's
        // tokens would be nice, but requires threading their addresses via
        // env — more ops friction than re-deploying a trivial ERC20Mock.
        vm.startBroadcast(deployerKey);

        usdc = new ERC20Mock("Mock USDC", "mUSDC", 6);
        weth = new ERC20Mock("Mock WETH", "mWETH", 18);
        console.log("mUSDC:", address(usdc));
        console.log("mWETH:", address(weth));

        // Mint enough headroom for every lender offer's escrowed principal +
        // every borrower offer's locked collateral, with room to spare so the
        // operator can re-run without topping up.
        usdc.mint(lender, 50_000e6);
        usdc.mint(borrower, 10_000e6);  // for borrower-side prepay if needed
        weth.mint(lender, 10e18);
        weth.mint(borrower, 20e18);

        MockChainlinkRegistry registry = new MockChainlinkRegistry();
        MockChainlinkFeed usdcFeed = new MockChainlinkFeed(1e8, 8);
        MockChainlinkFeed wethFeed = new MockChainlinkFeed(2000e8, 8);
        address USD_DENOM = 0x0000000000000000000000000000000000000348;
        registry.setFeed(address(usdc), USD_DENOM, address(usdcFeed));
        registry.setFeed(address(weth), USD_DENOM, address(wethFeed));

        MockUniswapV3Factory univ3Factory = new MockUniswapV3Factory();
        // sqrtPriceX96 = 2^96 (price = 1). Pool liquidity 1e24 clears the
        // MIN_LIQUIDITY_USD floor by several orders of magnitude — mUSDC +
        // mWETH both classify Liquid.
        univ3Factory.createPool(address(usdc), address(weth), 3000, 79228162514264337593543950336, 1e24);
        vm.stopBroadcast();

        // ── Admin: gas funding + Diamond config (idempotent setters) ────
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

        // ── Create the open-offer spread ────────────────────────────────
        // Three lender tiers + two borrower tiers. All LTVs sit at ~50%
        // against the mock $2000 WETH feed; interest/duration vary so the
        // book surface shows meaningful spread on every column.
        OfferTier[3] memory lenderTiers = [
            OfferTier({ principal: 500e6,  collateral: 0.5e18, interestBps: 500,  durationDays: 7   }),
            OfferTier({ principal: 1_000e6, collateral: 1e18,   interestBps: 800,  durationDays: 30  }),
            OfferTier({ principal: 2_000e6, collateral: 2e18,   interestBps: 1200, durationDays: 90  })
        ];
        OfferTier[2] memory borrowerTiers = [
            OfferTier({ principal: 600e6,   collateral: 0.6e18, interestBps: 600,  durationDays: 14 }),
            OfferTier({ principal: 1_400e6, collateral: 1.5e18, interestBps: 1000, durationDays: 60 })
        ];

        console.log("");
        console.log("--- Lender offers (principal escrowed via approval) ---");
        for (uint256 i = 0; i < lenderTiers.length; i++) {
            uint256 id = _createLenderOffer(lenderTiers[i]);
            console.log("Lender offer", i + 1, " id:", id);
        }

        console.log("");
        console.log("--- Borrower offers (collateral locked in escrow) ---");
        for (uint256 i = 0; i < borrowerTiers.length; i++) {
            uint256 id = _createBorrowerOffer(borrowerTiers[i]);
            console.log("Borrower offer", i + 1, " id:", id);
        }

        console.log("");
        console.log(">>> Seeded 5 open offers (3 lender + 2 borrower). OfferBook should now show inventory. <<<");
    }

    // ── Offer factories ─────────────────────────────────────────────────

    function _createLenderOffer(OfferTier memory t) internal returns (uint256 offerId) {
        vm.startBroadcast(lenderKey);
        // Lender offers don't pre-transfer principal — the Diamond pulls it at
        // acceptOffer time via `transferFrom`. So approval is all that's
        // needed for the offer to be acceptable later.
        usdc.approve(diamond, t.principal);
        offerId = OfferFacet(diamond).createOffer(LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: address(usdc),
            amount: t.principal,
            interestRateBps: t.interestBps,
            collateralAsset: address(weth),
            collateralAmount: t.collateral,
            durationDays: t.durationDays,
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
        }));
        vm.stopBroadcast();
    }

    function _createBorrowerOffer(OfferTier memory t) internal returns (uint256 offerId) {
        vm.startBroadcast(borrowerKey);
        // Borrower offers lock collateral immediately — the Diamond pulls WETH
        // into the borrower's per-user escrow at createOffer so the commitment
        // is real by the time a lender browses the book.
        weth.approve(diamond, t.collateral);
        offerId = OfferFacet(diamond).createOffer(LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: address(usdc),
            amount: t.principal,
            interestRateBps: t.interestBps,
            collateralAsset: address(weth),
            collateralAmount: t.collateral,
            durationDays: t.durationDays,
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
        }));
        vm.stopBroadcast();
    }

    /**
     * @dev Picks the Diamond address for the currently-broadcasting chain from
     *      the per-chain `<CHAIN>_DIAMOND_ADDRESS` env var. Falls back to
     *      `DIAMOND_ADDRESS` for unknown chainids so ad-hoc local/fork runs
     *      still work. Reverts loudly if neither is set — better than silently
     *      calling an empty address and surfacing "call to non-contract".
     */
    function _resolveDiamond() internal view returns (address addr) {
        // Primary: deployments/<chain>/addresses.json (written by
        // DeployDiamond). Secondary: chain-prefixed env (`SEPOLIA_…`)
        // via `Deployments.readDiamond`'s envPrefix path. Tertiary:
        // bare DIAMOND_ADDRESS for legacy operator runs that still
        // export the unprefixed key. The bare-key path stays so an
        // operator who hasn't yet committed addresses.json can still
        // run the seeder manually.
        addr = Deployments.readDiamond();
        if (addr == address(0)) addr = vm.envOr("DIAMOND_ADDRESS", address(0));
        require(
            addr != address(0),
            string(
                abi.encodePacked(
                    "No Diamond address configured for chainid ",
                    vm.toString(block.chainid),
                    ". Run DeployDiamond.s.sol on this chain to populate ",
                    "deployments/<chain>/addresses.json, or set ",
                    "<CHAIN>_DIAMOND_ADDRESS / DIAMOND_ADDRESS in env."
                )
            )
        );
    }

    function _setCountryIfUnset(uint256 key, address acct, string memory code) internal {
        bytes32 existing = keccak256(bytes(ProfileFacet(diamond).getUserCountry(acct)));
        if (existing != keccak256("")) return;
        vm.startBroadcast(key);
        ProfileFacet(diamond).setUserCountry(code);
        vm.stopBroadcast();
    }
}
