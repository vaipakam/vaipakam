// script/AnvilNewPositiveFlows.s.sol
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
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3.sol";
import {MockSanctionsList} from "../test/mocks/MockSanctionsList.sol";
import {Deployments} from "./lib/Deployments.sol";

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
 *           N4  — Refinance (Alice has loan L1; she posts a new
 *                 borrower offer; Bob accepts → L2; Alice calls
 *                 `refinanceLoan(L1, newOfferId)` to swap lenders).
 *                 Maps to Advanced Guide § Refinance.
 *           N7  — Stuck-token recovery happy path (random ERC20 sent
 *                 to user's escrow, user signs the EIP-712
 *                 RecoveryAcknowledgment, calls `recoverStuckERC20`
 *                 with declaredSource ≠ self ≠ sanctioned, asset
 *                 returns to user).
 *                 Maps to Advanced Guide § Stuck-Token Recovery.
 *
 *         Subsequent waves (separate iterations):
 *           N1, N2, N5, N6  — range match, periodic interest, preclose Opt2/3
 *           N8, N9, N10, N11, N12 — recovery-ban, disown, VPFI staking
 *                                   + discount, sanctions Tier-1, keeper
 *                                   per-action authorization
 *
 *         Run order: anvil-bootstrap.sh first (deploys diamond +
 *         testnet liquidity mocks + flips Range Orders flags), then
 *         this script. Each scenario deploys its own fresh mock USDC /
 *         WETH so it is independent of the bootstrap's mock set.
 *
 *         Env vars (same shape as SepoliaPositiveFlows):
 *           PRIVATE_KEY, ADMIN_PRIVATE_KEY, ADMIN_ADDRESS,
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

        _scenarioN3_partialRepay();
        _scenarioN4_refinance();
        _scenarioN7_recoveryHappyPath();
        _scenarioN1_rangeMatchAndPartialFill();
        _scenarioN5_precloseOption2_transferObligation();
        _scenarioN6_precloseOption3_offset();

        console.log("");
        console.log("============================================");
        console.log("  WAVE 1+2 (N3, N4, N7, N1, N5, N6) PASSED");
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

        // Mock sanctions oracle — N7 (recoverStuckERC20) checks the
        // declaredSource against this oracle and reverts
        // SanctionsOracleUnavailable if it's address(0). Default
        // behaviour: every address returns un-flagged. Wave-3 N8 will
        // flag an address before signing to exercise the ban path.
        MockSanctionsList sanctions = new MockSanctionsList();
        console.log("MockSanctionsList:", address(sanctions));
        vm.stopBroadcast();

        // Phase 1b: admin role-gated config — point the Diamond's
        // oracle at the freshly-deployed registry/feeds, set risk
        // params, enable KYC bypass via Tier2, allow trade pair.
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
        ProfileFacet(diamond).setSanctionsOracle(address(sanctions));
        vm.stopBroadcast();

        _setCountryIfUnset(lenderKey, lender, "US");
        _setCountryIfUnset(borrowerKey, borrower, "US");
        _setCountryIfUnset(newLenderKey, newLender, "US");
        _setCountryIfUnset(newBorrowerKey, newBorrower, "US");

        console.log("Setup OK: oracle + risk params + KYC + countries.");
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
    function _scenarioN3_partialRepay() internal {
        console.log("");
        console.log("=== N3: Partial Repay ===");

        // Lender posts an offer with partial-repay opt-in ON.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferFacet(diamond).createOffer(_lenderOfferAllowsPartial());
        vm.stopBroadcast();
        console.log("Lender offer with allowsPartialRepay=true:", offerId);

        // Borrower accepts.
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferFacet(diamond).acceptOffer(offerId, true);
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

    /// @dev Alice (borrower) takes loan L1 from Lender A. Alice then
    ///      creates a new Borrower offer at a lower interest rate;
    ///      Lender B accepts the offer (creating loan L2). Alice now
    ///      holds Lender B's principal in hand. She calls
    ///      `refinanceLoan(L1, newOfferId)` which uses that principal
    ///      to repay Lender A and rolls the loan over to Lender B's
    ///      terms. End state: L1 settled, L2 active, single collateral
    ///      lock, no net principal movement to Alice (she just swapped
    ///      lenders).
    ///
    ///      Naming: `borrower` = Alice (the borrower being refinanced),
    ///              `lender` = Lender A (the original lender),
    ///              `newLender` = Lender B (the refinancing lender).
    function _scenarioN4_refinance() internal {
        console.log("");
        console.log("=== N4: Refinance ===");

        // Alice + Lender A create + accept an offer → loan L1.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerL1 = OfferFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanL1 = OfferFacet(diamond).acceptOffer(offerL1, true);
        vm.stopBroadcast();
        console.log("L1 (original loan) initiated:", loanL1);

        // Alice creates a NEW borrower offer with a lower rate — same
        // collateral asset / amount / duration so the asset-continuity
        // check in refinanceLoan passes. Pulls collateral from her
        // wallet again (she has 10 WETH per setup, plenty).
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 refinanceOfferId = OfferFacet(diamond).createOffer(_borrowerRefinanceOffer());
        vm.stopBroadcast();
        console.log("Alice's refinance borrower offer:", refinanceOfferId);

        // Lender B accepts — creates loan L2. Alice receives L2's
        // principal in her wallet.
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        OfferFacet(diamond).acceptOffer(refinanceOfferId, true);
        vm.stopBroadcast();

        // Alice repays Lender A using L2's principal. refinanceLoan is
        // a single-tx settle of L1 against the new offer — Alice signs.
        vm.startBroadcast(borrowerKey);
        // Refinance pays the OLD lender principal + full-term interest.
        // Alice approves enough to cover both.
        usdc.approve(diamond, LOAN_AMOUNT * 2);
        RefinanceFacet(diamond).refinanceLoan(loanL1, refinanceOfferId);
        vm.stopBroadcast();

        // Verify L1 is no longer Active (it's been settled by refinance).
        LibVaipakam.Loan memory l1After = LoanFacet(diamond).getLoanDetails(loanL1);
        require(
            l1After.status != LibVaipakam.LoanStatus.Active,
            "N4: L1 should not be Active after refinance"
        );
        console.log("L1 status post-refinance:", uint8(l1After.status));

        console.log(">>> N4 PASSED <<<");
    }

    // ─── N7: Stuck-Token Recovery (happy path) ────────────────────────────

    /// @dev A random USDC transfer lands directly on Alice's escrow
    ///      proxy (e.g., someone confused a contract address for a
    ///      wallet). The funds aren't accounted for in
    ///      `protocolTrackedEscrowBalance` because they didn't flow
    ///      through the chokepoint, so they're "stuck" — the loan /
    ///      offer paths can't move them. Alice notices via the Asset
    ///      Viewer page and uses the Recovery flow:
    ///        1. Look up `recoveryDomainSeparator()` + `recoveryNonce`.
    ///        2. Sign the EIP-712 `RecoveryAcknowledgment` for
    ///           (token, declaredSource, amount, deadline).
    ///        3. Call `recoverStuckERC20(token, declaredSource, amount,
    ///           deadline, signature)` with `declaredSource ≠ herself`
    ///           and not on the sanctions oracle.
    ///        4. Tokens transfer from her escrow back to her wallet.
    ///
    ///      End-state: Alice's wallet balance increases by the stray
    ///      amount; recovery nonce increments; no ban activates
    ///      (sanctioned-source path is N8, separate scenario).
    function _scenarioN7_recoveryHappyPath() internal {
        console.log("");
        console.log("=== N7: Stuck-Token Recovery happy path ===");

        // Alice (borrower) needs an escrow already created for the
        // stray transfer to have a target. createOffer is the simplest
        // way — she can cancel afterward to clean up. Faster: deposit
        // a token via a no-op deposit. Even faster: just call
        // `getOrCreateUserEscrow` from the Diamond's perspective.
        // We use a thin createOffer + cancelOffer dance to ensure the
        // escrow proxy exists and Alice is a known user.
        // Faster path actually used: lender or any other actor calls
        // getOrCreateUserEscrow on Alice's behalf via cross-facet ...
        // but that's diamond-internal. So we use `createOffer` for
        // Alice (we just need her escrow to exist).
        //
        // Actually `getOrCreateUserEscrow` is publicly callable per
        // the deploy-script selector list — Alice can call it
        // directly to provision her escrow.
        vm.startBroadcast(borrowerKey);
        address aliceEscrow = EscrowFactoryFacet(diamond).getOrCreateUserEscrow(borrower);
        vm.stopBroadcast();
        console.log("Alice escrow:", aliceEscrow);

        // The stray sender — we use `newBorrower` to play the role of
        // the third party who accidentally transferred to Alice's escrow.
        // declaredSource in Alice's recovery sig must match this address.
        uint256 strayAmount = 50e6; // 50 USDC stuck
        vm.startBroadcast(newBorrowerKey);
        usdc.transfer(aliceEscrow, strayAmount);
        vm.stopBroadcast();
        console.log("Stray USDC transferred to Alice's escrow:", strayAmount);

        // Build the EIP-712 digest and sign. Recovery typehash:
        //   RecoveryAcknowledgment(address user, address token,
        //                          address declaredSource, uint256 amount,
        //                          uint256 nonce, uint256 deadline,
        //                          bytes32 ackTextHash)
        bytes32 recTypehash = keccak256(
            "RecoveryAcknowledgment(address user,address token,address declaredSource,uint256 amount,uint256 nonce,uint256 deadline,bytes32 ackTextHash)"
        );
        bytes32 domainSep = EscrowFactoryFacet(diamond).recoveryDomainSeparator();
        bytes32 ackText = EscrowFactoryFacet(diamond).recoveryAckTextHash();
        uint256 nonce = EscrowFactoryFacet(diamond).recoveryNonce(borrower);
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
        EscrowFactoryFacet(diamond).recoverStuckERC20(
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
        uint256 nonceAfter = EscrowFactoryFacet(diamond).recoveryNonce(borrower);
        require(nonceAfter == nonce + 1, "N7: recovery nonce did not increment");

        console.log("Recovered to wallet (delta):", strayAmount);
        console.log("Recovery nonce:", nonce, "->", nonceAfter);
        console.log(">>> N7 PASSED <<<");
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
    ///                 `matchOffers(L, B1)`. Loan opens, lender's
    ///                 `amountFilled` = 2.5k (50% filled), 1% LIF
    ///                 kickback to matcher.
    ///        Phase C: Borrower #2 posts another offer (2k @ 500
    ///                 bps). Matcher calls `matchOffers(L, B2)`.
    ///                 Lender's remaining capacity drops below
    ///                 `amountMin` (2k) → dust auto-close, residual
    ///                 refund.
    ///
    ///      Verifies: rangeAmountEnabled / rangeRateEnabled /
    ///      partialFillEnabled flags work end-to-end; midpoint
    ///      computation; matcher kickback; dust close.
    function _scenarioN1_rangeMatchAndPartialFill() internal {
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
        uint256 lenderOfferId = OfferFacet(diamond).createOffer(
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
        uint256 borrowerOffer1 = OfferFacet(diamond).createOffer(
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
        uint256 borrowerOffer2 = OfferFacet(diamond).createOffer(
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
            creatorFallbackConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            amountMax: amtMax,
            interestRateBpsMax: rMax,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
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
            creatorFallbackConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            amountMax: 0,         // single-point amount
            interestRateBpsMax: 0,// single-point rate
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
        });
    }

    // ─── N5: Preclose Option 2 — transferObligationViaOffer ──────────────

    /// @dev Alice (existing borrower of L1, lender = Liam) wants to
    ///      exit her loan early. Ben (a new borrower) creates a
    ///      Borrower offer with terms favoring Liam (same asset,
    ///      collateral >= original, duration <= remaining, principal
    ///      matches L1.principal). Alice calls
    ///      `transferObligationViaOffer(L1, benOfferId)` — she pays
    ///      accrued interest + any shortfall directly to Liam, Ben's
    ///      collateral becomes the new collateral, Ben becomes the
    ///      new borrower of the SAME loan slot (L1). Liam stays on as
    ///      lender; the loan terms (rate, duration end) are preserved.
    ///
    ///      Roles in this scenario:
    ///        Liam      = `newLender` (the lender who stays)
    ///        Alice     = `lender`  (current borrower; we re-purpose
    ///                              `lender` because the existing
    ///                              `borrower` slot is consumed by
    ///                              earlier scenarios, and Alice's
    ///                              role is "borrower being replaced".
    ///                              Naming inversion is local to N5.)
    ///        Ben       = `borrower` (the new borrower)
    function _scenarioN5_precloseOption2_transferObligation() internal {
        console.log("");
        console.log("=== N5: Preclose Option 2 (transferObligationViaOffer) ===");

        // Liam (newLender) creates a lender offer. Alice (lender slot)
        // is the borrower of L1 — she'll be replaced by Ben.
        address Liam = newLender;
        address Alice = lender;
        address Ben = borrower;
        uint256 LiamKey = newLenderKey;
        uint256 AliceKey = lenderKey;
        uint256 BenKey = borrowerKey;

        vm.startBroadcast(LiamKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 lenderOfferId = OfferFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        vm.startBroadcast(AliceKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanL1 = OfferFacet(diamond).acceptOffer(lenderOfferId, true);
        vm.stopBroadcast();
        console.log("L1 (Liam -> Alice) initiated:", loanL1);

        // Ben creates a Borrower offer with terms favoring Liam:
        // same lending asset, same collateral asset, principal == L1
        // principal, durationDays <= remaining, collateralAmount >=
        // L1.collateralAmount. We use exact-match terms for simplicity.
        vm.startBroadcast(BenKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 benOfferId = OfferFacet(diamond).createOffer(_borrowerOfferTakeoverFor(Ben));
        vm.stopBroadcast();
        console.log("Ben's takeover offer:", benOfferId);

        // Alice calls transferObligation, paying accrued + shortfall.
        // Approve generous principal — at t≈0 accrued is tiny but
        // shortfall could be a few cents to a few dollars depending on
        // duration mismatch. We approve full LOAN_AMOUNT for headroom.
        vm.startBroadcast(AliceKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        PrecloseFacet(diamond).transferObligationViaOffer(loanL1, benOfferId);
        vm.stopBroadcast();

        // Verify: L1 is still Active but borrower changed from Alice
        // to Ben; lender unchanged.
        LibVaipakam.Loan memory l1After = LoanFacet(diamond).getLoanDetails(loanL1);
        require(
            l1After.status == LibVaipakam.LoanStatus.Active,
            "N5: L1 should still be Active (only obligation transferred)"
        );
        require(l1After.borrower == Ben, "N5: borrower should be Ben");
        require(l1After.lender == Liam, "N5: lender should still be Liam");
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

    // ─── N6: Preclose Option 3 — offsetWithNewOffer + completeOffset ─────

    /// @dev Alice (borrower of L1, lender = Liam) wants to exit AND
    ///      become a lender herself (Option 3). She:
    ///        1. Pays accrued interest + shortfall to Liam.
    ///        2. Creates a new Lender offer linked to L1 via the
    ///           `offsetOfferToLoanId` mapping. The borrower NFT for
    ///           L1 is natively-locked while the offset is in flight.
    ///        3. Charlie (new borrower) accepts the offset offer.
    ///           Inside `_acceptOffer` the auto-link triggers
    ///           `completeOffset(L1)` which:
    ///             - Settles L1 (status -> Repaid)
    ///             - Releases Alice's collateral to her escrow
    ///             - Charlie's loan against Alice as lender goes Active
    ///
    ///      Roles:
    ///        Liam   = `newLender`  (original lender)
    ///        Alice  = `lender`     (borrower of L1 -> lender of L_new)
    ///        Charlie = `borrower`  (new borrower)
    function _scenarioN6_precloseOption3_offset() internal {
        console.log("");
        console.log("=== N6: Preclose Option 3 (offsetWithNewOffer + completeOffset) ===");

        address Liam = newLender;
        address Alice = lender;
        address Charlie = newBorrower;
        uint256 LiamKey = newLenderKey;
        uint256 AliceKey = lenderKey;
        uint256 CharlieKey = newBorrowerKey;

        // Setup loan L1: Liam -> Alice.
        vm.startBroadcast(LiamKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 lenderOfferId = OfferFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        vm.startBroadcast(AliceKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanL1 = OfferFacet(diamond).acceptOffer(lenderOfferId, true);
        vm.stopBroadcast();
        console.log("L1 (Liam -> Alice) initiated:", loanL1);

        // Alice calls offsetWithNewOffer. She pays accrued + shortfall
        // to Liam (~0 at t≈0 with same rate/duration); deposits new
        // principal into her escrow; the diamond mints a Lender offer
        // on her behalf and links it to L1.
        vm.startBroadcast(AliceKey);
        // Approve generously: offsetWithNewOffer pulls from Alice's
        // wallet THREE times — (1) treasuryFee on accrued, (2)
        // principal+interest to old lender via escrowDepositERC20From,
        // (3) new principal for the offer createOfferInternal pulls.
        // Total ≈ 2 × LOAN_AMOUNT + small accrued; we approve 3× for
        // headroom.
        usdc.approve(diamond, LOAN_AMOUNT * 3);
        uint256 offsetOfferId = PrecloseFacet(diamond).offsetWithNewOffer(
            loanL1,
            INTEREST_BPS,           // same rate as L1 — minimal shortfall
            DURATION_DAYS,          // same duration — within remaining
            address(weth),
            COLLATERAL_AMOUNT,
            true,                   // creatorFallbackConsent
            address(usdc)           // prepayAsset (unused on ERC20 path)
        );
        vm.stopBroadcast();
        console.log("Alice's offset offer:", offsetOfferId);

        // Charlie accepts. The auto-link inside `_acceptOffer` fires
        // `PrecloseFacet.completeOffset(L1)` which closes L1 and
        // releases Alice's collateral.
        vm.startBroadcast(CharlieKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 newLoanId = OfferFacet(diamond).acceptOffer(offsetOfferId, true);
        vm.stopBroadcast();
        console.log("Charlie accepted -> new loanId:", newLoanId);

        // Verify L1 is no longer Active.
        LibVaipakam.Loan memory l1Settled = LoanFacet(diamond).getLoanDetails(loanL1);
        require(
            l1Settled.status != LibVaipakam.LoanStatus.Active,
            "N6: L1 should be settled by completeOffset auto-fire"
        );
        console.log("L1 status post-offset:", uint8(l1Settled.status));

        // Verify the new loan has Alice as lender, Charlie as borrower.
        LibVaipakam.Loan memory newLoan = LoanFacet(diamond).getLoanDetails(newLoanId);
        require(newLoan.lender == Alice, "N6: new loan lender should be Alice");
        require(newLoan.borrower == Charlie, "N6: new loan borrower should be Charlie");
        console.log("New loan (Alice -> Charlie) status:", uint8(newLoan.status));

        console.log(">>> N6 PASSED <<<");
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
            // Lower rate than the original loan — Alice is refinancing
            // because she found a cheaper lender.
            interestRateBps: INTEREST_BPS / 2,
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

    function _claimBoth(uint256 lKey, uint256 bKey, uint256 loanId) internal {
        vm.startBroadcast(lKey);
        try ClaimFacet(diamond).claimAsLender(loanId) {} catch {}
        vm.stopBroadcast();
        vm.startBroadcast(bKey);
        try ClaimFacet(diamond).claimAsBorrower(loanId) {} catch {}
        vm.stopBroadcast();
    }
}
