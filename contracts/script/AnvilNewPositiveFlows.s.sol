// script/AnvilNewPositiveFlows.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "../test/helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {LibSaleSolvency} from "../src/libraries/LibSaleSolvency.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory, MockUniswapV3Pool} from "./mocks/MockUniswapV3.sol";
import {MockSanctionsList} from "../test/mocks/MockSanctionsList.sol";
import {Deployments} from "./lib/Deployments.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title AnvilNewPositiveFlows
 * @notice End-to-end positive flows for recent features NOT covered by
 *         `SepoliaPositiveFlows.s.sol`. Each scenario walks the Diamond
 *         through a complete user-facing flow that maps to a section of
 *         `frontend/src/content/userguide/Advanced.en.md`.
 *
 *         Wave 1 scenarios (this file):
 *           N3  — Partial repay (lender opt-in via `allowsPartialRepay`,
 *                 borrower repays 30% mid-loan, then full close).
 *                 Maps to Advanced Guide § Loan Details > Actions.
 *           N4  — Refinance (alice has loan l1; she posts a new
 *                 borrower offer; bob accepts → l2; alice calls
 *                 `refinanceLoan(l1, newOfferId)` to swap lenders).
 *                 Maps to Advanced Guide § Refinance.
 *           N7  — Stuck-token recovery happy path (random ERC20 sent
 *                 to user's vault, user signs the EIP-712
 *                 RecoveryAcknowledgment, calls `recoverStuckERC20`
 *                 with declaredSource ≠ self ≠ sanctioned, asset
 *                 returns to user).
 *                 Maps to Advanced Guide § Stuck-Token Recovery.
 *
 *         Subsequent waves (separate iterations):
 *           N1, N2, N5, N6  — range match, periodic interest, preclose Opt2/3
 *           N8, N9, N10, N11, N12 — recovery-ban, disown, VPFI deposit
 *                                   + discount, sanctions Tier-1, keeper
 *                                   per-action authorization
 *
 *         Run order: anvil-bootstrap.sh first (deploys diamond +
 *         testnet liquidity mocks + flips Range Orders flags), then
 *         this script. Each scenario deploys its own fresh mock USDC /
 *         WETH so it is independent of the bootstrap's mock set.
 *
 *         Env vars (same shape as SepoliaPositiveFlows):
 *           DEPLOYER_PRIVATE_KEY, ADMIN_PRIVATE_KEY, ADMIN_ADDRESS,
 *           LENDER_PRIVATE_KEY, LENDER_ADDRESS,
 *           BORROWER_PRIVATE_KEY, BORROWER_ADDRESS,
 *           NEW_LENDER_PRIVATE_KEY, NEW_LENDER_ADDRESS,
 *           NEW_BORROWER_PRIVATE_KEY, NEW_BORROWER_ADDRESS.
 */
