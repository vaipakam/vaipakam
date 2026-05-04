// script/AnvilNewPartialFlows.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title AnvilNewPartialFlows
 * @notice UI-testable midpoint states for the Vaipakam Diamond. Each
 *         scenario walks through the chain to a specific MID-CYCLE
 *         state and stops there, leaving the chain ready for manual
 *         frontend / hf-watcher / keeper-bot inspection.
 *
 *         Anvil --broadcast cannot advance chain time mid-script,
 *         so partial states that require time elapse (defaulted
 *         loans, periodic-interest overdue, post-cooldown windows,
 *         HF-watcher warning band) are deferred to unit tests.
 *
 *         Run order: anvil-bootstrap.sh first, then this script.
 *         AnvilNewPositiveFlows.s.sol can run before this script —
 *         the partial-flow scenarios use fresh participants /
 *         allowances so they don't conflict with positive-flow
 *         end-state.
 *
 *         Scope (each cell maps to a row in
 *         `docs/TestScopes/AdvancedUserGuideTestMatrix.md`):
 *           P-G  3 offer states: fully-filled, partial-filled (open)
 *           P-N  Loan with one partial-repay applied, principal
 *                reduced, status still Active
 *           P-O  Loan with collateral doubled mid-flight
 *           P-P  Keeper enabled with INIT_PRECLOSE on an active loan
 *           P-Q  Borrower-side refinance offer posted, no acceptance
 *           P-T  Lender posted createLoanSaleOffer, no buyer yet
 *           P-U  Stray ERC-20 parked in user escrow, recovery NOT
 *                triggered (recovery flow visible in UI)
 *           P-H  1 lender-claimable + 1 borrower-claimable side-by-
 *                side (loan repaid, neither side has claimed)
 *
 *         Skipped on Anvil --broadcast (chain time):
 *           P-B  defaulted loan visible — needs time advance
 *           P-S  offset-offer-NFT-lock — partialFillEnabled cooldown
 *           P-Y  HF in warning band — needs precise oracle drop
 *           P-Z  defaulted but not marked — needs time advance
 *           P-AA periodic interest overdue — needs time advance
 *           P-AF cancel cooldown midpoint — needs 2-min wall-clock
 */
