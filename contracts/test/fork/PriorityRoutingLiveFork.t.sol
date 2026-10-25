// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/**
 * @title  PriorityRoutingLiveFork
 * @notice #2550 arming precondition 4 (`VpfiPriorityRoutingPerkDesign.md`,
 *         "Pricing and arming"): on a FORK of a chain running the DEPLOYED
 *         bytecode, set the price, buy a credit, exhaust a solver's bucket, and
 *         confirm a flagged fill succeeds and spends exactly one credit while an
 *         unflagged one is refused — the effect proven before any live sale.
 *
 * @dev    Everything the proof is about runs the deployed facets unchanged: the
 *         capacity limiter, the perk sale, the opt-in, `matchIntent`'s charge
 *         and the credit consumption. Only the ORACLE's answers are mocked, at
 *         the Diamond's own external self-call seam exactly as `SetupTest` does,
 *         because the deployed chain carries no priced test assets; the two
 *         throwaway tokens exist only on the fork. Admin writes are pranked as
 *         the deployment's admin. Nothing here reaches the live chain.
 *
 *         The deployed RISK math runs too (`calculateLTV`/`calculateHealthFactor`
 *         are NOT mocked, Codex #2582 r1), as does the deployed `previewIntent`
 *         the keeper decides by. Admin writes are made as the account that holds
 *         each ROLE they require (resolved and verified, never assumed to be the
 *         ERC-173 owner), and the deployment's KYC posture is honoured: when
 *         enforcement is on, the throwaway actors are given the tier it requires.
 *
 *         Self-gates on `FORK_URL_BASE_SEPOLIA` like the other fork suites, and
 *         reads the Diamond from `FORK_DIAMOND` (defaulting to Base Sepolia's) and
 *         the role holders from `FORK_ADMIN` / `FORK_RISK_ADMIN` / `FORK_KYC_ADMIN`
 *         (each defaulting to the owner). The Solver curve is the chain's own,
 *         which must already be lit (precondition 2); the price is the decided
 *         2 VPFI per credit.
 */
interface IDiamondForProof {
    // ServiceCapacityFacet
    function capacityChargeInternal(uint8, address) external;
    function previewCapacity(uint8, address) external view returns (uint256, uint256, uint256, bool);
    // PerkFacet
    function setPerkConfig(uint256, uint256, uint32) external;
    function purchasePerk(uint256, uint256, uint256, uint32) external;
    function getPerkEntitlement(address, uint256) external view returns (bool, uint64, uint256);
    // LenderIntentFacet
    function setLenderIntentEnabled(bool) external;
    function setLenderIntent(address, address, uint256, uint256, uint16, uint32, uint256, bool, bool) external;
    function fundLenderIntent(address, address, uint256) external;
    function setLenderIntentPriority(address, address, bool) external;
    function getLenderIntentPriority(address, address, address, address, address)
        external
        view
        returns (bool, uint256, bool, bool);
    // OfferMatchIntentFacet / OfferCreateFacet / RiskFacet / VPFIDiscountFacet / Admin
    function matchIntent(address, address, address, uint256, uint256) external returns (uint256);
    function createOffer(LibVaipakam.CreateOfferParams calldata) external returns (uint256);
    function updateRiskParams(address, uint256, uint256) external;
    function depositVPFIToVault(uint256) external;
    function getVPFIToken() external view returns (address);
    function owner() external view returns (address);
    function setPartialFillEnabled(bool) external;
    function hasRole(bytes32, address) external view returns (bool);
    function isKYCEnforcementEnabled() external view returns (bool);
    function updateKYCTier(address, uint8) external;
    function getPerkConfig(uint256) external view returns (uint256, uint32, uint256);
    function getUserVaultAddress(address) external view returns (address);
    function getRecycleBucket() external view returns (uint256);
    function getPerkSpendCumulative() external view returns (uint256);
    function previewIntent(address, address, address, address, address, uint256, uint256)
        external
        view
        returns (IntentPreview memory);
    function getCapacityCurve(uint8) external view returns (LibVaipakam.CapacityCurve memory);
    function getRiskAccessGateEnabled() external view returns (bool);
    function paused() external view returns (bool);
    function getPartialFillEnabled() external view returns (bool);
    function isLenderIntentEnabled() external view returns (bool);
    function getCapacityBucket(uint8, address) external view returns (LibVaipakam.CapacityBucket memory);
    function getLoanDetails(uint256) external view returns (LibVaipakam.Loan memory);
    function getPriorityRoutingStatus()
        external
        view
        returns (bool, bool, bool, bool, bool, bool, bool, bool, bool);
    function setRiskAccessGateEnabled(bool) external;
}

struct IntentPreview {
    bool ok;
    uint8 intentError;
    uint8 matchError;
    uint8 riskBlock;
    uint256 matchAmount;
    uint256 matchRateBps;
    uint256 reqCollateral;
    uint256 availableCapital;
    bool spendsPriorityCredit;
}

interface IERC20Lite {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract PriorityRoutingLiveFork is Test {
    address internal constant BASE_SEPOLIA_DIAMOND = 0x2535baC87F3df287268fC697F2f31cf418365303;
    /// @dev A Base Sepolia block BEFORE the perk was armed there — Solver curve
    ///      lit, lender intents on, perk unpriced and never sold (Codex #2582 r3).
    ///      The proof is of the arming transition, so it forks the state that
    ///      transition starts from; a later run therefore stays green after the
    ///      live arming. `FORK_BLOCK` overrides it (0 = latest) for another chain.
    uint256 internal constant BASE_SEPOLIA_PRE_ARM_BLOCK = 48309942;

    uint256 internal constant PERK = 1; // LibPriorityRouting.PERK_ID
    uint8 internal constant SOLVER = uint8(LibVaipakam.ServiceCapacityRole.Solver);
    /// @dev The decided price (owner, 2026-10-19; recorded on #2550 and in the
    ///      design note). The Solver curve is NOT set here: arming precondition 2
    ///      is that the chain's OWN curve is lit, so the proof runs on it.
    uint256 internal constant PRICE = 2e18; // VPFI per credit

    uint256 internal constant PRINCIPAL = 1000 ether;
    /// @dev 10x the principal (a 10% LTV, HF ~8 at an 80% threshold), so the
    ///      fixture clears any sane deployment risk setting instead of being sized
    ///      to one (Codex #2582 r3); routing, not risk, is what the proof is about.
    uint256 internal constant COLLATERAL = 10 * PRINCIPAL;
    uint256 internal constant MIN_RATE_BPS = 500;
    /// @dev The floor every deployment's duration cap admits (`setMaxOfferDurationDays`
    ///      accepts nothing below 7), so the fixture term never depends on the
    ///      deployment's own cap (Codex #2582 r2).
    uint32 internal constant MAX_DURATION = 7;

    bytes32 internal constant T_PRIORITY_FILL =
        keccak256("IntentPriorityFill(address,address,address,uint256,address,uint256)");
    bytes32 internal constant T_CREDIT_CONSUMED = keccak256("PerkCreditConsumed(address,uint256,uint256)");
    bytes32 internal constant T_CAPACITY_SPENT = keccak256("CapacitySpent(uint8,address,uint256,uint256)");
    bytes32 internal constant T_FREE_TIER_SPENT = keccak256("CapacityFreeTierSpent(uint8,address,uint256,uint256)");
    bytes32 internal constant T_PERK_ARMED = keccak256("PriorityRoutingPerkArmed(uint256)");
    bytes32 internal constant T_PRIORITY_SET = keccak256("LenderIntentPrioritySet(address,address,address,bool)");
    bytes32 internal constant T_PERK_PURCHASED = keccak256("PerkPurchased(address,uint256,uint256,uint256,uint64,uint256)");

    uint8 internal constant CAPACITY_EXHAUSTED = 22; // LibOfferMatch.IntentError.CapacityExhausted
    uint8 internal constant KYC_TIER2 = 2; // LibVaipakam.KYCTier.Tier2

    IDiamondForProof internal d;
    address internal admin;
    address internal riskAdmin;
    address internal kycAdmin;
    address internal solver;
    address internal flagged; // the intent owner who buys a credit and opts in
    address internal plain; // an intent owner who does not
    address internal lendAsset;
    address internal collAsset;
    bool internal live;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL_BASE_SEPOLIA", string(""));
        if (bytes(url).length == 0) return; // self-gate: no RPC, no proof
        address target = vm.envOr("FORK_DIAMOND", BASE_SEPOLIA_DIAMOND);
        uint256 pin = vm.envOr("FORK_BLOCK", target == BASE_SEPOLIA_DIAMOND ? BASE_SEPOLIA_PRE_ARM_BLOCK : 0);
        if (pin == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pin);
        // The default target is Base Sepolia's: proof against it must BE Base
        // Sepolia (Codex #2582 r4); an explicit FORK_DIAMOND names its own chain.
        if (target == BASE_SEPOLIA_DIAMOND) require(block.chainid == 84532, "default target: the fork is not Base Sepolia");
        live = true;
        d = IDiamondForProof(target);
        address own = d.owner();
        admin = vm.envOr("FORK_ADMIN", own);
        riskAdmin = vm.envOr("FORK_RISK_ADMIN", own);
        kycAdmin = vm.envOr("FORK_KYC_ADMIN", own);
        require(d.hasRole(keccak256("ADMIN_ROLE"), admin), "FORK_ADMIN does not hold ADMIN_ROLE");
        require(d.hasRole(keccak256("RISK_ADMIN_ROLE"), riskAdmin), "FORK_RISK_ADMIN does not hold RISK_ADMIN_ROLE");
        // PRECONDITION, stated rather than normalised (Codex #2582 r5): the proof
        // is of arming a LIVE perk, and a paused deployment sells nothing and
        // fills nothing; arming one is a scheduled arming the operator verifies
        // after the pause lifts, against the unpaused state.
        require(!d.paused(), "precondition: the target Diamond is paused; prove after the pause lifts");
        // PRECONDITION (Codex #2582 r9): both intent master gates are already on
        // in the deployment. The proof must not switch them on itself, or it
        // would certify a chain where the price write alone still leaves the
        // perk undeliverable.
        require(d.getPartialFillEnabled(), "precondition: partial fills are off on the target");
        require(d.isLenderIntentEnabled(), "precondition: lender-intent matching is off on the target");
        solver = makeAddr("proofSolver");
        flagged = makeAddr("flaggedOwner");
        plain = makeAddr("plainOwner");

        // Two throwaway tokens, priced through the oracle seam only.
        lendAsset = address(new ERC20Mock("Proof Lend", "pL", 18));
        collAsset = address(new ERC20Mock("Proof Coll", "pC", 18));
        _mockOracle(lendAsset);
        _mockOracle(collAsset);
        vm.startPrank(riskAdmin);
        // A zero liquidation bonus, so the fixture never depends on the
        // deployment's incentive cap (Codex #2582 r4); liquidation is not what
        // this proof is about.
        d.updateRiskParams(lendAsset, 8000, 0);
        d.updateRiskParams(collAsset, 8000, 0);
        vm.stopPrank();
        vm.startPrank(admin);
        // The progressive risk-access gate is an onboarding posture orthogonal to
        // routing; fresh fork actors cannot climb it without its cooldowns, so it
        // is switched off ON THE FORK when a deployment has it on, and only then
        // (Codex #2582 r2). Nothing here reaches the live chain.
        if (d.getRiskAccessGateEnabled()) d.setRiskAccessGateEnabled(false);
        vm.stopPrank();

        _openIntent(flagged);
        _openIntent(plain);
    }

    /// @dev The deployment's KYC posture is honoured, never switched off.
    function _kyc(address who) internal {
        if (!d.isKYCEnforcementEnabled()) return;
        require(d.hasRole(keccak256("KYC_ADMIN_ROLE"), kycAdmin), "FORK_KYC_ADMIN does not hold KYC_ADMIN_ROLE");
        vm.prank(kycAdmin);
        d.updateKYCTier(who, KYC_TIER2);
    }

    /// @dev Buy `units` credits for `who` with exactly `units * PRICE` VPFI from
    ///      their vault, asserting the exact debit (Codex #2582 r1) and where the
    ///      VPFI landed: the recycle bucket and the lifetime perk spend each rise
    ///      by exactly the spend (Codex #2582 r10).
    function _buyCredit(address who, uint256 units_) internal {
        uint256 cost = units_ * PRICE;
        address vpfi = d.getVPFIToken();
        deal(vpfi, who, cost);
        vm.startPrank(who);
        assertTrue(IERC20Lite(vpfi).approve(address(d), cost), "approve");
        d.depositVPFIToVault(cost);
        address vault = d.getUserVaultAddress(who);
        uint256 before = IERC20Lite(vpfi).balanceOf(vault);
        uint256 bucket0 = d.getRecycleBucket();
        uint256 spend0 = d.getPerkSpendCumulative();
        vm.recordLogs();
        d.purchasePerk(PERK, units_, cost, 0);
        Vm.Log[] memory pl = vm.getRecordedLogs();
        vm.stopPrank();
        // The sale receipt, decoded (Codex #2582 r9): the public link between
        // the payment and the entitlement the proof later spends.
        assertEq(_count(pl, T_PERK_PURCHASED), 1, "PerkPurchased once");
        for (uint256 i = 0; i < pl.length; i++) {
            if (pl[i].emitter != address(d) || pl[i].topics.length == 0 || pl[i].topics[0] != T_PERK_PURCHASED) continue;
            assertEq(address(uint160(uint256(pl[i].topics[1]))), who, "receipt: buyer");
            assertEq(uint256(pl[i].topics[2]), PERK, "receipt: perkId");
            (uint256 units, uint256 spent, uint64 until, uint256 creditsAfter) =
                abi.decode(pl[i].data, (uint256, uint256, uint64, uint256));
            assertEq(units, units_, "receipt: units");
            assertEq(spent, cost, "receipt: VPFI spent");
            assertEq(until, 0, "receipt: counted, no expiry");
            assertEq(creditsAfter, units_, "receipt: credits after");
        }
        assertEq(before - IERC20Lite(vpfi).balanceOf(vault), cost, "exactly the configured price was charged");
        assertEq(d.getRecycleBucket() - bucket0, cost, "the spend entered the recycle bucket, exactly");
        assertEq(d.getPerkSpendCumulative() - spend0, cost, "the lifetime perk spend rose by exactly the spend");
        assertEq(_credits(who), units_, "the credits bought");
    }

    function _preview(address who, uint256 offerId) internal view returns (IntentPreview memory) {
        return d.previewIntent(solver, solver, who, lendAsset, collAsset, offerId, PRINCIPAL);
    }

    function _mockOracle(address asset) internal {
        vm.mockCall(
            address(d), abi.encodeWithSignature("checkLiquidity(address)", asset), abi.encode(LibVaipakam.LiquidityStatus.Liquid)
        );
        vm.mockCall(
            address(d),
            abi.encodeWithSignature("checkLiquidityOnActiveNetwork(address)", asset),
            abi.encode(LibVaipakam.LiquidityStatus.Liquid)
        );
        vm.mockCall(address(d), abi.encodeWithSignature("getAssetPrice(address)", asset), abi.encode(uint256(1e8), uint8(8)));
        vm.mockCall(address(d), abi.encodeWithSignature("getEffectiveLiquidityTier(address)", asset), abi.encode(uint8(1)));
    }

    function _openIntent(address who) internal {
        _kyc(who);
        ERC20Mock(lendAsset).mint(who, 10 * PRINCIPAL);
        vm.startPrank(who);
        d.setLenderIntent(lendAsset, collAsset, 10_000 ether, MIN_RATE_BPS, 5000, MAX_DURATION, 100 ether, false, true);
        ERC20Mock(lendAsset).approve(address(d), 5 * PRINCIPAL);
        d.fundLenderIntent(lendAsset, collAsset, 5 * PRINCIPAL);
        vm.stopPrank();
    }

    function _postBorrower(string memory name) internal returns (uint256 offerId) {
        address b = makeAddr(name);
        _kyc(b);
        ERC20Mock(collAsset).mint(b, 1_000_000 ether);
        vm.startPrank(b);
        ERC20Mock(collAsset).approve(address(d), type(uint256).max);
        offerId = d.createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: lendAsset,
                amount: PRINCIPAL,
                interestRateBps: MIN_RATE_BPS,
                collateralAsset: collAsset,
                collateralAmount: COLLATERAL,
                durationDays: MAX_DURATION,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: lendAsset,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: MIN_RATE_BPS + 100,
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
        vm.stopPrank();
    }

    function _count(Vm.Log[] memory logs, bytes32 topic0) internal view returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(d) && logs[i].topics.length > 0 && logs[i].topics[0] == topic0) n++;
        }
    }

    /// @dev EVERY field of every read the proof relies on is asserted (Codex
    ///      #2582 r8 — the rule applied across the test, not per finding).
    function _credits(address who) internal view returns (uint256 c) {
        bool active;
        uint64 until;
        (active, until, c) = d.getPerkEntitlement(who, PERK);
        assertEq(active, c > 0, "entitlement: active iff a counted unit is held");
        assertEq(until, 0, "entitlement: counted, no expiry");
    }

    function _assertPriority(
        address who,
        bool enabled,
        uint256 credits,
        bool covers,
        bool unlocks,
        string memory tag
    ) internal view {
        (bool e, uint256 c, bool cv, bool u) = d.getLenderIntentPriority(who, lendAsset, collAsset, solver, solver);
        assertEq(e, enabled, string.concat(tag, ": priority view enabled"));
        assertEq(c, credits, string.concat(tag, ": priority view credits"));
        assertEq(cv, covers, string.concat(tag, ": priority view capacityCovers"));
        assertEq(u, unlocks, string.concat(tag, ": priority view creditUnlocks"));
    }

    function _assertPerkConfig(uint256 price, uint32 duration, uint256 sold, string memory tag) internal view {
        (uint256 p, uint32 dur, uint256 s_) = d.getPerkConfig(PERK);
        assertEq(p, price, string.concat(tag, ": price"));
        assertEq(dur, duration, string.concat(tag, ": duration"));
        assertEq(s_, sold, string.concat(tag, ": units sold"));
    }

    /// @dev An Ok preview's terms are the fill the proof then makes.
    function _assertOkPreview(IntentPreview memory pv, bool spendsCredit, string memory tag) internal pure {
        assertTrue(pv.ok, string.concat(tag, ": ok"));
        assertEq(pv.intentError, 0, string.concat(tag, ": no intent error"));
        assertEq(pv.matchError, 0, string.concat(tag, ": no match error"));
        assertEq(pv.riskBlock, 0, string.concat(tag, ": no risk block"));
        assertEq(pv.matchAmount, PRINCIPAL, string.concat(tag, ": the whole principal matches"));
        assertGe(pv.matchRateBps, MIN_RATE_BPS, string.concat(tag, ": rate at or above the intent's floor"));
        assertLe(pv.matchRateBps, MIN_RATE_BPS + 100, string.concat(tag, ": rate within the borrower's ceiling"));
        assertGt(pv.reqCollateral, 0, string.concat(tag, ": collateral required"));
        assertGe(pv.availableCapital, PRINCIPAL, string.concat(tag, ": capital covers the fill"));
        assertEq(pv.spendsPriorityCredit, spendsCredit, string.concat(tag, ": spendsPriorityCredit"));
    }

    /// @dev Capacity is the preview's LAST check, so a refusal for it still
    ///      reports the position it evaluated — every other field as an Ok one.
    function _assertRefusedPreview(IntentPreview memory pv, string memory tag) internal pure {
        assertFalse(pv.ok, string.concat(tag, ": refused"));
        assertEq(pv.intentError, CAPACITY_EXHAUSTED, string.concat(tag, ": for capacity"));
        assertEq(pv.matchError, 0, string.concat(tag, ": no match error"));
        assertEq(pv.riskBlock, 0, string.concat(tag, ": no risk block"));
        assertEq(pv.matchAmount, PRINCIPAL, string.concat(tag, ": the whole principal evaluated"));
        assertGe(pv.matchRateBps, MIN_RATE_BPS, string.concat(tag, ": rate at or above the intent's floor"));
        assertLe(pv.matchRateBps, MIN_RATE_BPS + 100, string.concat(tag, ": rate within the borrower's ceiling"));
        assertGt(pv.reqCollateral, 0, string.concat(tag, ": collateral required"));
        assertGe(pv.availableCapital, PRINCIPAL, string.concat(tag, ": capital covers the fill"));
        assertFalse(pv.spendsPriorityCredit, string.concat(tag, ": spends no credit"));
    }

    function test_ForkProof_OneCreditFillsOnePriorityIntentWhileAnOrdinaryOneIsRefused() public {
        if (!live) {
            vm.skip(true);
            return;
        }
        // 1. Light the limiter, then arm the perk: the arming write is the price.
        //    The proof is of the FIRST-TIME arming (Codex #2582 r2): the perk is
        //    unpriced and has never sold, and the price write emits the one-time
        //    arming event.
        _assertPerkConfig(0, 0, 0, "pre-state");
        // Precondition 2: the chain's own Solver curve is lit, and the proof runs
        // on it as deployed.
        LibVaipakam.CapacityCurve memory curve = d.getCapacityCurve(SOLVER);
        assertGt(curve.freeTier, 0, "precondition: the chain's Solver curve is lit");
        vm.startPrank(admin);
        vm.recordLogs();
        d.setPerkConfig(PERK, PRICE, 0);
        Vm.Log[] memory armLogs = vm.getRecordedLogs();
        vm.stopPrank();
        assertEq(_count(armLogs, T_PERK_ARMED), 1, "the price write arms the perk, once");
        for (uint256 i = 0; i < armLogs.length; i++) {
            if (armLogs[i].emitter == address(d) && armLogs[i].topics.length > 0 && armLogs[i].topics[0] == T_PERK_ARMED) {
                assertEq(abi.decode(armLogs[i].data, (uint256)), PRICE, "armed at the configured price");
            }
        }
        _assertPerkConfig(PRICE, 0, 0, "armed");
        // The price write leaves the chain's curve exactly as it was.
        // Every field (Codex #2582 r4).
        LibVaipakam.CapacityCurve memory after_ = d.getCapacityCurve(SOLVER);
        assertEq(after_.freeTier, curve.freeTier, "arming leaves the curve: freeTier");
        assertEq(after_.freeRatePerSec, curve.freeRatePerSec, "arming leaves the curve: freeRatePerSec");
        assertEq(after_.bondAt4x, curve.bondAt4x, "arming leaves the curve: bondAt4x");
        assertEq(after_.classCost, curve.classCost, "arming leaves the curve: classCost");
        assertEq(after_.epoch, curve.epoch, "arming leaves the curve: epoch");
        assertEq(after_.setAt, curve.setAt, "arming leaves the curve: setAt");
        _assertStatusAllTrue();

        // 2. BOTH owners buy one credit each, at exactly the price; only the
        //    flagged owner opts the intent in. The control therefore differs from
        //    the flagged intent in the opt-in alone (Codex #2582 r1).
        // The flagged owner buys TWO credits, so the first priority fill must
        // DECREMENT by one, not clear the balance (Codex #2582 r10).
        _buyCredit(flagged, 2);
        _buyCredit(plain, 1);
        // The protocol's durable sale record moved with the two sales (Codex
        // #2582 r5): it is what freezes the perk's mode after a first sale.
        _assertPerkConfig(PRICE, 0, 3, "after both sales");
        _assertPriority(flagged, false, 2, true, false, "bought, not yet opted in");
        _assertPriority(plain, false, 1, true, false, "control bought");
        vm.recordLogs();
        vm.prank(flagged);
        d.setLenderIntentPriority(lendAsset, collAsset, true);
        _assertOptIn(vm.getRecordedLogs());
        _assertPriority(flagged, true, 2, true, false, "opted in, capacity covers");

        // 3a. While the solver CAN afford it, the flagged fill is charged to its
        //     capacity and the credit is untouched: a credit only ever buys a
        //     fill that would not otherwise have happened (Codex #2582 r6). A
        //     bucket seen for the first time holds exactly one free action, so
        //     this fill is also what first spends the solver's capacity.
        _coveredFillKeepsTheCredit();

        // 3b. Exhaust whatever capacity is left through the Diamond-gated charge
        //     the gated routes use, until the limiter refuses; the loop does not
        //     assume a count.
        for (uint256 i = 0; i < 200; i++) {
            vm.prank(address(d));
            (bool spent,) = address(d).call(abi.encodeCall(IDiamondForProof.capacityChargeInternal, (SOLVER, solver)));
            if (!spent) break;
        }
        (uint256 accrued, uint256 rate, uint256 ceiling, bool dark) = d.previewCapacity(SOLVER, solver);
        assertLt(accrued, curve.classCost, "fixture-live: the solver cannot afford a fill at the deployed cost");
        assertFalse(dark, "the limiter is lit");
        assertEq(rate, curve.freeRatePerSec, "unbonded: the free refill rate");
        assertEq(ceiling, curve.freeTier, "unbonded: the free ceiling");
        _assertPriority(flagged, true, 2, false, true, "exhausted, two credits");
        _assertPriority(plain, false, 1, false, false, "exhausted, control not opted in");

        // The deployed preview — what the keeper decides by — agrees for both.
        uint256 cp1 = _postBorrower("proof-borrower-1");
        uint256 cp2 = _postBorrower("proof-borrower-2");
        _assertOkPreview(_preview(flagged, cp1), true, "preview flagged");
        _assertRefusedPreview(_preview(plain, cp2), "preview control");

        // 4. Each flagged fill goes through on a credit, spending exactly ONE
        //    (2 -> 1, then 1 -> 0), with no capacity charge.
        _priorityFill(cp1, "proof-borrower-1", 1);
        _assertPriority(flagged, true, 1, false, true, "exhausted, one credit left");
        _priorityFill(_postBorrower("proof-borrower-4"), "proof-borrower-4", 0);

        // 4b. The same opted-in intent with its credit spent is refused like any
        //     other: the opt-in alone unlocks nothing (Codex #2582 r6).
        uint256 cp3 = _postBorrower("proof-borrower-3");
        _assertPriority(flagged, true, 0, false, false, "zero credits");
        _assertRefusedPreview(_preview(flagged, cp3), "zero credits");
        vm.prank(solver);
        vm.expectPartialRevert(bytes4(keccak256("ServiceCapacityExhausted(uint8,address,uint256,uint256)")));
        d.matchIntent(flagged, lendAsset, collAsset, cp3, PRINCIPAL);

        // 5. The unflagged intent — holding a credit, not opted in — is refused
        //    for capacity at the same moment, and its credit stays unspent.
        _assertPriority(plain, false, 1, false, false, "control at the refusal");
        vm.prank(solver);
        vm.expectPartialRevert(bytes4(keccak256("ServiceCapacityExhausted(uint8,address,uint256,uint256)")));
        d.matchIntent(plain, lendAsset, collAsset, cp2, PRINCIPAL);
        assertEq(_credits(plain), 1, "the control's credit was not spent");
    }

    /// @dev One exhausted, credit-paid fill of the flagged intent, leaving
    ///      `left` credits: the loan persisted, the capacity bucket untouched, both
    ///      priority records exact.
    function _priorityFill(uint256 offerId, string memory borrowerName, uint256 left) internal {
        LibVaipakam.CapacityBucket memory bucketBefore = d.getCapacityBucket(SOLVER, solver);
        vm.recordLogs();
        vm.prank(solver);
        uint256 loanId = d.matchIntent(flagged, lendAsset, collAsset, offerId, PRINCIPAL);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(loanId, 0, "the flagged fill landed");
        _assertLoan(loanId, makeAddr(borrowerName));
        // The capacity STATE, not only the events (Codex #2582 r6).
        LibVaipakam.CapacityBucket memory bucketAfter = d.getCapacityBucket(SOLVER, solver);
        assertEq(bucketAfter.balance, bucketBefore.balance, "bucket untouched: balance");
        assertEq(bucketAfter.lastTouch, bucketBefore.lastTouch, "bucket untouched: lastTouch");
        assertEq(bucketAfter.curveEpoch, bucketBefore.curveEpoch, "bucket untouched: curveEpoch");
        assertEq(bucketAfter.seen, bucketBefore.seen, "bucket untouched: seen");
        assertEq(_credits(flagged), left, "exactly one credit spent");
        assertEq(_count(logs, T_PRIORITY_FILL), 1, "IntentPriorityFill once");
        assertEq(_count(logs, T_CREDIT_CONSUMED), 1, "PerkCreditConsumed once");
        assertEq(_count(logs, T_CAPACITY_SPENT), 0, "no capacity charge");
        assertEq(_count(logs, T_FREE_TIER_SPENT), 0, "no free-tier charge either");
        _assertPayloads(logs, loanId, left);
    }

    /// @dev The flagged intent's fill while capacity covers it: charged to the
    ///      solver, the credit untouched, no priority record.
    function _coveredFillKeepsTheCredit() internal {
        uint256 cp0 = _postBorrower("proof-borrower-0");
        _assertPriority(flagged, true, 2, true, false, "covered");
        _assertOkPreview(_preview(flagged, cp0), false, "covered preview");
        LibVaipakam.CapacityBucket memory b0 = d.getCapacityBucket(SOLVER, solver);
        vm.recordLogs();
        vm.prank(solver);
        uint256 loan0 = d.matchIntent(flagged, lendAsset, collAsset, cp0, PRINCIPAL);
        Vm.Log[] memory l0 = vm.getRecordedLogs();
        assertGt(loan0, 0, "covered: filled");
        assertEq(_credits(flagged), 2, "covered: the credits are untouched");
        // A DIRECT solver is charged on its own bonded bucket, never a free-only
        // one (Codex #2582 r7): exactly one CapacitySpent, no CapacityFreeTierSpent,
        // and the bucket itself moved from unseen to seen.
        assertEq(_count(l0, T_CAPACITY_SPENT), 1, "covered: one charge to the solver's own bucket");
        assertEq(_count(l0, T_FREE_TIER_SPENT), 0, "covered: no free-only bucket charged");
        LibVaipakam.CapacityBucket memory b1 = d.getCapacityBucket(SOLVER, solver);
        assertFalse(b0.seen, "covered: the solver's bucket was unseen before");
        assertTrue(b1.seen, "covered: the charge touched the solver's own bucket");
        LibVaipakam.CapacityCurve memory cv = d.getCapacityCurve(SOLVER);
        assertEq(b1.curveEpoch, cv.epoch, "covered: settled under the live curve");
        // The DEBIT itself (Codex #2582 r8): a first-seen bucket holds exactly one
        // action, and the fill takes exactly one, so nothing is left — read from
        // the bucket and from the charge record's own payload.
        assertEq(uint256(b1.balance), 0, "covered: the one first-seen action was debited");
        for (uint256 i = 0; i < l0.length; i++) {
            if (l0[i].emitter != address(d) || l0[i].topics.length == 0 || l0[i].topics[0] != T_CAPACITY_SPENT) continue;
            assertEq(uint256(l0[i].topics[1]), uint256(SOLVER), "charge: role");
            assertEq(address(uint160(uint256(l0[i].topics[2]))), solver, "charge: actor");
            (uint256 cost, uint256 balanceAfter) = abi.decode(l0[i].data, (uint256, uint256));
            assertEq(cost, cv.classCost, "charge: one fill's cost");
            assertEq(balanceAfter, uint256(b1.balance), "charge: balance after matches the bucket");
        }
        assertEq(_count(l0, T_PRIORITY_FILL), 0, "covered: no IntentPriorityFill");
        assertEq(_count(l0, T_CREDIT_CONSUMED), 0, "covered: no PerkCreditConsumed");
    }

    /// @dev The loan the credit paid for is persisted as matched (Codex #2582 r6).
    function _assertLoan(uint256 loanId, address borrowerAddr) internal view {
        LibVaipakam.Loan memory loan = d.getLoanDetails(loanId);
        assertEq(loan.id, loanId, "loan: id");
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active), "loan: active");
        assertEq(loan.lender, flagged, "loan: lender of record");
        assertEq(loan.borrower, borrowerAddr, "loan: borrower");
        assertEq(loan.principalAsset, lendAsset, "loan: principal asset");
        assertEq(loan.collateralAsset, collAsset, "loan: collateral asset");
        assertEq(loan.principal, PRINCIPAL, "loan: principal");
    }

    /// @dev The operator's status read, every field, after arming (Codex #2582 r6).
    function _assertStatusAllTrue() internal view {
        (bool purchasable, bool notPaused, bool vpfiSet, bool priced, bool armed, bool deliverable, bool counted, bool lit, bool live_) =
            d.getPriorityRoutingStatus();
        assertTrue(notPaused, "status: notPaused");
        assertTrue(vpfiSet, "status: vpfiTokenSet");
        assertTrue(priced, "status: priced");
        assertTrue(armed, "status: armed");
        assertTrue(deliverable, "status: deliverable");
        assertTrue(counted, "status: counted");
        assertTrue(lit, "status: solverCapacityLit");
        assertTrue(live_, "status: intentMatchingLive");
        assertTrue(purchasable, "status: purchasable");
    }

    /// @dev The consent record of the opt-in, decoded (Codex #2582 r2): the
    ///      design requires it on every write so a paid credit's consent history
    ///      can be rebuilt.
    function _assertOptIn(Vm.Log[] memory logs) internal view {
        assertEq(_count(logs, T_PRIORITY_SET), 1, "LenderIntentPrioritySet once");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(d) || logs[i].topics.length == 0 || logs[i].topics[0] != T_PRIORITY_SET) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), flagged, "opt-in: owner");
            assertEq(address(uint160(uint256(logs[i].topics[2]))), lendAsset, "opt-in: lendingAsset");
            assertEq(address(uint160(uint256(logs[i].topics[3]))), collAsset, "opt-in: collateralAsset");
            assertTrue(abi.decode(logs[i].data, (bool)), "opt-in: enabled");
        }
    }

    /// @dev Every field of the two priority records (Codex #2582 r1): they are
    ///      the audit link between the paid credit and the loan.
    function _assertPayloads(Vm.Log[] memory logs, uint256 loanId, uint256 left) internal view {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(d) || logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == T_PRIORITY_FILL) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), flagged, "fill: owner");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), lendAsset, "fill: lendingAsset");
                assertEq(address(uint160(uint256(logs[i].topics[3]))), collAsset, "fill: collateralAsset");
                (uint256 lid, address slv, uint256 left_) = abi.decode(logs[i].data, (uint256, address, uint256));
                assertEq(lid, loanId, "fill: loanId");
                assertEq(slv, solver, "fill: solver");
                assertEq(left_, left, "fill: creditsLeft");
            } else if (logs[i].topics[0] == T_CREDIT_CONSUMED) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), flagged, "consumed: user");
                assertEq(uint256(logs[i].topics[2]), PERK, "consumed: perkId");
                assertEq(abi.decode(logs[i].data, (uint256)), left, "consumed: creditsAfter");
            }
        }
    }
}