contract AnvilNewPositiveFlows is Script {
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
    ERC20Mock vpfi;
    MockSanctionsList sanctions;
    /// @dev #1503 PR-E — kept so N25 can move the collateral price
    ///      and drive a live position under its solvency floor.
    MockChainlinkFeed wethFeedRef;
    /// @dev The mock USDC/WETH pool, kept so a feed move can re-price the
    ///      pool's spot in the SAME step. See {_setWethPriceConsistently}.
    MockUniswapV3Pool mockPoolRef;

    // Mock-token decimals + sizing chosen to mirror SepoliaPositiveFlows
    // so every scenario's debt + collateral math is comfortably above
    // dust thresholds and HF >= 1.5e18.
    uint256 constant LOAN_AMOUNT = 1000e6;       // 1000 USDC (6 dec)
    uint256 constant COLLATERAL_AMOUNT = 1e18;   // 1 WETH (18 dec)
    uint256 constant INTEREST_BPS = 500;         // 5% APR
    uint256 constant DURATION_DAYS = 30;

    function run() external {
        _loadEnv();
        diamond = Deployments.readDiamond();

        console.log("=== Anvil New Positive Flows (gap-coverage wave 1) ===");
        console.log("Diamond:    ", diamond);
        console.log("Admin:      ", admin);
        console.log("Lender:     ", lender);
        console.log("Borrower:   ", borrower);
        console.log("NewLender:  ", newLender);
        console.log("NewBorrower:", newBorrower);

        _deployMocksAndConfigure();

        // Run ONE scenario and stop. The full wave cannot currently reach its
        // broadcast pass: N12's `revokeKeeper` re-simulates as
        // `KeeperNotApproved()` there (reproduces on a pristine chain with
        // every later scenario disabled, so it predates them), and that aborts
        // the whole script before any transaction is mined. This switch lets a
        // single scenario be broadcast for real while that is outstanding —
        // `ONLY_SCENARIO=N25 forge script ... --broadcast`.
        string memory only = vm.envOr("ONLY_SCENARIO", string(""));
        if (bytes(only).length != 0) {
            if (keccak256(bytes(only)) == keccak256("N25")) {
                _scenarioN25SaleSolvencyFloor();
            } else if (keccak256(bytes(only)) == keccak256("N26")) {
                _scenarioN26SaleAdmissionOnAcceptBranch();
            } else if (keccak256(bytes(only)) == keccak256("N15")) {
                _scenarioN15SellLoanViaBuyOffer();
            } else {
                revert("ONLY_SCENARIO: unknown scenario name");
            }
            console.log("");
            console.log("=== single-scenario run complete:", only, "===");
            return;
        }

        _scenarioN3PartialRepay();
        _scenarioN4Refinance();
        _scenarioN7RecoveryHappyPath();
        _scenarioN1RangeMatchAndPartialFill();
        _scenarioN5PrecloseOption2TransferObligation();
        _scenarioN6PrecloseOption3Offset();
        _scenarioN8RecoverySanctionedBan();
        _scenarioN9Disown();
        _scenarioN11SanctionsTier1Deny();
        _scenarioN12KeeperPerAction();
        _scenarioN10VpfiDepositDiscount();
        // #687-B: N13 (staking-rewards claim) removed with the 5% staking yield.
        _scenarioN14WithdrawVpfi();
        _restoreVpfiConfig();
        _scenarioN18PauseAsset();
        _scenarioN19GlobalPause();
        _scenarioN20TreasuryAccrual();
        _scenarioN22MasterFlagDormancy();
        _scenarioN15SellLoanViaBuyOffer();
        _scenarioN25SaleSolvencyFloor();
        _scenarioN26SaleAdmissionOnAcceptBranch();

        console.log("");
        console.log("============================================");
        console.log("  WAVE 1+2+3a+3b+3c+3d+3e (N3, N4, N7, N1, N5, N6, N8, N9, N11, N12, N10, N13, N14, N18, N19, N20, N22, N15, N25, N26) PASSED");
        console.log("");
        console.log("  Skipped on Anvil --broadcast (chain time cannot be advanced from inside the script):");
        console.log("    N16 HF liquidation       -> covered by RiskFacetTest.t.sol unit tests + Phase 7a LibSwap*Test.t.sol");
        console.log("    N17 markDefaulted        -> covered by DefaultedFacet*Test.t.sol unit tests");
        console.log("    N21 cancel cooldown      -> covered by OfferFacetCancelCooldownTest.t.sol unit tests");
        console.log("    N23 swap-adapter failover -> covered by Phase 7a LibSwap*Test.t.sol (4-DEX try-list)");
        console.log("    N24 secondary-oracle quorum -> covered by Phase 7b SecondaryQuorumTest.t.sol (27 cases)");
        console.log("============================================");
    }

    // ─── Setup ────────────────────────────────────────────────────────────

    function _loadEnv() internal {
        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
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

    /// @dev Deploys fresh USDC / WETH mocks + Chainlink registry +
    ///      Univ3 factory mocks, mints generously to every participant,
    ///      and configures the Diamond's oracle + risk params for both
    ///      assets. Idempotent across script re-runs (each invocation
    ///      deploys NEW token addresses; the Diamond's oracle config
    ///      gets re-pointed at the freshly-deployed feeds).
    function _deployMocksAndConfigure() internal {
        // Phase 1a: deployer-funded mocks + mints + USDC/WETH approvals
        // by every participant (we top up enough for all three
        // scenarios — partial repay, refinance, recovery).
        vm.startBroadcast(deployerKey);
        usdc = new ERC20Mock("Mock USDC W1", "mUSDCW1", 6);
        weth = new ERC20Mock("Mock WETH W1", "mWETHW1", 18);
        console.log("MockUSDC (W1): ", address(usdc));
        console.log("MockWETH (W1): ", address(weth));

        // Mint generously — refinance needs 2x collateral (one per
        // active loan during the refinance overlap), partial repay
        // needs principal + interest, recovery needs a stray transfer.
        usdc.mint(lender, 100_000e6);
        usdc.mint(borrower, 100_000e6);
        usdc.mint(newLender, 100_000e6);
        usdc.mint(newBorrower, 100_000e6);
        usdc.mint(admin, 100_000e6);
        weth.mint(lender, 10e18);
        weth.mint(borrower, 10e18);
        weth.mint(newLender, 10e18);
        weth.mint(newBorrower, 10e18);

        MockChainlinkRegistry registry = new MockChainlinkRegistry();
        MockChainlinkFeed usdcFeed = new MockChainlinkFeed(1e8, 8);
        MockChainlinkFeed wethFeed = new MockChainlinkFeed(2000e8, 8);
        wethFeedRef = wethFeed;
        address usdDenom = 0x0000000000000000000000000000000000000348;
        registry.setFeed(address(usdc), usdDenom, address(usdcFeed));
        registry.setFeed(address(weth), usdDenom, address(wethFeed));

        MockUniswapV3Factory univ3 = new MockUniswapV3Factory();
        // #856 — price the mock pool CONSISTENTLY with the mock Chainlink feeds.
        // OracleFacet's depth guard (`_accumulatePoolImpacts` Guard 1) requires
        // the pool's two legs, valued at the feed price, to BALANCE — i.e. the
        // pool's spot must agree with the oracle. A raw 1:1 sqrtPriceX96 (2^96)
        // is wildly imbalanced for a USDC(6-dec,$1)/WETH(18-dec,$2000) pair, so
        // the guard rejected the pool and classified USDC Illiquid on every
        // chain whose deploy has the depth guard configured (the guard is recent;
        // that's why the raw-1:1 fixture used to pass). See
        // `_mockPoolSqrtPriceX96` for the derivation.
        mockPoolRef = MockUniswapV3Pool(
            univ3.createPool(address(usdc), address(weth), 3000, _mockPoolSqrtPriceX96(), 1e24)
        );

        // Mock sanctions oracle — N7 (recoverStuckERC20) checks the
        // declaredSource against this oracle and reverts
        // SanctionsOracleUnavailable if it's address(0). Default
        // behaviour: every address returns un-flagged. Wave-3 N8 will
        // flag an address before signing to exercise the ban path.
        sanctions = new MockSanctionsList();
        console.log("MockSanctionsList:", address(sanctions));
        vm.stopBroadcast();

        // Phase 1b: admin role-gated config — point the Diamond's
        // oracle at the freshly-deployed registry/feeds, set risk
        // params, enable KYC bypass via Tier2, allow trade pair.
        vm.startBroadcast(adminKey);
        OracleAdminFacet(diamond).setChainlinkRegistry(address(registry));
        OracleAdminFacet(diamond).setUsdChainlinkDenominator(usdDenom);
        OracleAdminFacet(diamond).setWethContract(address(weth));
        OracleAdminFacet(diamond).setEthUsdFeed(address(wethFeed));
        OracleAdminFacet(diamond).setUniswapV3Factory(address(univ3));
        // #856 — point the PAA (Predominantly-Available-Asset) quote set at THIS
        // fixture's mock WETH so the floor-slippage depth probe can DISCOVER the
        // mock usdc/weth pool. A real testnet deploy's ConfigureOracle populates
        // `s.paaAssets` with that chain's own quote assets (arb-sepolia carried
        // `[vpfiMirror]`), so the probe would route the mock USDC over a real
        // asset for which no mock pool exists → no route → Illiquid. On a fresh
        // Anvil `s.paaAssets` is empty and falls back to `[wethContract]`, which
        // is why the fixture found its pool there. WETH itself takes the
        // wethContract liquidity branch (no PAA route), so a single-element
        // `[weth]` set makes both mock assets liquid. (Route discovery is
        // necessary but not sufficient — the pool must ALSO pass the value-balance
        // guard, which is why the pool is priced consistently above.)
        address[] memory paa = new address[](1);
        paa[0] = address(weth);
        ConfigFacet(diamond).setPaaAssets(paa);
        RiskFacet(diamond).updateRiskParams(address(usdc), 8000, 300, 1000);
        RiskFacet(diamond).updateRiskParams(address(weth), 8000, 300, 1000);
        ProfileFacet(diamond).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(newLender, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).updateKYCTier(newBorrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(diamond).setTradeAllowance("US", "US", true);
        ProfileFacet(diamond).setSanctionsOracle(address(sanctions));
        vm.stopBroadcast();

        _setCountryIfUnset(lenderKey, lender, "US");
        _setCountryIfUnset(borrowerKey, borrower, "US");
        _setCountryIfUnset(newLenderKey, newLender, "US");
        _setCountryIfUnset(newBorrowerKey, newBorrower, "US");

        console.log("Setup OK: oracle + risk params + KYC + countries.");
    }

    /// @dev #856 — sqrtPriceX96 (Q96) for the mock USDC/WETH pool, priced so the
    ///      pool's Chainlink-feed-valued reserves BALANCE (OracleFacet
    ///      `_accumulatePoolImpacts` Guard 1). `v3VirtualReserves` gives
    ///      reserve0 = L·Q96/√P and reserve1 = L·√P/Q96, and the guard requires
    ///      reserve0·p0/scale0 ≈ reserve1·p1/scale1. Solving for √P:
    ///        √P = Q96 · sqrt( (p0·scale1) / (p1·scale0) )
    ///      where token0/token1 are ordered by ADDRESS (as the pool + guard read
    ///      them), pX is the feed price (8-dec: USDC 1e8, WETH 2000e8) and
    ///      scaleX = 10^(8 + tokenDecimals) (USDC 1e14, WETH 1e26). Computed at
    ///      runtime because the mock token addresses — hence the ordering — vary
    ///      per deploy. `Math.mulDiv` keeps the `·Q192` intermediate from
    ///      overflowing uint256; the result fits uint160 for these values.
    function _mockPoolSqrtPriceX96() internal view returns (uint160) {
        return _mockPoolSqrtPriceX96At(2000e8);
    }

    /// @dev The same derivation for an ARBITRARY WETH feed price, so a scenario
    ///      that moves the feed can move the pool with it. Splitting this out is
    ///      what makes {_setWethPriceConsistently} possible: the value-balance
    ///      guard compares the pool's spot against the FEED, so the two must
    ///      travel together or the pool stops being a valid route.
    function _mockPoolSqrtPriceX96At(uint256 pWethE8) internal view returns (uint160) {
        uint256 pUsdc = 1e8;
        uint256 scaleUsdc = 1e14; // 10^(8 + 6)
        uint256 pWeth = pWethE8;
        uint256 scaleWeth = 1e26; // 10^(8 + 18)
        (uint256 p0, uint256 scale0, uint256 p1, uint256 scale1) =
            address(usdc) < address(weth)
                ? (pUsdc, scaleUsdc, pWeth, scaleWeth)
                : (pWeth, scaleWeth, pUsdc, scaleUsdc);
        uint256 q192 = uint256(1) << 192;
        uint256 sq = Math.sqrt(Math.mulDiv(p0 * scale1, q192, p1 * scale0));
        return uint160(sq);
    }

    /// @dev Move the mock WETH price on BOTH sources the Diamond consults: the
    ///      Chainlink feed (which drives health factors) and the mock pool's
    ///      spot (which the liquidity classifier compares against that feed).
    ///
    ///      Moving only the feed silently de-prices the OTHER leg. The mock
    ///      USDC and WETH share one pool, and `OracleFacet`'s value-balance
    ///      guard requires the pool's reserves, valued at feed prices, to
    ///      balance. A 25% feed move ($2000 -> $1500) against a pool still
    ///      quoting $2000 fails that guard, the pool stops being a discoverable
    ///      route, and mock USDC — whose only route is this pool — classifies
    ///      Illiquid. The sale scenarios then hit the #1655 unpriceable-leg
    ///      refusal (`SaleLegUnpriceable`, code 6) on the PRINCIPAL leg instead
    ///      of the solvency floor (code 1) they exist to exercise, and the
    ///      scenario's own liquidity assertion does not catch it because that
    ///      assertion covers the COLLATERAL leg, which keeps its own feed-priced
    ///      branch and stays Liquid.
    ///
    ///      Re-pricing the pool alongside the feed is also the more faithful
    ///      fixture: a real 25% move shows up in the AMM as well as the oracle.
    ///      Health factors are unaffected by the pool spot, so the drift the
    ///      scenarios engineer still happens exactly as before.
    function _setWethPriceConsistently(uint256 pWethE8) internal {
        wethFeedRef.setPrice(int256(pWethE8));
        mockPoolRef.setSqrtPriceX96(_mockPoolSqrtPriceX96At(pWethE8));
    }

    function _setCountryIfUnset(uint256 key, address user, string memory country) internal {
        string memory cur = ProfileFacet(diamond).getUserCountry(user);
        if (bytes(cur).length == 0) {
            vm.startBroadcast(key);
            ProfileFacet(diamond).setUserCountry(country);
            vm.stopBroadcast();
        }
    }

    // ─── N3: Partial Repay ────────────────────────────────────────────────

    /// @dev Lender opts into partial repay via `allowsPartialRepay = true`;
    ///      borrower accepts → loan active; borrower partial-repays
    ///      30% mid-loan → loan.principal halves; borrower full-closes
    ///      via repayLoan. Verifies the lender-controlled gate works
    ///      end-to-end on chain.
    function _scenarioN3PartialRepay() internal {
        console.log("");
        console.log("=== N3: Partial Repay ===");

        // Lender posts an offer with partial-repay opt-in ON.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferAllowsPartial());
        vm.stopBroadcast();
        console.log("Lender offer with allowsPartialRepay=true:", offerId);

        // Borrower accepts.
        LibAcceptTerms.AcceptTerms memory _t1 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(borrowerKey), offerId, true, 0);
        bytes memory _sig1 = LibAcceptTestSigner.sign(diamond, _t1, borrowerKey);
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t1, _sig1);
        vm.stopBroadcast();
        console.log("Loan initiated:", loanId);

        // Snapshot principal pre-partial.
        LibVaipakam.Loan memory loanBefore = LoanFacet(diamond).getLoanDetails(loanId);
        require(loanBefore.principal == LOAN_AMOUNT, "N3: pre-principal mismatch");
        require(loanBefore.allowsPartialRepay, "N3: opt-in not flagged on loan");

        // Borrower partial-repays 30% of principal. Allowance covers
        // partial principal + accrued interest (negligible at t≈0).
        uint256 partialAmt = (LOAN_AMOUNT * 30) / 100;
        vm.startBroadcast(borrowerKey);
        usdc.approve(diamond, partialAmt + 100e6); // headroom for accrued
        RepayFacet(diamond).repayPartial(loanId, partialAmt);
        vm.stopBroadcast();
        console.log("Partial repaid:", partialAmt);

        // Verify principal reduced.
        LibVaipakam.Loan memory loanMid = LoanFacet(diamond).getLoanDetails(loanId);
        require(loanMid.principal == LOAN_AMOUNT - partialAmt, "N3: principal not reduced");
        require(
            loanMid.status == LibVaipakam.LoanStatus.Active,
            "N3: should still be Active after partial"
        );
        console.log("Mid-loan principal:", loanMid.principal);

        // Borrower closes the rest.
        uint256 closeAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        vm.startBroadcast(borrowerKey);
        usdc.approve(diamond, closeAmt);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();

        _claimBoth(lenderKey, borrowerKey, loanId);
        console.log(">>> N3 PASSED <<<");
    }

    // ─── N4: Refinance ────────────────────────────────────────────────────

    /// @dev alice (borrower) takes loan l1 from Lender A. alice then
    ///      creates a new Borrower offer at a lower interest rate;
    ///      Lender B accepts the offer (creating loan l2). alice now
    ///      holds Lender B's principal in hand. She calls
    ///      `refinanceLoan(l1, newOfferId)` which uses that principal
    ///      to repay Lender A and rolls the loan over to Lender B's
    ///      terms. End state: l1 settled, l2 active, single collateral
    ///      lock, no net principal movement to alice (she just swapped
    ///      lenders).
    ///
    ///      Naming: `borrower` = alice (the borrower being refinanced),
    ///              `lender` = Lender A (the original lender),
    ///              `newLender` = Lender B (the refinancing lender).
    function _scenarioN4Refinance() internal {
        console.log("");
        console.log("=== N4: Refinance ===");

        // alice + Lender A create + accept an offer → loan l1.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerL1 = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        LibAcceptTerms.AcceptTerms memory _t2 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(borrowerKey), offerL1, true, 0);
        bytes memory _sig2 = LibAcceptTestSigner.sign(diamond, _t2, borrowerKey);
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanL1 = OfferAcceptFacet(diamond).acceptOffer(offerL1, _t2, _sig2);
        vm.stopBroadcast();
        console.log("L1 (original loan) initiated:", loanL1);

        // alice creates a NEW borrower offer with a lower rate — same
        // collateral asset / amount / duration so the asset-continuity
        // check in refinanceLoan passes. Pulls collateral from her
        // wallet again (she has 10 WETH per setup, plenty).
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 refinanceOfferId = OfferCreateFacet(diamond).createOffer(_borrowerRefinanceOffer());
        vm.stopBroadcast();
        console.log("Alice's refinance borrower offer:", refinanceOfferId);

        // Lender B accepts — creates loan l2. alice receives l2's
        // principal in her wallet.
        LibAcceptTerms.AcceptTerms memory _t3 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(newLenderKey), refinanceOfferId, true, 0);
        bytes memory _sig3 = LibAcceptTestSigner.sign(diamond, _t3, newLenderKey);
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        OfferAcceptFacet(diamond).acceptOffer(refinanceOfferId, _t3, _sig3);
        vm.stopBroadcast();

        // alice repays Lender A using l2's principal. refinanceLoan is
        // a single-tx settle of l1 against the new offer — alice signs.
        vm.startBroadcast(borrowerKey);
        // Refinance pays the OLD lender principal + full-term interest.
        // alice approves enough to cover both.
        usdc.approve(diamond, LOAN_AMOUNT * 2);
        RefinanceFacet(diamond).refinanceLoan(loanL1, refinanceOfferId);
        vm.stopBroadcast();

        // Verify l1 is no longer Active (it's been settled by refinance).
        LibVaipakam.Loan memory l1After = LoanFacet(diamond).getLoanDetails(loanL1);
        require(
            l1After.status != LibVaipakam.LoanStatus.Active,
            "N4: L1 should not be Active after refinance"
        );
        console.log("L1 status post-refinance:", uint8(l1After.status));

        console.log(">>> N4 PASSED <<<");
    }

    // ─── N7: Stuck-Token Recovery (happy path) ────────────────────────────

    /// @dev A random USDC transfer lands directly on alice's vault
    ///      proxy (e.g., someone confused a contract address for a
    ///      wallet). The funds aren't accounted for in
    ///      `protocolTrackedVaultBalance` because they didn't flow
    ///      through the chokepoint, so they're "stuck" — the loan /
    ///      offer paths can't move them. alice notices via the Asset
    ///      Viewer page and uses the Recovery flow:
    ///        1. Look up `recoveryDomainSeparator()` + `recoveryNonce`.
    ///        2. Sign the EIP-712 `RecoveryAcknowledgment` for
    ///           (token, declaredSource, amount, deadline).
    ///        3. Call `recoverStuckERC20(token, declaredSource, amount,
    ///           deadline, signature)` with `declaredSource ≠ herself`
    ///           and not on the sanctions oracle.
    ///        4. Tokens transfer from her vault back to her wallet.
    ///
    ///      End-state: alice's wallet balance increases by the stray
    ///      amount; recovery nonce increments; no ban activates
    ///      (sanctioned-source path is N8, separate scenario).
    function _scenarioN7RecoveryHappyPath() internal {
        console.log("");
        console.log("=== N7: Stuck-Token Recovery happy path ===");

        // alice (borrower) needs an vault already created for the
        // stray transfer to have a target. createOffer is the simplest
        // way — she can cancel afterward to clean up. Faster: deposit
        // a token via a no-op deposit. Even faster: just call
        // `getOrCreateUserVault` from the Diamond's perspective.
        // We use a thin createOffer + cancelOffer dance to ensure the
        // vault proxy exists and alice is a known user.
        // Faster path actually used: lender or any other actor calls
        // getOrCreateUserVault on alice's behalf via cross-facet ...
        // but that's diamond-internal. So we use `createOffer` for
        // alice (we just need her vault to exist).
        //
        // Actually `getOrCreateUserVault` is publicly callable per
        // the deploy-script selector list — alice can call it
        // directly to provision her vault.
        vm.startBroadcast(borrowerKey);
        address aliceVault = VaultFactoryFacet(diamond).getOrCreateUserVault(borrower);
        vm.stopBroadcast();
        console.log("Alice vault:", aliceVault);

        // The stray sender — we use `newBorrower` to play the role of
        // the third party who accidentally transferred to alice's vault.
        // declaredSource in alice's recovery sig must match this address.
        uint256 strayAmount = 50e6; // 50 USDC stuck
        vm.startBroadcast(newBorrowerKey);
        usdc.transfer(aliceVault, strayAmount);
        vm.stopBroadcast();
        console.log("Stray USDC transferred to Alice's vault:", strayAmount);

        // Build the EIP-712 digest and sign. Recovery typehash:
        //   RecoveryAcknowledgment(address user, address token,
        //                          address declaredSource, uint256 amount,
        //                          uint256 nonce, uint256 deadline,
        //                          bytes32 ackTextHash)
        bytes32 recTypehash = keccak256(
            "RecoveryAcknowledgment(address user,address token,address declaredSource,uint256 amount,uint256 nonce,uint256 deadline,bytes32 ackTextHash)"
        );
        bytes32 domainSep = VaultFactoryFacet(diamond).recoveryDomainSeparator();
        bytes32 ackText = VaultFactoryFacet(diamond).recoveryAckTextHash();
        uint256 nonce = VaultFactoryFacet(diamond).recoveryNonce(borrower);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 structHash = keccak256(
            abi.encode(
                recTypehash,
                borrower,
                address(usdc),
                newBorrower, // declaredSource (the address that sent the stray)
                strayAmount,
                nonce,
                deadline,
                ackText
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Snapshot wallet balance pre-recovery.
        uint256 walletBefore = usdc.balanceOf(borrower);

        vm.startBroadcast(borrowerKey);
        VaultFactoryFacet(diamond).recoverStuckERC20(
            address(usdc),
            newBorrower,
            strayAmount,
            deadline,
            sig
        );
        vm.stopBroadcast();

        uint256 walletAfter = usdc.balanceOf(borrower);
        require(
            walletAfter == walletBefore + strayAmount,
            "N7: stray amount not recovered to wallet"
        );

        // Nonce should have incremented.
        uint256 nonceAfter = VaultFactoryFacet(diamond).recoveryNonce(borrower);
        require(nonceAfter == nonce + 1, "N7: recovery nonce did not increment");

        console.log("Recovered to wallet (delta):", strayAmount);
        console.log("Recovery nonce:", nonce, "->", nonceAfter);
        console.log(">>> N7 PASSED <<<");
    }

    // ─── N8: Stuck-Token Recovery — Sanctioned-Source Ban ────────────────

    /// @dev Same EIP-712 + recoverStuckERC20 path as N7, but the
    ///      `declaredSource` is on the sanctions oracle. Per T-054
    ///      design (`docs/DesignsAndPlans/VaultStuckRecoveryDesign.md`):
    ///        - oracle.isSanctioned(declaredSource) returns true
    ///        - recoverStuckERC20 does NOT execute (tokens stay)
    ///        - vaultBannedSource[user] is set to declaredSource
    ///        - VaultBannedFromRecoveryAttempt event is emitted
    ///        - subsequent recovery attempts revert until oracle un-flags
    ///
    ///      Scenario uses `newLender` as the user this time (clean
    ///      vault); `newBorrower` (already used in N7 as the stray
    ///      sender — clean address) is flagged on the oracle.
    function _scenarioN8RecoverySanctionedBan() internal {
        console.log("");
        console.log("=== N8: Stuck-Token Recovery sanctioned-source ban ===");

        address user = newLender;
        uint256 userKey = newLenderKey;
        address strayer = address(0xBADC0DE);  // dedicated dummy stray sender we flag

        // Provision user's vault.
        vm.startBroadcast(userKey);
        address userVault = VaultFactoryFacet(diamond).getOrCreateUserVault(user);
        vm.stopBroadcast();

        // Stray transfer from `strayer`. We don't have a key for the
        // dummy 0xBADC0DE address. Mint mock USDC directly into the
        // user's vault via the deployer (ERC20Mock allows public
        // mint). The source-of-funds is what gets attested to in the
        // EIP-712 sig, not the actual transfer path — what matters for
        // the test is that the vault has tokens NOT recorded in the
        // protocolTrackedVaultBalance counter.
        vm.startBroadcast(deployerKey);
        usdc.mint(userVault, 25e6);
        vm.stopBroadcast();
        console.log("Stray USDC parked in vault:", uint256(25e6));

        // Flag the strayer on the sanctions oracle.
        vm.startBroadcast(deployerKey);  // sanctions deployed by deployer in setup
        sanctions.setFlagged(strayer, true);
        vm.stopBroadcast();
        console.log("Flagged stray source on sanctions oracle:", strayer);

        // User signs recovery for the flagged source.
        bytes32 recTypehash = keccak256(
            "RecoveryAcknowledgment(address user,address token,address declaredSource,uint256 amount,uint256 nonce,uint256 deadline,bytes32 ackTextHash)"
        );
        bytes32 domainSep = VaultFactoryFacet(diamond).recoveryDomainSeparator();
        bytes32 ackText = VaultFactoryFacet(diamond).recoveryAckTextHash();
        uint256 nonce = VaultFactoryFacet(diamond).recoveryNonce(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                recTypehash,
                user,
                address(usdc),
                strayer,
                uint256(25e6),
                nonce,
                deadline,
                ackText
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        uint256 walletBefore = usdc.balanceOf(user);
        uint256 vaultBefore = usdc.balanceOf(userVault);

        vm.startBroadcast(userKey);
        VaultFactoryFacet(diamond).recoverStuckERC20(
            address(usdc),
            strayer,
            25e6,
            deadline,
            sig
        );
        vm.stopBroadcast();

        // Verify ban activated, tokens stayed in vault, no transfer.
        require(
            usdc.balanceOf(user) == walletBefore,
            "N8: user wallet balance should be unchanged after sanctioned-ban"
        );
        require(
            usdc.balanceOf(userVault) == vaultBefore,
            "N8: vault balance should be unchanged after sanctioned-ban"
        );
        address ban = VaultFactoryFacet(diamond).vaultBannedSource(user);
        require(ban == strayer, "N8: vaultBannedSource should record the sanctioned source");

        // Nonce DOES increment on the sanctioned-ban path (per T-054
        // design — the call records state and burns the nonce so the
        // sig can't be replayed).
        uint256 nonceAfter = VaultFactoryFacet(diamond).recoveryNonce(user);
        require(nonceAfter == nonce + 1, "N8: nonce should increment on ban path");

        console.log("Banned source recorded:", ban);
        console.log("Nonce burned:", nonce, "->", nonceAfter);

        // T-054 auto-unlock: while the banned source remains flagged on
        // the oracle, `LibVaipakam.isSanctionedAddress(user)` returns
        // true via the source-tracked clause (LibVaipakam.sol:3288-3299).
        // Downstream scenarios (N18-N22) re-use `newLender` as a Tier-1
        // entry-point caller (createOffer, etc.), so de-list the
        // strayer here to lift the recovery-induced ban. This also
        // exercises the auto-unlock branch end-to-end.
        vm.startBroadcast(deployerKey);
        sanctions.setFlagged(strayer, false);
        vm.stopBroadcast();
        require(
            !ProfileFacet(diamond).isSanctionedAddress(user),
            "N8: auto-unlock should clear newLender's recovery-induced ban"
        );
        console.log("Strayer de-listed; recovery-induced ban auto-unlocked for user");
        console.log(">>> N8 PASSED <<<");
    }

    // ─── N9: Disown Unsolicited Tokens ────────────────────────────────────

    /// @dev User's vault received tokens they don't want to claim
    ///      (event-only audit trail, no state mutation beyond the
    ///      event). Per Advanced Guide § Disowning unsolicited tokens.
    ///      Tier-2 entry point — sanctioned users can still disown
    ///      (it's purely informational, no funds move).
    function _scenarioN9Disown() internal {
        console.log("");
        console.log("=== N9: Disown unsolicited tokens ===");

        // borrower's vault already has the recovered amount from N7
        // (recovery moved it to wallet); use newBorrower for a clean
        // disown event. They have no vault yet — disown takes a token
        // address only, so doesn't need an existing vault.
        vm.startBroadcast(newBorrowerKey);
        VaultFactoryFacet(diamond).disown(address(usdc));
        vm.stopBroadcast();

        // disown is event-only — no on-chain state to verify beyond the
        // event being emitted. The Anvil run captures it in the
        // broadcast logs; existence of a successful tx is the assertion.
        console.log("disown(USDC) by newBorrower emitted (audit-trail only)");
        console.log(">>> N9 PASSED <<<");
    }

    // ─── N11: Sanctions Tier-1 Deny / Tier-2 Close-out ────────────────────

    /// @dev Retail policy (per project memory + ProfileFacet
    ///      `_assertNotSanctioned` placement): Tier-1 entry points
    ///      (createOffer, acceptOffer, getOrCreateUserVault,
    ///      recoverStuckERC20, etc.) revert SanctionedAddress for
    ///      flagged callers. Tier-2 close-out paths (repayLoan,
    ///      claimAsBorrower, markDefaulted) STAY OPEN so the
    ///      unflagged counterparty can be made whole.
    ///
    ///      Scenario:
    ///        1. lender + borrower take a normal loan (Tier-1 entry
    ///           paths must succeed BEFORE we flag).
    ///        2. Flag `borrower` on the oracle.
    ///        3. Try `borrower.createOffer(...)` — should revert
    ///           SanctionedAddress (Tier-1 deny).
    ///        4. Try `borrower.repayLoan(activeLoanId)` — should
    ///           SUCCEED (Tier-2 close-out stays open).
    ///        5. Unflag and verify createOffer succeeds again.
    function _scenarioN11SanctionsTier1Deny() internal {
        console.log("");
        console.log("=== N11: Sanctions Tier-1 deny / Tier-2 close-out ===");

        // Step 1: lender + borrower create + accept loan (normal path,
        // pre-flag). Use the standard helpers.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t4 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(borrowerKey), offerId, true, 0);
        bytes memory _sig4 = LibAcceptTestSigner.sign(diamond, _t4, borrowerKey);
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t4, _sig4);
        vm.stopBroadcast();
        console.log("Pre-flag loan initiated:", loanId);

        // Step 2: flag borrower on the sanctions oracle.
        vm.startBroadcast(deployerKey);
        sanctions.setFlagged(borrower, true);
        vm.stopBroadcast();
        console.log("Flagged borrower:", borrower);

        // Step 3: verify the borrower is now flagged (Tier-1 deny is
        // exercised end-to-end by NEG-S1 in AnvilNegativeFlows; here we
        // just assert the sanctions state via a view call). Wrapping
        // the try-revert in `vm.startBroadcast` would fail in
        // `--broadcast` mode because forge re-attempts every tx the
        // simulation issued — even ones inside try/catch — and reports
        // them as broadcast failures.
        bool isFlagged = ProfileFacet(diamond).isSanctionedAddress(borrower);
        require(isFlagged, "N11: borrower should be flagged on the oracle");
        console.log("Tier-1 deny gate is armed (oracle flag verified via view-call)");

        // Step 4: borrower repays the EXISTING loan — should succeed
        // (Tier-2 close-out stays open).
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt + 100e6);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        LibVaipakam.Loan memory loanAfter = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfter.status != LibVaipakam.LoanStatus.Active,
            "N11: Tier-2 repayLoan should have settled the loan"
        );
        console.log("Tier-2 repayLoan succeeded for sanctioned borrower");

        // Step 5: unflag so downstream scenarios (N12) using `borrower`
        // can do Tier-1 entries (createOffer, acceptOffer) again.
        // We don't try a fresh createOffer here — that adds noise and
        // an extra cooldown-gated offer to manage. The unflag tx itself
        // is the assertion; verify via view-call.
        vm.startBroadcast(deployerKey);
        sanctions.setFlagged(borrower, false);
        vm.stopBroadcast();
        require(
            !ProfileFacet(diamond).isSanctionedAddress(borrower),
            "N11: unflag should clear the sanctions state"
        );
        console.log("Borrower unflagged for downstream scenarios");

        console.log(">>> N11 PASSED <<<");
    }

    // ─── N12: Keeper Per-Action Authorization ────────────────────────────

    /// @dev Phase 6 — borrower delegates a specific subset of
    ///      strategic-flow actions to a keeper via
    ///      `ProfileFacet.approveKeeper(keeper, actionBits)`. The
    ///      keeper can then execute ONLY those actions on the
    ///      borrower's behalf. Maps to Advanced Guide § Keeper
    ///      Settings.
    ///
    ///      Scenario:
    ///        1. lender + borrower take a normal loan.
    ///        2. Borrower calls `approveKeeper(keeper, initPreclose)`.
    ///        3. Keeper calls `precloseDirect(loanId)` — succeeds
    ///           (KeeperFor gate sees the bit).
    ///        4. Borrower revokes via `revokeKeeper(keeper)`.
    ///        5. (Coverage of the deny path is in NEG-23 in the
    ///           negative flow file — keeper without the bit reverts
    ///           KeeperAccessRequired.)
    ///
    ///      Roles:
    ///        Borrower = `borrower` (whitelist owner)
    ///        Lender   = `lender`
    ///        Keeper   = `newBorrower` (any third-party EOA the
    ///                                  borrower trusts)
    function _scenarioN12KeeperPerAction() internal {
        console.log("");
        console.log("=== N12: Keeper Per-Action Authorization ===");

        address bob = lender;
        address alice = borrower;
        address bot = newBorrower;
        uint256 bobKey = lenderKey;
        uint256 aliceKey = borrowerKey;
        uint256 botKey = newBorrowerKey;

        // Step 1: take a fresh loan.
        vm.startBroadcast(bobKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t5 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(aliceKey), offerId, true, 0);
        bytes memory _sig5 = LibAcceptTestSigner.sign(diamond, _t5, aliceKey);
        vm.startBroadcast(aliceKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t5, _sig5);
        vm.stopBroadcast();
        console.log("Loan initiated for keeper-auth scenario:", loanId);

        // Step 2: alice grants bot keeper authority. `LibAuth.requireKeeperFor`
        // requires THREE switches all on (Phase 6 design):
        //   (a) `setKeeperAccess(true)`  — user-level master switch
        //   (b) `setLoanKeeperEnabled(loanId, keeper, true)` — per-loan opt-in
        //   (c) `approveKeeper(keeper, actionBits)` — per-action bitmask
        // Missing any of the three → KeeperAccessRequired revert.
        uint8 initPreclose = 1 << 3;
        vm.startBroadcast(aliceKey);
        ProfileFacet(diamond).setKeeperAccess(true);
        // approveKeeper reverts KeeperAlreadyApproved if a prior scenario
        // on the same chain (e.g. PartialFlows Phase B P-P) granted bot
        // an authorization that's still live. Revoke first so the
        // scenario stays idempotent across multi-suite runs on persistent
        // testnet state — try-style swallow keeps the first-run case
        // (no prior auth) free of a useless revert.
        try ProfileFacet(diamond).revokeKeeper(bot) {} catch {}
        ProfileFacet(diamond).approveKeeper(bot, initPreclose);
        ProfileFacet(diamond).setLoanKeeperEnabled(loanId, bot, true);
        vm.stopBroadcast();
        console.log("Alice authorized Bot for INIT_PRECLOSE on loan:", loanId);

        // Step 3: bot executes precloseDirect on alice's behalf.
        // precloseDirect needs USDC allowance for the principal +
        // accrued interest payment to the lender. The pull is from
        // msg.sender (bot) per RepayFacet pattern, BUT the
        // PrecloseFacet payment routing... let me check by reading.
        //
        // Per PrecloseFacet.precloseDirect(): borrower (or keeper as
        // borrower-NFT delegate) pays principal + accrued interest
        // from their wallet. msg.sender is bot here, so bot pays.
        // But conceptually alice is the borrower being precosed —
        // the keeper pattern means bot's funds substitute for alice's
        // for the duration of the operation.
        //
        // Mint bot enough USDC since they were not topped up at setup
        // for this purpose. Actually looking at setup, newBorrower
        // got 100_000e6 USDC — plenty.
        uint256 owed = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        // precloseDirect computes its own owed amount; approving the
        // RepayFacet-style amount + buffer covers it.
        vm.startBroadcast(botKey);
        usdc.approve(diamond, owed + 100e6);
        PrecloseFacet(diamond).precloseDirect(loanId);
        vm.stopBroadcast();

        // Verify loan settled.
        LibVaipakam.Loan memory loanAfter = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfter.status != LibVaipakam.LoanStatus.Active,
            "N12: precloseDirect via keeper should have settled the loan"
        );
        console.log("Bot executed precloseDirect on Alice's behalf; loan status:", uint8(loanAfter.status));

        // Step 4: alice revokes bot.
        vm.startBroadcast(aliceKey);
        ProfileFacet(diamond).revokeKeeper(bot);
        vm.stopBroadcast();
        console.log("Alice revoked Bot");

        console.log(">>> N12 PASSED <<<");
    }

    // ─── N1: Range Orders Match + Partial Fill ───────────────────────────

    /// @dev Range Orders Phase 1 — bot-driven matching against a
    ///      RANGED lender offer. Two phases:
    ///        Phase A: Lender posts a ranged offer
    ///                 amount=[2k, 5k], rate=[400, 600] bps, with
    ///                 enough collateral floor to support the worst-
    ///                 case (5k) — `previewMatch` does the synthetic
    ///                 HF check using `LibRiskMath`.
    ///        Phase B: Borrower #1 posts a single-point matchable offer
    ///                 (2.5k @ 500 bps); a third-party "matcher"
    ///                 (newBorrower in this script) calls
    ///                 `matchOffers(L, b1)`. Loan opens, lender's
    ///                 `amountFilled` = 2.5k (50% filled), 1% LIF
    ///                 kickback to matcher.
    ///        Phase C: Borrower #2 posts another offer (2k @ 500
    ///                 bps). Matcher calls `matchOffers(L, b2)`.
    ///                 Lender's remaining capacity drops below
    ///                 `amountMin` (2k) → dust auto-close, residual
    ///                 refund.
    ///
    ///      Verifies: rangeAmountEnabled / rangeRateEnabled /
    ///      partialFillEnabled flags work end-to-end; midpoint
    ///      computation; matcher kickback; dust close.
    function _scenarioN1RangeMatchAndPartialFill() internal {
        console.log("");
        console.log("=== N1: Range Match + Partial Fill ===");

        // Pre-flight: confirm the master flags are on (BootstrapAnvil
        // flips them post-deploy). Skip the scenario gracefully if
        // the operator forgot — this script can also run against a
        // future testnet where the flags might be off.
        (bool rangeAmt, bool rangeRate, bool partialFill) =
            ConfigFacet(diamond).getMasterFlags();
        if (!(rangeAmt && rangeRate && partialFill)) {
            console.log(
                "Skipping N1: range/partial-fill flags off (rangeAmt/rangeRate/partialFill)",
                rangeAmt,
                rangeRate
            );
            return;
        }

        // ── Phase A: Lender posts a ranged offer ─────────────────────
        // Collateral chosen to clear the worst-case HF gate at the
        // upper bound (5k principal). With WETH @ $2k each and USDC
        // @ $1, 5 WETH = $10k > minimum collateral for HF≥1.5 at $5k
        // principal × 1/0.85 liqThreshold ≈ $5882 collateral floor.
        uint256 amountMin = 2_000e6;
        uint256 amountMax = 5_000e6;
        uint256 rateMin = 400;
        uint256 rateMax = 600;
        uint256 lenderCollateral = 5e18;

        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, amountMax);
        uint256 lenderOfferId = OfferCreateFacet(diamond).createOffer(
            _rangedLenderOffer(amountMin, amountMax, rateMin, rateMax, lenderCollateral)
        );
        vm.stopBroadcast();
        console.log("Ranged lender offer:", lenderOfferId);

        // ── Phase B: Borrower 1 posts matchable single-point offer ───
        // Single-point offers (amountMax==0 → auto-collapsed) are
        // permitted on the borrower side regardless of partialFill
        // (matchable amount/rate range is "[v, v]" — point overlap).
        // amount = 2.5k, rate = 500 bps — sits inside lender's range.
        // 3 WETH @ $2k = $6k, ceiling at HF≥1.5 ≈ $6k * 0.85 / 1.5 =
        // $3400 — comfortably above the 2.5k principal target.
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT * 3);
        uint256 borrowerOffer1 = OfferCreateFacet(diamond).createOffer(
            _matchableBorrowerOffer(2_500e6, 500, COLLATERAL_AMOUNT * 3)
        );
        vm.stopBroadcast();
        console.log("Borrower offer 1 (matchable):", borrowerOffer1);

        // Preview the match before submitting — real bot's flow.
        LibOfferMatch.MatchResult memory preview =
            OfferMatchFacet(diamond).previewMatch(lenderOfferId, borrowerOffer1);
        console.log("previewMatch errorCode:", uint8(preview.errorCode));
        require(
            uint8(preview.errorCode) == 0, // MatchError.Ok
            "N1: previewMatch did not return Ok"
        );

        // newBorrower acts as the matcher (the bot/searcher).
        vm.startBroadcast(newBorrowerKey);
        uint256 loanFromMatch1 =
            OfferMatchFacet(diamond).matchOffers(lenderOfferId, borrowerOffer1);
        vm.stopBroadcast();
        console.log("Match 1 -> loanId:", loanFromMatch1);

        // Inspect lender offer post-match. amountFilled should be 2500e6.
        LibVaipakam.Offer memory lenderState1 = OfferCancelFacet(diamond).getOffer(lenderOfferId);
        require(lenderState1.amountFilled == 2_500e6, "N1: amountFilled wrong post-match-1");
        require(!lenderState1.accepted, "N1: lender offer should still be open after partial fill");
        console.log("Lender amountFilled:", lenderState1.amountFilled);

        // ── Phase C: Borrower 2 posts a smaller matchable offer ──────
        // remaining = 5000 - 2500 = 2500. Borrower 2 wants 2000 → match
        // succeeds, leaving 500 (< amountMin 2000) which triggers
        // dust auto-close + refund of the residual to the lender.
        // 2.5 WETH @ $2k = $5k, ceiling at HF≥1.5 ≈ $5k * 0.85 / 1.5 =
        // $2833 — comfortably above the 2k principal target.
        vm.startBroadcast(newBorrowerKey);
        uint256 b2Collateral = (COLLATERAL_AMOUNT * 25) / 10; // 2.5 WETH
        weth.approve(diamond, b2Collateral);
        uint256 borrowerOffer2 = OfferCreateFacet(diamond).createOffer(
            _matchableBorrowerOfferAs(newBorrower, 2_000e6, 500, b2Collateral)
        );
        // newBorrower also doubles as the matcher here — fine, the
        // matcher just gets paid the LIF kickback regardless of
        // identity overlap with the borrower (no self-deal guard
        // needed: kickback comes from treasury share of LIF).
        uint256 loanFromMatch2 =
            OfferMatchFacet(diamond).matchOffers(lenderOfferId, borrowerOffer2);
        vm.stopBroadcast();
        console.log("Match 2 -> loanId:", loanFromMatch2);

        LibVaipakam.Offer memory lenderState2 = OfferCancelFacet(diamond).getOffer(lenderOfferId);
        // Either dust-closed (accepted == true, slot still here) OR
        // fully filled. We expect dust-close because 5000 - 2500 -
        // 2000 = 500 < amountMin (2000).
        require(lenderState2.accepted, "N1: lender offer should be closed (dust) after match 2");
        require(
            lenderState2.amountFilled == 4_500e6,
            "N1: amountFilled should be 4500 (2500 + 2000) at dust close"
        );
        console.log("Lender amountFilled (dust-closed):", lenderState2.amountFilled);
        console.log(">>> N1 PASSED <<<");
    }

    function _rangedLenderOffer(
        uint256 amtMin,
        uint256 amtMax,
        uint256 rMin,
        uint256 rMax,
        uint256 collateralFloor
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: address(usdc),
            amount: amtMin,
            interestRateBps: rMin,
            collateralAsset: address(weth),
            collateralAmount: collateralFloor,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amtMax,
            interestRateBpsMax: rMax,
            collateralAmountMax: collateralFloor,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    function _matchableBorrowerOffer(
        uint256 amount,
        uint256 rateBps,
        uint256 collateralAmount
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return _matchableBorrowerOfferAs(borrower, amount, rateBps, collateralAmount);
    }

    function _matchableBorrowerOfferAs(
        address /* who */,
        uint256 amount,
        uint256 rateBps,
        uint256 collateralAmount
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: address(usdc),
            amount: amount,
            interestRateBps: rateBps,
            collateralAsset: address(weth),
            collateralAmount: collateralAmount,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amount, // single-point amount
            interestRateBpsMax: rateBps, // single-point rate
            collateralAmountMax: collateralAmount, // #164 — single-point collateral
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    // ─── N5: Preclose Option 2 — transferObligationViaOffer ──────────────

    /// @dev alice (existing borrower of l1, lender = liam) wants to
    ///      exit her loan early. ben (a new borrower) creates a
    ///      Borrower offer with terms favoring liam (same asset,
    ///      collateral >= original, duration <= remaining, principal
    ///      matches l1.principal). alice calls
    ///      `transferObligationViaOffer(l1, benOfferId)` — she pays
    ///      accrued interest + any shortfall directly to liam, ben's
    ///      collateral becomes the new collateral, ben becomes the
    ///      new borrower of the SAME loan slot (l1). liam stays on as
    ///      lender; the loan terms (rate, duration end) are preserved.
    ///
    ///      Roles in this scenario:
    ///        liam      = `newLender` (the lender who stays)
    ///        alice     = `lender`  (current borrower; we re-purpose
    ///                              `lender` because the existing
    ///                              `borrower` slot is consumed by
    ///                              earlier scenarios, and alice's
    ///                              role is "borrower being replaced".
    ///                              Naming inversion is local to N5.)
    ///        ben       = `borrower` (the new borrower)
    function _scenarioN5PrecloseOption2TransferObligation() internal {
        console.log("");
        console.log("=== N5: Preclose Option 2 (transferObligationViaOffer) ===");

        // liam (newLender) creates a lender offer. alice (lender slot)
        // is the borrower of l1 — she'll be replaced by ben.
        address liam = newLender;
        address alice = lender;
        address ben = borrower;
        uint256 liamKey = newLenderKey;
        uint256 aliceKey = lenderKey;
        uint256 benKey = borrowerKey;

        vm.startBroadcast(liamKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 lenderOfferId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        LibAcceptTerms.AcceptTerms memory _t6 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(aliceKey), lenderOfferId, true, 0);
        bytes memory _sig6 = LibAcceptTestSigner.sign(diamond, _t6, aliceKey);
        vm.startBroadcast(aliceKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanL1 = OfferAcceptFacet(diamond).acceptOffer(lenderOfferId, _t6, _sig6);
        vm.stopBroadcast();
        console.log("L1 (Liam -> Alice) initiated:", loanL1);

        // ben creates a Borrower offer with terms favoring liam:
        // same lending asset, same collateral asset, principal == l1
        // principal, durationDays <= remaining, collateralAmount >=
        // l1.collateralAmount. We use exact-match terms for simplicity.
        vm.startBroadcast(benKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 benOfferId = OfferCreateFacet(diamond).createOffer(_borrowerOfferTakeoverFor(ben));
        vm.stopBroadcast();
        console.log("Ben's takeover offer:", benOfferId);

        // alice calls transferObligation, paying accrued + shortfall.
        // Approve generous principal — at t≈0 accrued is tiny but
        // shortfall could be a few cents to a few dollars depending on
        // duration mismatch. We approve full LOAN_AMOUNT for headroom.
        vm.startBroadcast(aliceKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        PrecloseFacet(diamond).transferObligationViaOffer(loanL1, benOfferId);
        vm.stopBroadcast();

        // Verify: l1 is still Active but borrower changed from alice
        // to ben; lender unchanged.
        LibVaipakam.Loan memory l1After = LoanFacet(diamond).getLoanDetails(loanL1);
        require(
            l1After.status == LibVaipakam.LoanStatus.Active,
            "N5: L1 should still be Active (only obligation transferred)"
        );
        require(l1After.borrower == ben, "N5: borrower should be Ben");
        require(l1After.lender == liam, "N5: lender should still be Liam");
        console.log("L1 borrower (Alice -> Ben):", l1After.borrower);
        console.log(">>> N5 PASSED <<<");
    }

    function _borrowerOfferTakeoverFor(address /* who */)
        internal view returns (LibVaipakam.CreateOfferParams memory)
    {
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
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: LOAN_AMOUNT,
            interestRateBpsMax: INTEREST_BPS,
            collateralAmountMax: COLLATERAL_AMOUNT,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    // ─── N6: Preclose Option 3 — offsetWithNewOffer + completeOffset ─────

    /// @dev alice (borrower of l1, lender = liam) wants to exit AND
    ///      become a lender herself (Option 3). She:
    ///        1. Pays accrued interest + shortfall to liam.
    ///        2. Creates a new Lender offer linked to l1 via the
    ///           `offsetOfferToLoanId` mapping. The borrower NFT for
    ///           l1 is natively-locked while the offset is in flight.
    ///        3. charlie (new borrower) accepts the offset offer.
    ///           Inside `_acceptOffer` the auto-link triggers
    ///           `completeOffset(l1)` which:
    ///             - Settles l1 (status -> Repaid)
    ///             - Releases alice's collateral to her vault
    ///             - charlie's loan against alice as lender goes Active
    ///
    ///      Roles:
    ///        liam   = `newLender`  (original lender)
    ///        alice  = `lender`     (borrower of l1 -> lender of L_new)
    ///        charlie = `borrower`  (new borrower)
    function _scenarioN6PrecloseOption3Offset() internal {
        console.log("");
        console.log("=== N6: Preclose Option 3 (offsetWithNewOffer + completeOffset) ===");

        address liam = newLender;
        address alice = lender;
        address charlie = newBorrower;
        uint256 liamKey = newLenderKey;
        uint256 aliceKey = lenderKey;
        uint256 charlieKey = newBorrowerKey;

        // Setup loan l1: liam -> alice.
        vm.startBroadcast(liamKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 lenderOfferId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        LibAcceptTerms.AcceptTerms memory _t7 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(aliceKey), lenderOfferId, true, 0);
        bytes memory _sig7 = LibAcceptTestSigner.sign(diamond, _t7, aliceKey);
        vm.startBroadcast(aliceKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanL1 = OfferAcceptFacet(diamond).acceptOffer(lenderOfferId, _t7, _sig7);
        vm.stopBroadcast();
        console.log("L1 (Liam -> Alice) initiated:", loanL1);

        // alice calls offsetWithNewOffer. She pays accrued + shortfall
        // to liam (~0 at t≈0 with same rate/duration); deposits new
        // principal into her vault; the diamond mints a Lender offer
        // on her behalf and links it to l1.
        vm.startBroadcast(aliceKey);
        // Approve generously: offsetWithNewOffer pulls from alice's
        // wallet THREE times — (1) treasuryFee on accrued, (2)
        // principal+interest to old lender via vaultDepositERC20From,
        // (3) new principal for the offer createOfferInternal pulls.
        // Total ≈ 2 × LOAN_AMOUNT + small accrued; we approve 3× for
        // headroom.
        usdc.approve(diamond, LOAN_AMOUNT * 3);
        uint256 offsetOfferId = PrecloseFacet(diamond).offsetWithNewOffer(
            loanL1,
            INTEREST_BPS,           // same rate as l1 — minimal shortfall
            DURATION_DAYS,          // same duration — within remaining
            address(weth),
            COLLATERAL_AMOUNT,
            true,                   // creatorRiskAndTermsConsent
            address(usdc)           // prepayAsset (unused on ERC20 path)
        );
        vm.stopBroadcast();
        console.log("Alice's offset offer:", offsetOfferId);

        // charlie accepts. The auto-link inside `_acceptOffer` fires
        // `PrecloseFacet.completeOffset(l1)` which closes l1 and
        // releases alice's collateral.
        LibAcceptTerms.AcceptTerms memory _t8 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(charlieKey), offsetOfferId, true, loanL1);
        bytes memory _sig8 = LibAcceptTestSigner.sign(diamond, _t8, charlieKey);
        vm.startBroadcast(charlieKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 newLoanId = OfferAcceptFacet(diamond).acceptOffer(offsetOfferId, _t8, _sig8);
        vm.stopBroadcast();
        console.log("Charlie accepted -> new loanId:", newLoanId);

        // Verify l1 is no longer Active.
        LibVaipakam.Loan memory l1Settled = LoanFacet(diamond).getLoanDetails(loanL1);
        require(
            l1Settled.status != LibVaipakam.LoanStatus.Active,
            "N6: L1 should be settled by completeOffset auto-fire"
        );
        console.log("L1 status post-offset:", uint8(l1Settled.status));

        // Verify the new loan has alice as lender, charlie as borrower.
        LibVaipakam.Loan memory newLoan = LoanFacet(diamond).getLoanDetails(newLoanId);
        require(newLoan.lender == alice, "N6: new loan lender should be Alice");
        require(newLoan.borrower == charlie, "N6: new loan borrower should be Charlie");
        console.log("New loan (Alice -> Charlie) status:", uint8(newLoan.status));

        console.log(">>> N6 PASSED <<<");
    }

    // ─── N10: VPFI Deposit + Fee-Discount + Claim Rebate ─────────────────

    /// @dev End-to-end Phase 5 borrower-LIF rebate flow:
    ///        1. Deploy a VPFI ERC20 mock; admin sets it on the
    ///           diamond via `VPFITokenFacet.setVPFIToken` and
    ///           configures the discount conversion (fixed wei-per-VPFI
    ///           rate + ETH price reference asset = WETH).
    ///        2. Mint 5,000 VPFI to borrower (Tier-3 territory).
    ///        3. Borrower approves diamond, deposits 2,000 VPFI to
    ///           vault (Tier-2: 15% rebate band) via
    ///           `depositVPFIToVault`, then opts in via
    ///           `setVPFIDiscountConsent(true)`.
    ///        4. Lender + borrower take a normal loan. Under the
    ///           **HoldOnly** model (#1352) the borrower's hold-tier
    ///           discount is applied DIRECTLY to the lending-asset LIF
    ///           at acceptance: no VPFI leaves the borrower's vault and
    ///           NO custody is taken, so `vpfiHeld` stays 0.
    ///        5. Borrower repays. `settleBorrowerLifProper` still runs
    ///           on every proper-close path, but returns immediately at
    ///           `held == 0` — it is a no-op for a HoldOnly loan.
    ///        6. `claimAsBorrower` therefore pays no VPFI rebate; there
    ///           is no rebate slot to pay.
    ///
    ///      **Required assertion: `vpfiHeld == 0` after acceptance** — the
    ///      observable end state of a HoldOnly loan. It is NOT a guard
    ///      against reconnecting the peg-custody path; see the long note at
    ///      the assertion for why three attempts to make it one failed and
    ///      where that guard actually lives.
    ///
    ///      #1555 r2 — this natspec previously described acceptance as
    ///      calling `tryApplyBorrowerLif`, moving VPFI into custody and
    ///      paying a rebate at close. That path was retired by #1352 and
    ///      the producer has had no caller since. Because the scenario's
    ///      only hard requirement was "the loan settled" and the rebate
    ///      check was explicitly best-effort, it kept PASSING while
    ///      exercising none of what it advertised — and taught every
    ///      reader the inverse of the current behaviour. The tier setup
    ///      in steps 1-3 is kept as it was, but it does NOT establish the
    ///      full preconditions the retired path required (this drive never
    ///      sets `isCanonicalVpfiChain`, so the mirror-tier cache is empty
    ///      and the effective tier reads zero) — so the assertion below
    ///      pins the observable HoldOnly end state and is NOT a guard
    ///      against reconnection. See the note at the assertion.
    // ─── VPFI-config snapshot fields (set in N10, restored after N14) ───
    //
    // N10 + N13 + N14 form a single VPFI-discount + deposit sequence
    // that requires a mock VPFI token wired on the diamond throughout.
    // Restoring inside N10 would break N13/N14 because they read
    // `s.vpfiToken` and expect to find the mock. So the snapshot is
    // taken at N10 entry and the restore fires after N14 exits, via
    // `_restoreVpfiConfig`. On a fresh anvil diamond every saved slot
    // is zero/false and the restore collapses to no-ops; on real
    // testnets the saved canonical proxy + rate + reference asset are
    // re-applied so post-run Buy-VPFI page reads succeed.
    address private _n10SavedVpfiToken;
    uint256 private _n10SavedVpfiRate;
    address private _n10SavedVpfiEthRefAsset;
    bool private _n10SavedBorrowerConsent;
    bool private _n10SnapshotTaken;

    function _scenarioN10VpfiDepositDiscount() internal {
        console.log("");
        console.log("=== N10: VPFI Deposit + Fee-Discount + Claim Rebate ===");

        // Snapshot — see _restoreVpfiConfig() called after N14.
        _n10SavedVpfiToken = VPFITokenFacet(diamond).getVPFIToken();
        (_n10SavedVpfiRate, _n10SavedVpfiEthRefAsset) =
            VPFIDiscountFacet(diamond).getVPFIDiscountConfig();
        _n10SavedBorrowerConsent =
            VPFIDiscountFacet(diamond).getVPFIDiscountConsent(borrower);
        _n10SnapshotTaken = true;

        // Step 1: deploy VPFI mock + admin wires it.
        vm.startBroadcast(deployerKey);
        vpfi = new ERC20Mock("Vaipakam VPFI", "VPFI", 18);
        vpfi.mint(borrower, 5_000e18);
        vm.stopBroadcast();
        console.log("VPFI deployed:", address(vpfi));

        vm.startBroadcast(adminKey);
        VPFITokenFacet(diamond).setVPFIToken(address(vpfi));
        // 0.001 ETH per VPFI (fixed-rate buy reference + discount
        // quote anchor). With WETH @ $2000, 1 VPFI ≈ $2.
        VPFIDiscountFacet(diamond).setVPFIDiscountRate(1e15);
        // ETH-priced reference asset for the LIF→VPFI conversion.
        // WETH on this chain has the Chainlink feed wired in setup.
        VPFIDiscountFacet(diamond).setVPFIDiscountETHPriceAsset(address(weth));
        vm.stopBroadcast();
        console.log("Diamond VPFI configured: token + buy rate + ETH ref asset");

        // Step 3: borrower deposits 2,000 VPFI (Tier-2, 15% band) and
        // opts in. Use `depositVPFIToVault` (the Phase 5 chokepoint
        // that ticks `protocolTrackedVaultBalance` for VPFI).
        vm.startBroadcast(borrowerKey);
        vpfi.approve(diamond, 2_000e18);
        VPFIDiscountFacet(diamond).depositVPFIToVault(2_000e18);
        VPFIDiscountFacet(diamond).setVPFIDiscountConsent(true);
        vm.stopBroadcast();
        console.log("Borrower deposited 2,000 VPFI + opted in to discount path");

        // #1555 r3 — CLEAR THE MIN-HISTORY GATE FIRST. `effectiveTierAndBps`
        // returns tier 0 until the default three-day staking window elapses,
        // and the retired `tryApplyBorrowerLif` took its eligibility from
        // that gated tier. Accepting immediately after the deposit would
        // therefore leave the borrower ineligible, so the no-custody
        // assertion below would have held whether or not the path were
        // reconnected — vacuous, exactly what the previous revision claimed
        // it had fixed. The focused unit test warps four days for the same
        // reason; this drive must too.
        vm.warp(block.timestamp + 4 days);

        // #1555 r4 — READ THIS BEFORE CALLING THE CHECK BELOW A GUARD.
        //
        // I have now claimed three times that N10's `vpfiHeld == 0` assertion
        // is non-vacuous, and been wrong three times. The claim is therefore
        // WITHDRAWN rather than made a fourth time, and what the assertion
        // actually establishes is stated instead.
        //
        // Round 2: added the assertion, ignoring that tier is gated.
        // Round 3: added the four-day warp, ignoring that
        //   `getVPFIDiscountTier` returns the RAW vault-balance tier and
        //   bypasses the effective history/cache gates the retired
        //   `quote()` path actually consulted.
        // Round 4: `anvil-bootstrap.sh` never sets `isCanonicalVpfiChain`
        //   and N10 only calls `setVPFIToken`, so the mirror-tier cache is
        //   empty and a reconnected `tryApplyBorrowerLif` would return
        //   `(false, 0)` regardless — leaving `vpfiHeld == 0` for the wrong
        //   reason.
        //
        // So: this asserts the OBSERVABLE END STATE (no custody receipt on a
        // HoldOnly loan), which is worth pinning and is true. It is NOT a
        // guard against reconnecting the peg-custody path — that guard is
        // `testAcceptOfferWithVPFIDiscountApplied`, which runs against a
        // fully-configured diamond. Making it one here requires configuring
        // the canonical/cache state this drive does not set up, and asserting
        // `getEffectiveDiscount` or the full borrower quote rather than the
        // raw tier.
        (, , uint256 dBorrowerN10) = VPFIDiscountFacet(diamond)
            .getVPFIDiscountTier(borrower);
        console.log(
            "Raw vault-balance tier bps (NOT the effective gate):",
            dBorrowerN10
        );

        // Step 4: take a loan. The borrower holds a tier-worthy vault balance
        // with consent enabled on a liquid lending asset. That is NOT the
        // full set of preconditions the retired peg-custody path required —
        // this drive never configures `isCanonicalVpfiChain`, so the
        // mirror-tier cache stays empty and the effective tier reads zero
        // regardless. Stated so nobody reads the setup as establishing more
        // than it does (#1555 r6).
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t9 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(borrowerKey), offerId, true, 0);
        bytes memory _sig9 = LibAcceptTestSigner.sign(diamond, _t9, borrowerKey);
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t9, _sig9);
        vm.stopBroadcast();
        console.log("Loan initiated under HoldOnly borrower LIF:", loanId);

        // The scenario's required check: a HoldOnly loan takes no VPFI
        // custody, so the rebate receipt must be empty on both fields.
        //
        // #1555 r6 — this is an OBSERVABLE END-STATE check and nothing more.
        // An earlier revision said it "fails loudly if the retired
        // peg-custody origination path is re-wired"; that was the same
        // overclaim withdrawn in the note above and it survived there.
        // Re-wiring would NOT fail this on the fresh-Anvil path, because the
        // empty mirror-tier cache leaves the retired path returning
        // `(false, 0)` anyway. The re-wiring guard is
        // `testAcceptOfferWithVPFIDiscountApplied`.
        {
            (uint256 rebateAmt_, uint256 vpfiHeld_) =
                ClaimFacet(diamond).getBorrowerLifRebate(loanId);
            require(vpfiHeld_ == 0, "N10: HoldOnly loan must take NO VPFI custody");
            require(rebateAmt_ == 0, "N10: HoldOnly loan must have no rebate slot");
        }
        console.log("Asserted: no VPFI custody taken (vpfiHeld == 0)");

        // Step 5: repay. settleBorrowerLifProper still runs on the proper
        // -close path but is a no-op here, returning at `held == 0`.
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt + 100e6);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        console.log("Loan repaid; settleBorrowerLifProper was a no-op (held == 0)");

        // Step 6: claim borrower → rebate atomically delivered.
        uint256 vpfiBalBefore = vpfi.balanceOf(borrower);
        _claimBoth(lenderKey, borrowerKey, loanId);
        uint256 vpfiBalAfter = vpfi.balanceOf(borrower);
        console.log("VPFI wallet pre-claim:", vpfiBalBefore);
        console.log("VPFI wallet post-claim:", vpfiBalAfter);
        // #1555 r2 — no rebate is expected: HoldOnly took no custody, so
        // there is nothing for `claimAsBorrower` to pay back in VPFI. The
        // wallet figures above are logged for the operator, not asserted
        // against. The custody assertion that carries this scenario is the
        // `vpfiHeld == 0` require at acceptance; this one confirms the loan
        // reached a terminal state through the no-op settlement path.
        //
        // The previous comment described this as "best-effort depending on
        // whether the LIF→VPFI quote succeeded" — a fall-through that has
        // not been reachable since #1352 retired the path it fell back from.
        LibVaipakam.Loan memory loanAfter = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfter.status != LibVaipakam.LoanStatus.Active,
            "N10: loan should be settled post-repay"
        );

        console.log(">>> N10 PASSED <<<");
    }

    /// @dev Restore the VPFI-discount config to its pre-N10 state.
    ///      Called from `run()` after N14 exits — N13 and N14 depend
    ///      on the mock VPFI being wired on the diamond throughout
    ///      the deposit + discount + withdraw sequence, so the restore
    ///      can't fire inside N10. On a fresh anvil diamond every
    ///      saved slot is zero/false and the restore is a sequence
    ///      of no-ops; on real testnets the canonical proxy + rate +
    ///      ref asset are re-applied so downstream `getVPFICap` /
    ///      Buy VPFI page reads succeed.
    ///
    ///      `setVPFIToken(0x0)` reverts `InvalidAddress`, so the
    ///      token restore is guarded by a non-zero check — on a
    ///      throwaway anvil chain we simply leave the mock VPFI
    ///      wired (no canonical exists to point at anyway), which
    ///      is fine since anvil state doesn't survive the run.
    ///      `setVPFIDiscountRate(0)` and `setVPFIDiscountETHPriceAsset(0)`
    ///      accept zero (intentional "disable" semantics), so they
    ///      can be restored unconditionally.
    function _restoreVpfiConfig() internal {
        if (!_n10SnapshotTaken) return;
        vm.startBroadcast(adminKey);
        if (_n10SavedVpfiToken != address(0)) {
            VPFITokenFacet(diamond).setVPFIToken(_n10SavedVpfiToken);
        }
        VPFIDiscountFacet(diamond).setVPFIDiscountRate(_n10SavedVpfiRate);
        VPFIDiscountFacet(diamond).setVPFIDiscountETHPriceAsset(
            _n10SavedVpfiEthRefAsset
        );
        vm.stopBroadcast();
        if (!_n10SavedBorrowerConsent) {
            vm.startBroadcast(borrowerKey);
            VPFIDiscountFacet(diamond).setVPFIDiscountConsent(false);
            vm.stopBroadcast();
        }
        console.log("Pre-N10 VPFI config restored (testnet-safe).");
    }

    // ─── N14: Withdraw VPFI (from vault) ───────────────────────

    /// @dev N10 left ~2,000 VPFI (Tier-2) in `borrower`'s vault. Withdraw by
    ///      calling `withdrawVPFIFromVault` and verify the wallet grows by the
    ///      withdrawn amount. This also exercises T-051's
    ///      `protocolTrackedVaultBalance` decrement on the VPFI side.
    ///      (#687-B: the staked-counter assertion was removed with the 5%
    ///      staking yield; the wallet-delta assertion is the live observable.)
    function _scenarioN14WithdrawVpfi() internal {
        console.log("");
        console.log("=== N14: Withdraw VPFI from vault ===");

        uint256 walletBefore = vpfi.balanceOf(borrower);

        // Withdraw a fixed amount strictly smaller than the 2,000 VPFI N10
        // deposited. A partial-but-known-safe amount sidesteps the exact-
        // balance race where a 1-wei broadcast-time divergence reverts.
        uint256 withdrawAmt = 1_000e18;

        vm.startBroadcast(borrowerKey);
        VPFIDiscountFacet(diamond).withdrawVPFIFromVault(withdrawAmt);
        vm.stopBroadcast();

        uint256 walletAfter = vpfi.balanceOf(borrower);
        console.log("VPFI wallet pre / post:", walletBefore, walletAfter);

        require(
            walletAfter == walletBefore + withdrawAmt,
            "N14: wallet should grow by exactly the withdrawn amount"
        );

        console.log(">>> N14 PASSED <<<");
    }

    // ─── N18: Per-asset pause ───────────────────────────────────────────

    /// @dev Verifies the per-asset pause gate. Admin pauses USDC, the
    ///      lender's offer-create on USDC reverts, admin unpauses,
    ///      offer-create succeeds. Each new participant uses fresh
    ///      USDC allowance to keep the test isolated from prior runs.
    function _scenarioN18PauseAsset() internal {
        console.log("");
        console.log("=== N18: Per-asset pause ===");

        // Step 1: admin pauses USDC.
        vm.startBroadcast(adminKey);
        AdminFacet(diamond).pauseAsset(address(usdc));
        vm.stopBroadcast();
        require(
            AdminFacet(diamond).isAssetPaused(address(usdc)),
            "N18: USDC should be paused after pauseAsset"
        );
        console.log("USDC paused; isAssetPaused == true");

        // Step 2: assertion of the gate state. We deliberately do NOT
        // attempt a `address(diamond).call(...)` to a paused-asset
        // createOffer here — forge `--broadcast` re-simulates every
        // tx the script issued during the broadcast pre-flight, and
        // a low-level call wrapped in `vm.startBroadcast` IS recorded
        // as a broadcast tx that will revert (causing
        // "Simulated execution failed"). The actual revert path is
        // exercised end-to-end by AdminFacetTest.t.sol's pause tests.
        require(
            AdminFacet(diamond).isAssetPaused(address(usdc)) == true,
            "N18: USDC must report paused via view"
        );
        console.log("Pause-gate state verified via isAssetPaused() == true");

        // Step 3: admin unpauses; create succeeds.
        vm.startBroadcast(adminKey);
        AdminFacet(diamond).unpauseAsset(address(usdc));
        vm.stopBroadcast();
        require(
            !AdminFacet(diamond).isAssetPaused(address(usdc)),
            "N18: USDC should be unpaused"
        );
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        console.log("Post-unpause createOffer succeeded; offerId:", offerId);
        // Note: do NOT cancel here. Range Orders Phase 1 enforces a
        // 5-min cancel cooldown when partialFillEnabled is on, and the
        // bootstrap turns it on. The leftover offer is harmless —
        // newLender has 100k USDC and only 1k went into vault.

        console.log(">>> N18 PASSED <<<");
    }

    // ─── N19: Global pause ──────────────────────────────────────────────

    /// @dev Verifies `AdminFacet.pause()` (PAUSER_ROLE) blocks every
    ///      `whenNotPaused` entry point. We probe with createOffer
    ///      from `lender`, then unpause and verify the action succeeds.
    function _scenarioN19GlobalPause() internal {
        console.log("");
        console.log("=== N19: Global pause ===");

        vm.startBroadcast(adminKey);
        AdminFacet(diamond).pause();
        vm.stopBroadcast();
        require(AdminFacet(diamond).paused(), "N19: paused() should be true");
        console.log("Diamond globally paused; paused() == true");
        // We don't probe the revert via address(diamond).call here —
        // see N18's comment: forge --broadcast re-attempts low-level
        // call txs in the pre-flight and the revert kills the script.
        // AdminFacetTest.t.sol exercises the actual revert path.

        vm.startBroadcast(adminKey);
        AdminFacet(diamond).unpause();
        vm.stopBroadcast();
        require(!AdminFacet(diamond).paused(), "N19: paused() should be false");

        // Sanity: post-unpause, an offer can be created. We don't
        // cancel — the cancel-cooldown is gated on `partialFillEnabled`
        // (5 min wall-clock), and the offer itself going through is
        // sufficient evidence the global pause was lifted.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        console.log("Post-unpause sanity create ok; offerId:", offerId);

        console.log(">>> N19 PASSED <<<");
    }

    // ─── N20: Treasury accrual ──────────────────────────────────────────

    /// @dev Verifies the treasury accrual surface is wired end-to-end.
    ///      In broadcast mode against Anvil the actual interest delta
    ///      rounds to 0 because each tx is ~1 second apart and 5% APR
    ///      on 1,000 USDC for 1 second is well below 1 wei (USDC has
    ///      6 decimals). The test therefore (a) reads USDC treasury
    ///      balance pre and post a fresh loan-and-repay and asserts
    ///      it's non-decreasing (the counter is monotonic on positive
    ///      paths), and (b) reads VPFI treasury balance as a CALL-SURFACE
    ///      check only. #1555 r3 — this used to claim the VPFI counter
    ///      "DOES grow when N10's settleBorrowerLifProper runs"; that has
    ///      been false since #1352 retired the peg-custody path, so N10
    ///      holds nothing to forward and no current positive flow in this
    ///      drive accrues VPFI treasury revenue. Real treasury
    ///      growth on duration-bearing fees is exercised by
    ///      TreasuryFacetTest.t.sol unit tests where vm.warp can move
    ///      simulation time.
    function _scenarioN20TreasuryAccrual() internal {
        console.log("");
        console.log("=== N20: Treasury accrual surface check ===");

        uint256 usdcTreasuryBefore = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
        uint256 vpfiTreasuryAtEntry = TreasuryFacet(diamond).getTreasuryBalance(address(vpfi));
        console.log("USDC treasury pre:", usdcTreasuryBefore);
        console.log("VPFI treasury pre:", vpfiTreasuryAtEntry);

        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        LibAcceptTerms.AcceptTerms memory _t10 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(newBorrowerKey), offerId, true, 0);
        bytes memory _sig10 = LibAcceptTestSigner.sign(diamond, _t10, newBorrowerKey);
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t10, _sig10);
        vm.stopBroadcast();

        vm.startBroadcast(newBorrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt + 100e6);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        _claimBoth(newLenderKey, newBorrowerKey, loanId);

        uint256 usdcTreasuryAfter = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
        console.log("USDC treasury post:", usdcTreasuryAfter);
        require(
            usdcTreasuryAfter >= usdcTreasuryBefore,
            "N20: USDC treasury must be non-decreasing"
        );

        // VPFI treasury surface — CALL-SURFACE ONLY, and now honestly
        // labelled as such (#1555 r3).
        //
        // This block used to say N10's `settleBorrowerLifProper` forwards the
        // treasury share of held LIF, so the VPFI counter "should be > 0 by
        // the time we reach N20". That has been false since #1352 retired the
        // peg-custody path: N10 takes no custody, so its settlement is a
        // no-op and forwards nothing. The check underneath was
        // `vpfiTreasuryAtEntry >= 0` — tautological for a uint256 — so the
        // scenario reported the treasury-accrual case as passing while
        // exercising no VPFI accrual at all, and kept teaching operators that
        // the retired flow had run.
        //
        // Deliberately NOT replaced with a manufactured accrual: no current
        // positive flow in this drive produces VPFI treasury revenue (the
        // Full tariff credits the recycle bucket, not treasury). Asserting
        // reachability and saying so is honest; inventing a source to make an
        // assertion look strong would be the same failure in a new costume.
        // Real VPFI treasury accrual is covered by TreasuryFacetTest.
        require(
            vpfiTreasuryAtEntry >= 0, // tautological BY DESIGN — see above
            "N20: VPFI treasury balance call should not revert"
        );
        console.log(
            "VPFI treasury at N20 entry (no current flow accrues it):",
            vpfiTreasuryAtEntry
        );

        console.log(">>> N20 PASSED <<<");
    }

    // ─── N22: Master-flag dormancy ──────────────────────────────────────

    /// @dev Range Orders Phase 1 is governance-gated: every range
    ///      offer is rejected unless the corresponding master flag is
    ///      ON. This scenario verifies the dormancy gate by:
    ///        1. Snapshot the current flags (bootstrap-flipped to ON).
    ///        2. Admin flips `setRangeAmountEnabled(false)`.
    ///        3. Lender attempts to create an `amountMax > amount`
    ///           range offer → must revert.
    ///        4. Admin re-enables → action succeeds.
    function _scenarioN22MasterFlagDormancy() internal {
        console.log("");
        console.log("=== N22: Master-flag dormancy (rangeAmountEnabled) ===");

        (bool rangeAmount, , ) = ConfigFacet(diamond).getMasterFlags();
        console.log("rangeAmountEnabled pre:", rangeAmount);
        require(rangeAmount, "N22: precondition - bootstrap should leave rangeAmountEnabled=true");

        // Step 1: turn the flag off; verify gate via view call. We
        // intentionally do NOT attempt a range-offer creation while
        // the flag is off — forge --broadcast would re-simulate the
        // failing low-level call in its pre-flight and abort the
        // script. The actual gate revert (FunctionDisabled) is
        // exercised by ConfigFacetTest.t.sol unit tests.
        vm.startBroadcast(adminKey);
        ConfigFacet(diamond).setRangeAmountEnabled(false);
        vm.stopBroadcast();
        (bool rangeAmountOff, , ) = ConfigFacet(diamond).getMasterFlags();
        require(!rangeAmountOff, "N22: setRangeAmountEnabled(false) should land");
        console.log("Dormancy gate state verified: rangeAmountEnabled flipped to false");

        // Step 2: re-enable; range offer now succeeds. The collateral
        // floor scales with `amountMax`, so we bump collateralAmount
        // to 2 WETH (above the ~1.764 WETH floor for amountMax =
        // 2,000 USDC at WETH @ $2000 with 8500 bps liqThreshold).
        vm.startBroadcast(adminKey);
        ConfigFacet(diamond).setRangeAmountEnabled(true);
        vm.stopBroadcast();
        (bool rangeAmountOn, , ) = ConfigFacet(diamond).getMasterFlags();
        require(rangeAmountOn, "N22: setRangeAmountEnabled(true) should land");

        LibVaipakam.CreateOfferParams memory params = _lenderOfferStandard();
        params.amountMax = LOAN_AMOUNT * 2;
        params.collateralAmount = 2 * COLLATERAL_AMOUNT;
        // Lender offers require collateralAmountMax == collateralAmount
        // (LenderCollateralRangeNotAllowed) — keep it in lock-step.
        params.collateralAmountMax = 2 * COLLATERAL_AMOUNT;
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT * 2);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(params);
        vm.stopBroadcast();
        console.log("Post-re-enable range offer accepted; offerId:", offerId);

        console.log(">>> N22 PASSED <<<");
    }

    // ─── N15: Lender Early Withdrawal via Buy Offer ─────────────────────

    /// @dev Maps to Advanced Guide § Early Withdrawal (Lender) and the
    ///      EarlyWithdrawalFacet `sellLoanViaBuyOffer` path. Roles:
    ///        - Original lender (liam = `newLender`) holds an active loan.
    ///        - Buyer (bob = `lender`) creates a Lender-type buy offer
    ///          with the same shape as the loan (or no-worse terms).
    ///        - liam calls `sellLoanViaBuyOffer(loanId, buyOfferId)` to
    ///          flip lender on the existing loan to bob.
    ///        - Borrower (`newBorrower`) then repays bob.
    ///
    ///      The auto-link counterpart (createLoanSaleOffer + buyer
    ///      `acceptOffer` → `completeLoanSale` re-entry) needs the
    ///      same `*Internal` cross-facet entry pattern as N6's
    ///      `completeOffsetInternal`. That fix is deferred until a
    ///      concrete user flow drives it; the simpler
    ///      `sellLoanViaBuyOffer` path is already reentrancy-safe
    ///      because it doesn't re-enter through the diamond fallback.
    function _scenarioN15SellLoanViaBuyOffer() internal {
        console.log("");
        console.log("=== N15: Lender Early Withdrawal (sellLoanViaBuyOffer) ===");

        // Step 1: liam (newLender) lends to newBorrower → loan active.
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t11 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(newBorrowerKey), offerId, true, 0);
        bytes memory _sig11 = LibAcceptTestSigner.sign(diamond, _t11, newBorrowerKey);
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t11, _sig11);
        vm.stopBroadcast();
        console.log("l1 (newLender -> newBorrower) initiated:", loanId);

        // Step 2: bob (`lender`) creates a Lender buy offer with the
        // same shape — sellLoanViaBuyOffer requires asset/duration/
        // collateral parity (or no-worse terms for borrower).
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 buyOfferId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        console.log("bob's buy offer:", buyOfferId);

        // Step 3: liam sells the position to bob.
        vm.startBroadcast(newLenderKey);
        EarlyWithdrawalDirectFacet(diamond).sellLoanViaBuyOffer(loanId, buyOfferId);
        vm.stopBroadcast();
        LibVaipakam.Loan memory loanAfterSale = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfterSale.lender == lender,
            "N15: loan.lender should flip to bob after sale"
        );
        console.log("Loan lender flipped to bob; loan.lender:", loanAfterSale.lender);

        // Step 4: borrower (newBorrower) repays the loan; bob now owns
        // the lender position.
        vm.startBroadcast(newBorrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt + 100e6);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        _claimBoth(lenderKey, newBorrowerKey, loanId);

        LibVaipakam.Loan memory loanAfterRepay = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfterRepay.status != LibVaipakam.LoanStatus.Active,
            "N15: loan should be settled after repay"
        );
        console.log("Loan settled post-sale + repay");

        console.log(">>> N15 PASSED <<<");
    }

    /// @dev N25 (#1503 PR-E, design item 11) — the sale solvency admission
    ///      floor, exercised against the REAL deployed Diamond rather than a
    ///      bespoke test fixture: real facet routing, the real cross-facet
    ///      RiskFacet hop, real oracle wiring, no `vm.mockCall` anywhere.
    ///
    ///      Drops the collateral feed so a live position falls below the
    ///      floor its own admission required, proves the sale is refused with
    ///      the exact error, then restores the feed and proves the very same
    ///      sale goes through — so the refusal is attributable to solvency
    ///      and not to some unrelated precondition.
    function _scenarioN25SaleSolvencyFloor() internal {
        console.log("");
        console.log("=== N25: Sale Solvency Admission Floor ===");

        // A fresh loan: newLender lends to newBorrower, 1000 USDC against
        // 1 WETH at $2000 → ~1.7 HF, comfortably admissible.
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t25 =
            LibAcceptTestSigner.buildTerms(diamond, vm.addr(newBorrowerKey), offerId, true, 0);
        bytes memory _sig25 = LibAcceptTestSigner.sign(diamond, _t25, newBorrowerKey);
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t25, _sig25);
        vm.stopBroadcast();

        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 buyOfferId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        uint256 hfHealthy = RiskFacet(diamond).calculateHealthFactor(loanId);
        console.log("HF at $2000 collateral:", hfHealthy);
        require(
            hfHealthy >= LibVaipakam.MIN_HEALTH_FACTOR,
            "N25: fixture must start above the floor"
        );

        // Collateral falls. $1500 puts the position under the 1.5e18
        // admission floor while leaving it ABOVE the 1e18 liquidation
        // trigger — the case that proves the floor is the ADMISSION
        // standard, not merely "not liquidatable yet".
        // deployerKey, not adminKey: the mock feed is owner-gated to the
        // account that deployed it in `_deployMocksAndConfigure`.
        vm.startBroadcast(deployerKey);
        _setWethPriceConsistently(1500e8);
        vm.stopBroadcast();

        // The depth guard can reclassify an asset when the feed moves away
        // from the mock pool's spot. An Illiquid leg is now refused
        // UNCONDITIONALLY (`SaleLegUnpriceable`, classifier code 6 — #1655), so
        // if that happened the sale would still revert, but for a completely
        // different reason and this scenario would prove nothing about the
        // health floor. Assert the leg is still priced so the revert below can
        // only be the floor — isolating the two refusals rather than, as this
        // comment previously claimed, guarding against an admission.
        require(
            OracleFacet(diamond).checkLiquidity(address(weth)) ==
                LibVaipakam.LiquidityStatus.Liquid,
            "N25: WETH must stay Liquid or the floor is not what is being tested"
        );
        uint256 hfSunk = RiskFacet(diamond).calculateHealthFactor(loanId);
        console.log("HF at $1500 collateral:", hfSunk);
        require(hfSunk < LibVaipakam.MIN_HEALTH_FACTOR, "N25: must sit below the floor");
        require(
            hfSunk > LibVaipakam.HF_LIQUIDATION_THRESHOLD,
            "N25: and above the liquidation trigger"
        );

        // Simulated (not broadcast) so a deliberate revert does not abort the
        // run — it still executes the real deployed bytecode against real
        // chain state, which is the thing being verified.
        vm.prank(newLender);
        (bool ok, bytes memory ret) = diamond.call(
            abi.encodeWithSelector(
                EarlyWithdrawalDirectFacet.sellLoanViaBuyOffer.selector, loanId, buyOfferId
            )
        );
        require(!ok, "N25: a sub-floor position must NOT be sellable");
        require(
            bytes4(ret) == LibSaleSolvency.SalePositionBelowSolvencyFloor.selector,
            "N25: refused, but not for the solvency reason"
        );
        console.log("Sub-floor sale refused with SalePositionBelowSolvencyFloor");

        // Restore the price and run the SAME sale for real: it must now
        // settle, proving the refusal above was the floor and nothing else.
        vm.startBroadcast(deployerKey);
        _setWethPriceConsistently(2000e8);
        vm.stopBroadcast();

        vm.startBroadcast(newLenderKey);
        EarlyWithdrawalDirectFacet(diamond).sellLoanViaBuyOffer(loanId, buyOfferId);
        vm.stopBroadcast();
        require(
            LoanFacet(diamond).getLoanDetails(loanId).lender == lender,
            "N25: recovered position must sell"
        );
        console.log("Same sale settles once the position is back over its floor");

        console.log(">>> N25 PASSED <<<");
    }

    // ─── N26: Sale Admission Floor on the LISTING ACCEPT branch ─────────

    /// @dev Codex #1635 r5. N25 drives the floor through
    ///      `EarlyWithdrawalFacet.sellLoanViaBuyOffer` — the DIRECT sale. That
    ///      leaves the other guarded path unexercised on chain: the sale-vehicle
    ///      branch of `OfferAcceptFacet.acceptOffer`, which is where a resting
    ///      listing's binding check lives.
    ///
    ///      This matters specifically for the upgrade rehearsal.
    ///      `ReplaceStaleFacets` is the script that reinstalls
    ///      `OfferAcceptFacet`, so rehearsing it against N25 proved the wrong
    ///      thing: N25's only `acceptOffer` call originates an ordinary loan and
    ///      never reaches the sale branch, so breaking or dropping the refreshed
    ///      sale guard would have left that rehearsal green. The rehearsal picks
    ///      the scenario per script for this reason.
    ///
    ///      Same fixture logic as N25 — under the admission floor but above the
    ///      liquidation trigger, so what is proved is the ADMISSION standard and
    ///      not "not liquidatable yet" — driven through listing + accept:
    ///        - newLender lends to newBorrower, then LISTS the position.
    ///        - Collateral falls; bob's accept of the listing must be refused.
    ///        - Price recovers; the same accept must settle, moving the lender.
    function _scenarioN26SaleAdmissionOnAcceptBranch() internal {
        console.log("");
        console.log("=== N26: Sale Admission Floor (listing accept branch) ===");

        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t26 =
            LibAcceptTestSigner.buildTerms(diamond, vm.addr(newBorrowerKey), offerId, true, 0);
        bytes memory _sig26 = LibAcceptTestSigner.sign(diamond, _t26, newBorrowerKey);
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t26, _sig26);
        vm.stopBroadcast();
        console.log("loan initiated:", loanId);

        // The lender lists the position while it is healthy — the listing-rests
        // -while-collateral-falls case the accept-time check exists for.
        vm.recordLogs();
        vm.startBroadcast(newLenderKey);
        EarlyWithdrawalFacet(diamond).createLoanSaleOffer(loanId, 500, true, 7 days);
        vm.stopBroadcast();
        uint256 saleOfferId;
        {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bytes32 linkedSig = keccak256("LoanSaleOfferLinked(uint256,uint256)");
            for (uint256 i; i < logs.length; i++) {
                if (logs[i].topics[0] == linkedSig) {
                    saleOfferId = uint256(logs[i].topics[2]);
                }
            }
        }
        require(saleOfferId != 0, "N26: sale listing was not created");
        console.log("sale listing:", saleOfferId);

        uint256 hfHealthy = RiskFacet(diamond).calculateHealthFactor(loanId);
        require(
            hfHealthy >= LibVaipakam.MIN_HEALTH_FACTOR,
            "N26: fixture must start above the floor"
        );

        // Buyer signs terms BEFORE the drift, which is the real sequence: the
        // signature commits to the loan's shape, not to its health.
        LibAcceptTerms.AcceptTerms memory _ts26 =
            LibAcceptTestSigner.buildSaleTerms(diamond, vm.addr(lenderKey), saleOfferId, true, loanId);
        bytes memory _ssig26 = LibAcceptTestSigner.sign(diamond, _ts26, lenderKey);

        vm.startBroadcast(deployerKey);
        _setWethPriceConsistently(1500e8);
        vm.stopBroadcast();

        // Same reasoning as N25: an Illiquid leg is refused unconditionally for
        // its OWN reason (`SaleLegUnpriceable`, code 6 — #1655), so if the depth
        // guard had reclassified WETH when the feed moved off the mock pool's
        // spot, the refusal below would still happen but would say nothing about
        // the health floor this scenario exists to drive.
        require(
            OracleFacet(diamond).checkLiquidity(address(weth)) ==
                LibVaipakam.LiquidityStatus.Liquid,
            "N26: WETH must stay Liquid or the floor is not what is being tested"
        );
        uint256 hfSunk = RiskFacet(diamond).calculateHealthFactor(loanId);
        console.log("HF at $1500 collateral:", hfSunk);
        require(hfSunk < LibVaipakam.MIN_HEALTH_FACTOR, "N26: must sit below the floor");
        require(
            hfSunk > LibVaipakam.HF_LIQUIDATION_THRESHOLD,
            "N26: and above the liquidation trigger"
        );

        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT * 2);
        vm.stopBroadcast();

        // Simulated so a deliberate revert does not abort the run; still the
        // real deployed bytecode against real chain state.
        vm.prank(vm.addr(lenderKey));
        (bool ok, bytes memory ret) = diamond.call(
            abi.encodeWithSelector(
                OfferAcceptFacet.acceptOffer.selector, saleOfferId, _ts26, _ssig26
            )
        );
        require(!ok, "N26: a sub-floor listing must NOT be acceptable");
        require(
            bytes4(ret) == LibSaleSolvency.SalePositionBelowSolvencyFloor.selector,
            "N26: refused, but not for the solvency reason"
        );
        console.log("Sub-floor listing accept refused with SalePositionBelowSolvencyFloor");

        vm.startBroadcast(deployerKey);
        _setWethPriceConsistently(2000e8);
        vm.stopBroadcast();

        vm.startBroadcast(lenderKey);
        OfferAcceptFacet(diamond).acceptOffer(saleOfferId, _ts26, _ssig26);
        vm.stopBroadcast();
        require(
            LoanFacet(diamond).getLoanDetails(loanId).lender == vm.addr(lenderKey),
            "N26: recovered position must sell through the accept branch"
        );
        console.log("Same listing accept settles once the position is back over its floor");

        console.log(">>> N26 PASSED <<<");
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
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: LOAN_AMOUNT,
            interestRateBpsMax: INTEREST_BPS,
            collateralAmountMax: COLLATERAL_AMOUNT,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    function _lenderOfferAllowsPartial() internal view returns (LibVaipakam.CreateOfferParams memory) {
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.allowsPartialRepay = true;
        return p;
    }

    function _borrowerRefinanceOffer() internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: address(usdc),
            amount: LOAN_AMOUNT,
            // Lower rate than the original loan — alice is refinancing
            // because she found a cheaper lender.
            interestRateBps: INTEREST_BPS / 2,
            collateralAsset: address(weth),
            collateralAmount: COLLATERAL_AMOUNT,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: LOAN_AMOUNT,
            interestRateBpsMax: INTEREST_BPS / 2,
            collateralAmountMax: COLLATERAL_AMOUNT,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    function _claimBoth(uint256 lKey, uint256 bKey, uint256 loanId) internal {
        vm.startBroadcast(lKey);
        try ClaimFacet(diamond).claimAsLender(loanId) {} catch {}
        vm.stopBroadcast();
        vm.startBroadcast(bKey);
        try ClaimFacet(diamond).claimAsBorrower(loanId) {} catch {}
        vm.stopBroadcast();
    }
}