contract AnvilNewPartialFlows is Script {
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

        console.log("=== Anvil New Partial Flows (UI-testable midpoints) ===");
        console.log("Diamond:    ", diamond);

        _deployMocksAndConfigure();

        _scenarioPG_offerStates();
        _scenarioPN_partialRepayMidLoan();
        _scenarioPO_collateralDoubled();
        _scenarioPP_keeperEnabledOnActiveLoan();
        _scenarioPQ_refinanceOfferPosted();
        _scenarioPT_loanSaleOfferPosted();
        _scenarioPU_strayTokenInEscrow();
        _scenarioPH_dualClaimableSideBySide();

        console.log("");
        console.log("============================================");
        console.log("  PARTIAL FLOWS PASSED:  P-G, P-N, P-O, P-P, P-Q, P-U, P-H");
        console.log("  SKIPPED on Anvil:");
        console.log("    P-T -> createLoanSaleOffer pre-existing validation bug; sellLoanViaBuyOffer covered by N15");
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
        usdc = new ERC20Mock("Mock USDC PF", "mUSDCpf", 6);
        weth = new ERC20Mock("Mock WETH PF", "mWETHpf", 18);
        // 100k USDC + 10 WETH per participant — covers ~6 partial scenarios.
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

        console.log("Setup OK: oracle + risk + KYC + countries");
    }

    function _setCountryIfUnset(uint256 key, address user, string memory country) internal {
        string memory cur = ProfileFacet(diamond).getUserCountry(user);
        if (bytes(cur).length == 0) {
            vm.startBroadcast(key);
            ProfileFacet(diamond).setUserCountry(country);
            vm.stopBroadcast();
        }
    }

    // ─── P-G: Offer states (filled, partial-filled) ─────────────────────

    /// @dev Leaves two offers in distinct states for the Offer Book UI:
    ///   - Lender offer fully filled (closed by acceptOffer)
    ///   - Lender RANGE offer partial-filled (amountFilled > 0 < amountMax)
    ///
    /// The "cancelled" leg from the matrix is omitted because the
    /// 5-minute cancel cooldown (gated on partialFillEnabled, which
    /// the bootstrap flips ON) makes cancel-immediately-after-create
    /// fail on Anvil broadcast. OfferFacetCancelCooldownTest covers
    /// the cancel path.
    function _scenarioPG_offerStates() internal {
        console.log("");
        console.log("=== P-G: Offer states (filled + partial-filled) ===");

        // Leg 1: fully-filled lender offer (closed).
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 filledOfferId = OfferFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 filledLoanId = OfferFacet(diamond).acceptOffer(filledOfferId, true);
        vm.stopBroadcast();
        console.log("Filled offer:", filledOfferId, "loan:", filledLoanId);

        // Leg 2: partial-filled range lender offer.
        // Lender posts [1k, 5k] @ 5%. Borrower matches with [1k, 1k] →
        // amountFilled = 1k, amountMax = 5k → still active.
        LibVaipakam.CreateOfferParams memory rangeP = _lenderOfferStandard();
        rangeP.amount = LOAN_AMOUNT;
        rangeP.amountMax = LOAN_AMOUNT * 5;
        // Floor scales with amountMax — provide 5 WETH (above ~4.4 floor).
        rangeP.collateralAmount = 5 * COLLATERAL_AMOUNT;
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT * 5);
        uint256 rangeOfferId = OfferFacet(diamond).createOffer(rangeP);
        vm.stopBroadcast();

        // Borrower posts a [1k, 1k] borrower offer matching at the
        // lower bound; matchOffers fills 1k of the 5k.
        LibVaipakam.CreateOfferParams memory bP = _borrowerOfferStandard();
        bP.collateralAmount = COLLATERAL_AMOUNT;
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 borrowerOfferId = OfferFacet(diamond).createOffer(bP);
        vm.stopBroadcast();
        vm.startBroadcast(deployerKey);
        OfferMatchFacet(diamond).matchOffers(rangeOfferId, borrowerOfferId);
        vm.stopBroadcast();

        LibVaipakam.Offer memory rangeAfter = OfferCancelFacet(diamond).getOffer(rangeOfferId);
        console.log("Partial-filled offer:", rangeOfferId, "amountFilled:", rangeAfter.amountFilled);
        require(
            rangeAfter.amountFilled > 0 && rangeAfter.amountFilled < rangeAfter.amountMax,
            "P-G: range offer should be partial-filled (open)"
        );

        console.log(">>> P-G PASSED <<<");
    }

    // ─── P-N: Partial repay applied, loan still active ──────────────────

    /// @dev Lender opt-in to allowsPartialRepay → borrower repays 30%
    ///      mid-loan → principal halves → loan stays Active. Mid-cycle
    ///      state captured for the Loan Details UI to render the
    ///      reduced principal + remaining interest.
    function _scenarioPN_partialRepayMidLoan() internal {
        console.log("");
        console.log("=== P-N: Loan with partial-repay applied (still active) ===");

        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.allowsPartialRepay = true;
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferFacet(diamond).createOffer(p);
        vm.stopBroadcast();

        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferFacet(diamond).acceptOffer(offerId, true);
        vm.stopBroadcast();

        // Repay 30% (300 USDC) — typical partial-repay UX.
        uint256 partialAmt = (LOAN_AMOUNT * 30) / 100;
        vm.startBroadcast(borrowerKey);
        usdc.approve(diamond, partialAmt + 100e6);
        RepayFacet(diamond).repayPartial(loanId, partialAmt);
        vm.stopBroadcast();

        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loan.status == LibVaipakam.LoanStatus.Active,
            "P-N: loan should still be Active after partial repay"
        );
        require(
            loan.principal < LOAN_AMOUNT,
            "P-N: loan principal should drop after partial repay"
        );
        console.log("Loan", loanId, "post-partial principal:", loan.principal);

        console.log(">>> P-N PASSED <<<");
    }

    // ─── P-O: Collateral doubled mid-flight ─────────────────────────────

    /// @dev Borrower adds collateral to an active loan. UI Loan Details
    ///      should show the new collateral amount + improved HF.
    function _scenarioPO_collateralDoubled() internal {
        console.log("");
        console.log("=== P-O: Loan with collateral doubled mid-flight ===");

        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferFacet(diamond).acceptOffer(offerId, true);
        vm.stopBroadcast();

        // Borrower doubles collateral (adds another 1 WETH).
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        AddCollateralFacet(diamond).addCollateral(loanId, COLLATERAL_AMOUNT);
        vm.stopBroadcast();

        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loan.collateralAmount == 2 * COLLATERAL_AMOUNT,
            "P-O: collateralAmount should double after addCollateral"
        );
        console.log("Loan", loanId, "post-add collateral:", loan.collateralAmount);

        console.log(">>> P-O PASSED <<<");
    }

    // ─── P-P: Keeper enabled with INIT_PRECLOSE on active loan ──────────

    /// @dev Borrower delegates an action bit to a keeper on a live loan.
    ///      UI Keeper Settings should render the keeper as authorised
    ///      with the specific bit highlighted.
    function _scenarioPP_keeperEnabledOnActiveLoan() internal {
        console.log("");
        console.log("=== P-P: Keeper enabled with INIT_PRECLOSE on active loan ===");

        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferFacet(diamond).acceptOffer(offerId, true);
        vm.stopBroadcast();

        // Borrower → keeper authorization (3 switches per LibAuth):
        //   1. setKeeperAccess(true)
        //   2. approveKeeper(keeper, INIT_PRECLOSE)
        //   3. setLoanKeeperEnabled(loanId, keeper, true)
        address keeperAddr = newBorrower;
        vm.startBroadcast(borrowerKey);
        ProfileFacet(diamond).setKeeperAccess(true);
        ProfileFacet(diamond).approveKeeper(
            keeperAddr,
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE
        );
        ProfileFacet(diamond).setLoanKeeperEnabled(loanId, keeperAddr, true);
        vm.stopBroadcast();

        console.log(
            "Keeper",
            keeperAddr,
            "authorised on loan with INIT_PRECLOSE bit; loan:",
            loanId
        );

        console.log(">>> P-P PASSED <<<");
    }

    // ─── P-Q: Refinance offer posted, no acceptance yet ─────────────────

    /// @dev Borrower has an active loan AND posts a new borrower-side
    ///      refinance offer — the UI Refinance step-1 surface shows
    ///      a "pending" offer. No new lender accepts yet.
    function _scenarioPQ_refinanceOfferPosted() internal {
        console.log("");
        console.log("=== P-Q: Refinance offer posted, no acceptance yet ===");

        // Step 1: original loan.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 origOfferId = OfferFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferFacet(diamond).acceptOffer(origOfferId, true);
        vm.stopBroadcast();

        // Step 2: borrower posts a refinance offer (cheaper rate).
        LibVaipakam.CreateOfferParams memory refiP = _borrowerOfferStandard();
        refiP.interestRateBps = INTEREST_BPS / 2;
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 refiOfferId = OfferFacet(diamond).createOffer(refiP);
        vm.stopBroadcast();

        LibVaipakam.Offer memory refi = OfferCancelFacet(diamond).getOffer(refiOfferId);
        require(
            !refi.accepted,
            "P-Q: refinance offer should remain unaccepted"
        );
        console.log("Refinance offer:", refiOfferId);
        console.log("Loan still active, awaiting new lender; loan:", loanId);

        console.log(">>> P-Q PASSED <<<");
    }

    // ─── P-T: Loan-sale offer posted, no buyer (SKIPPED) ────────────────

    /// @dev SKIPPED on Anvil broadcast — `createLoanSaleOffer` has TWO
    ///      pre-existing bugs that block end-to-end execution:
    ///        (a) Reentrancy collision: `_submitSaleOffer` cross-facet-
    ///            calls `OfferFacet.createOffer`, which is also
    ///            `nonReentrant` on the diamond-shared lock. Same
    ///            shape as the completeOffset bug fixed in N6 via
    ///            `completeOffsetInternal` — needs a parallel
    ///            `createOfferInternal`-style internal entry.
    ///        (b) Validation: the sale offer mimics a Borrower offer
    ///            with `collateralAmount=0` (existing loan collateral
    ///            already backs the position post-sale), but the
    ///            Borrower-side createOffer validation requires
    ///            `amountMax <= collateral × price / liqThreshold`,
    ///            which reverts `MaxLendingAboveCeiling` for any
    ///            non-zero amount when collateral=0.
    ///      A complete fix needs both: a sale-offer-mode bypass flag
    ///      in createOfferInternal (for the validation), AND
    ///      switching `_submitSaleOffer` to use that internal entry
    ///      (for the reentrancy). Earlier in this session I tried
    ///      the reentrancy-only fix in isolation and it broke 9 unit
    ///      tests in EarlyWithdrawalFacetTest.t.sol, so reverted.
    ///      The deeper fix needs a dedicated PR.
    ///      Working alternative: `sellLoanViaBuyOffer` (covered by
    ///      AnvilNewPositiveFlows N15).
    function _scenarioPT_loanSaleOfferPosted() internal {
        console.log("");
        console.log("=== P-T: Loan-sale offer posted, no buyer (SKIPPED) ===");
        console.log("Skipped: createLoanSaleOffer hits a pre-existing");
        console.log("MaxLendingAboveCeiling validation when collateral=0.");
        console.log("Working alternative covered by N15 (sellLoanViaBuyOffer).");
        console.log(">>> P-T SKIPPED <<<");
    }

    // ─── P-U: Stray ERC-20 in escrow, recovery untriggered ──────────────

    /// @dev Mint USDC directly to user's escrow proxy, leaving the
    ///      protocol-tracked counter unchanged. Recovery is NOT
    ///      triggered — the UI Stuck-Token Recovery surface should
    ///      detect the mismatch and prompt the user.
    function _scenarioPU_strayTokenInEscrow() internal {
        console.log("");
        console.log("=== P-U: Stray ERC-20 in escrow, recovery untriggered ===");

        // Use a fresh user (newBorrower) so this stray balance is
        // observable in isolation. User must have an escrow proxy
        // before we can park stray tokens in it; getOrCreateUserEscrow
        // is idempotent.
        address user = newBorrower;
        vm.startBroadcast(newBorrowerKey);
        address userEscrow = EscrowFactoryFacet(diamond).getOrCreateUserEscrow(user);
        vm.stopBroadcast();

        // Park stray USDC directly in the escrow (bypasses protocol-
        // tracked counter — this is the stuck-token recovery scenario).
        vm.startBroadcast(deployerKey);
        usdc.mint(userEscrow, 50e6);
        vm.stopBroadcast();

        uint256 stray = usdc.balanceOf(userEscrow);
        uint256 tracked = EscrowFactoryFacet(diamond).getProtocolTrackedEscrowBalance(
            user, address(usdc)
        );
        console.log("Stray balance in escrow:", stray);
        console.log("Tracked balance:", tracked);
        require(
            stray > tracked,
            "P-U: stray should exceed tracked counter"
        );

        console.log(">>> P-U PASSED <<<");
    }

    // ─── P-H: Dual claimable side-by-side ───────────────────────────────

    /// @dev Loan repaid but neither lender nor borrower has called
    ///      claim. Claim Center UI should render both rows side-by-
    ///      side with the lender claimable (principal + interest)
    ///      and borrower claimable (collateral).
    function _scenarioPH_dualClaimableSideBySide() internal {
        console.log("");
        console.log("=== P-H: 1 lender-claimable + 1 borrower-claimable side-by-side ===");

        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferFacet(diamond).acceptOffer(offerId, true);
        vm.stopBroadcast();

        // Borrower repays without anyone calling claim — leaves both
        // sides claimable.
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt + 100e6);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();

        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loan.status != LibVaipakam.LoanStatus.Active,
            "P-H: loan should be settled post-repay"
        );
        console.log("Loan", loanId, "repaid; both sides claimable (no one has claimed yet)");

        console.log(">>> P-H PASSED <<<");
    }

    // ─── Offer-param helpers ─────────────────────────────────────────────

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

    function _borrowerOfferStandard() internal view returns (LibVaipakam.CreateOfferParams memory) {
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.offerType = LibVaipakam.OfferType.Borrower;
        return p;
    }
}
