// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {PerkFacet} from "../../src/facets/PerkFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../../src/facets/VPFIDiscountFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LenderIntentFacet} from "../../src/facets/LenderIntentFacet.sol";
import {OfferMatchIntentFacet} from "../../src/facets/OfferMatchIntentFacet.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {ServiceCapacityFacet} from "../../src/facets/ServiceCapacityFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";

/**
 * @title  PriorityRoutingPerkLiveForkTest
 * @notice #2550 arming precondition 4 — the priority-routing perk (perk id 1)
 *         proven on a fork of each LIVE testnet Diamond before it is priced there
 *         (design: `VpfiPriorityRoutingPerkDesign.md`, "Pricing and arming"). The
 *         arming write is made on the FORK, a credit is bought, the solver's
 *         capacity is spent, and then:
 *           - a fill the solver's capacity covers spends no credit;
 *           - an exhausted solver's fill of an intent NOT opted in is refused;
 *           - the same exhausted solver's fill of an opted-in, credit-backed
 *             intent goes through and spends exactly one credit;
 *           - with that credit gone, the opted-in intent is refused again.
 *
 * @dev    The unit suite (`PriorityRoutingPerkTest`) proves the source. This
 *         proves the DEPLOYED bytecode against live state: the facets the
 *         2026-10-19 changed-facet refresh cut in, the live Solver curve, the
 *         live intent gates and the live oracle. Nothing is configured on the
 *         fork except the arming write itself; the actors are fresh and funded on
 *         the fork only, and nothing here touches the shared testnet.
 *
 *         Re-runnable after the live arming: when the fork's Diamond is already
 *         armed, the arming step is skipped and the live price is the one bought
 *         at, so the cells keep proving the effect on whatever is deployed.
 *
 *         BNB testnet has no cell, deliberately. Its deployment carries no
 *         oracle-priced test assets, so no lender intent can be filled there —
 *         the fill refuses an unresolvable collateral floor before the perk is
 *         reached. The effect cannot be shown on that chain's live state, so
 *         under the design's precondition 4 it is not priced there.
 *
 *         Gated per chain by `FORK_URL_BASE_SEPOLIA` / `FORK_URL_ARB_SEPOLIA`;
 *         each cell skips when its URL is unset, like the other suites here.
 */
contract PriorityRoutingPerkLiveForkTest is Test {
    uint256 internal constant PERK = 1; // LibPriorityRouting.PERK_ID
    uint256 internal constant ARMING_PRICE = 2e18; // owner decision 2026-10-19: 2 VPFI per credit
    uint8 internal constant SOLVER = uint8(LibVaipakam.ServiceCapacityRole.Solver);

    uint256 internal constant PRINCIPAL = 0.01 ether; // WETH
    uint256 internal constant RATE_BPS = 1000;
    uint32 internal constant DURATION_DAYS = 30;
    uint16 internal constant MAX_INIT_LTV_BPS = 5000;

    bytes32 internal constant T_ARMED = keccak256("PriorityRoutingPerkArmed(uint256)");
    bytes32 internal constant T_PRIORITY_FILL =
        keccak256("IntentPriorityFill(address,address,address,uint256,address,uint256)");
    bytes32 internal constant T_CREDIT_CONSUMED = keccak256("PerkCreditConsumed(address,uint256,uint256)");
    bytes32 internal constant T_CAPACITY_SPENT = keccak256("CapacitySpent(uint8,address,uint256,uint256)");

    address internal diamond;
    address internal admin;
    address internal weth;
    address internal collateral;
    address internal vpfi;
    address internal solver;
    address internal flagged; // opts its intent in and buys a credit
    address internal plain; // never opts in
    address internal borrower;
    uint256 internal classCost;

    function test_baseSepolia_creditCarriesOnlyTheFillCapacityRefuses() public {
        _runOn("FORK_URL_BASE_SEPOLIA", "base-sepolia", 84532);
    }

    function test_arbSepolia_creditCarriesOnlyTheFillCapacityRefuses() public {
        _runOn("FORK_URL_ARB_SEPOLIA", "arb-sepolia", 421614);
    }

    // ─── the scenario ───────────────────────────────────────────────────────

    function _runOn(string memory env, string memory slug, uint256 chainId) internal {
        string memory url = vm.envOr(env, string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        require(block.chainid == chainId, string.concat(env, " is not ", slug));
        _load(slug);

        uint256 price = _armOnTheFork();
        _buyOneCredit(price);

        uint256 cp1 = _postBorrowerOffer();
        uint256 cp2 = _postBorrowerOffer();
        uint256 cp3 = _postBorrowerOffer();
        uint256 cp4 = _postBorrowerOffer();

        // 1. Covered: the fresh solver's bucket holds at least one action, so the
        //    opted-in, credit-backed fill is charged to the solver and NO credit
        //    moves.
        _assertView(flagged, true, 1, true, false, "covered");
        vm.recordLogs();
        uint256 coveredLoan = _fill(flagged, cp1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(LoanFacet(diamond).getLoanDetails(coveredLoan).lender, flagged, "covered fill: lender-of-record");
        assertEq(_credits(flagged), 1, "covered fill: no credit spent");
        assertEq(_count(logs, T_CAPACITY_SPENT), 1, "covered fill: the solver is charged once");
        assertEq(_count(logs, T_PRIORITY_FILL), 0, "covered fill: no IntentPriorityFill");
        assertEq(_count(logs, T_CREDIT_CONSUMED), 0, "covered fill: no PerkCreditConsumed");

        // Spend whatever the solver still holds, through the Diamond-gated charge.
        _exhaustSolver();

        // 2. Exhausted + NOT opted in: refused by name, nothing spent.
        _assertView(plain, false, 0, false, false, "plain, exhausted");
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityExhausted.selector, SOLVER, solver, classCost, 0)
        );
        _fill(plain, cp2);

        // 3. Exhausted + opted in + one credit: the fill goes through on the credit,
        //    the solver's bucket is untouched, and exactly one credit is spent.
        _assertView(flagged, true, 1, false, true, "flagged, exhausted, one credit");
        LibVaipakam.CapacityBucket memory before = ServiceCapacityFacet(diamond).getCapacityBucket(SOLVER, solver);
        vm.recordLogs();
        uint256 creditLoan = _fill(flagged, cp3);
        logs = vm.getRecordedLogs();
        assertEq(LoanFacet(diamond).getLoanDetails(creditLoan).lender, flagged, "credit fill: lender-of-record");
        assertEq(_credits(flagged), 0, "credit fill: exactly one credit spent");
        _assertBucketUnchanged(before);
        assertEq(_count(logs, T_CAPACITY_SPENT), 0, "credit fill: no capacity charge");
        assertEq(_count(logs, T_CREDIT_CONSUMED), 1, "credit fill: PerkCreditConsumed once");
        assertEq(_count(logs, T_PRIORITY_FILL), 1, "credit fill: IntentPriorityFill once");
        _assertPriorityFillEvent(logs, creditLoan);

        // 4. The same opted-in intent with its credit gone: refused again.
        _assertView(flagged, true, 0, false, false, "flagged, exhausted, no credit");
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityExhausted.selector, SOLVER, solver, classCost, 0)
        );
        _fill(flagged, cp4);
    }

    // ─── steps ──────────────────────────────────────────────────────────────

    function _load(string memory slug) internal {
        string memory art =
            vm.readFile(string.concat(vm.projectRoot(), "/deployments/", slug, "/addresses.json"));
        diamond = vm.parseJsonAddress(art, ".diamond");
        admin = vm.parseJsonAddress(art, ".admin");
        weth = vm.parseJsonAddress(art, ".weth");
        collateral = vm.parseJsonAddress(art, ".testnetMocks.liquidToken");
        vpfi = VPFITokenFacet(diamond).getVPFIToken();
        assertTrue(vpfi != address(0), "fixture-live: the Diamond has a VPFI token");
        assertTrue(
            AccessControlFacet(diamond).hasRole(LibAccessControl.ADMIN_ROLE, admin),
            "fixture-live: the artifact's admin holds ADMIN_ROLE (testnets are not handed over)"
        );

        // Both legs LIQUID on the live oracle, or the intent's LTV floor is
        // unresolvable and the fill never reaches the perk.
        assertEq(uint8(OracleFacet(diamond).checkLiquidity(weth)), uint8(LibVaipakam.LiquidityStatus.Liquid), "WETH liquid");
        assertEq(
            uint8(OracleFacet(diamond).checkLiquidity(collateral)),
            uint8(LibVaipakam.LiquidityStatus.Liquid),
            "collateral liquid"
        );

        // The live Solver curve is the one deployed — read, never set here.
        LibVaipakam.CapacityCurve memory curve = ServiceCapacityFacet(diamond).getCapacityCurve(SOLVER);
        assertGt(curve.freeTier, 0, "fixture-live: the Solver curve is lit on the live Diamond");
        classCost = curve.classCost;

        solver = makeAddr("forkPrioritySolver");
        flagged = makeAddr("forkPriorityFlaggedLender");
        plain = makeAddr("forkPriorityPlainLender");
        borrower = makeAddr("forkPriorityBorrower");
        _openIntent(flagged);
        _openIntent(plain);
    }

    /// @dev The arming write, on the fork only: before it, perk 1 does not sell;
    ///      after it, every protocol-wide condition holds. On a Diamond already
    ///      armed live, the live price is used and the straddle is not repeated.
    function _armOnTheFork() internal returns (uint256 price) {
        (,,,, bool armed,,,,) = PerkFacet(diamond).getPriorityRoutingStatus();
        if (!armed) {
            (uint256 livePrice,,) = PerkFacet(diamond).getPerkConfig(PERK);
            assertEq(livePrice, 0, "fixture-live: an unarmed Diamond is unpriced");
            _depositVpfi(flagged, 10e18);
            vm.expectRevert(abi.encodeWithSelector(PerkFacet.PerkNotForSale.selector, PERK));
            vm.prank(flagged);
            PerkFacet(diamond).purchasePerk(PERK, 1, ARMING_PRICE, 0);

            vm.recordLogs();
            vm.prank(admin);
            PerkFacet(diamond).setPerkConfig(PERK, ARMING_PRICE, 0);
            assertEq(_count(vm.getRecordedLogs(), T_ARMED), 1, "the priced counted write arms the effect");
        }
        (bool purchasable, bool notPaused, bool vpfiSet, bool priced, bool nowArmed, bool deliverable, bool counted,
            bool lit, bool live) = PerkFacet(diamond).getPriorityRoutingStatus();
        assertTrue(notPaused && vpfiSet && priced && nowArmed && deliverable && counted && lit && live, "every part");
        assertTrue(purchasable, "perk 1 is purchasable once armed");
        (price,,) = PerkFacet(diamond).getPerkConfig(PERK);
        assertGt(price, 0, "priced");
    }

    function _buyOneCredit(uint256 price) internal {
        if (_vaultVpfi(flagged) < price) _depositVpfi(flagged, price);
        uint256 vaultBefore = _vaultVpfi(flagged);
        vm.prank(flagged);
        PerkFacet(diamond).purchasePerk(PERK, 1, price, 0);
        assertEq(_credits(flagged), 1, "one credit bought");
        assertEq(vaultBefore - _vaultVpfi(flagged), price, "paid exactly the price from the vault");

        vm.prank(flagged);
        LenderIntentFacet(diamond).setLenderIntentPriority(weth, collateral, true);
    }

    function _openIntent(address lender) internal {
        vm.prank(lender);
        LenderIntentFacet(diamond).setLenderIntent(
            weth, collateral, 10 * PRINCIPAL, RATE_BPS, MAX_INIT_LTV_BPS, DURATION_DAYS, PRINCIPAL / 10, false, true
        );
        uint256 fund = 4 * PRINCIPAL;
        deal(weth, lender, fund);
        vm.prank(lender);
        IERC20(weth).approve(diamond, fund);
        vm.prank(lender);
        LenderIntentFacet(diamond).fundLenderIntent(weth, collateral, fund);
    }

    function _postBorrowerOffer() internal returns (uint256 offerId) {
        uint256 collateralAmount = _collateralFor(PRINCIPAL, 30_000); // 300% of the principal's value
        deal(collateral, borrower, IERC20(collateral).balanceOf(borrower) + collateralAmount);
        vm.prank(borrower);
        IERC20(collateral).approve(diamond, collateralAmount);
        vm.prank(borrower);
        offerId = OfferCreateFacet(diamond).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: weth,
                amount: PRINCIPAL,
                interestRateBps: RATE_BPS,
                collateralAsset: collateral,
                collateralAmount: collateralAmount,
                durationDays: DURATION_DAYS,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: weth,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: RATE_BPS,
                collateralAmountMax: collateralAmount,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
    }

    function _fill(address lender, uint256 counterpartyOfferId) internal returns (uint256 loanId) {
        vm.prank(solver);
        loanId = OfferMatchIntentFacet(diamond).matchIntent(lender, weth, collateral, counterpartyOfferId, PRINCIPAL);
    }

    /// @dev Spend the solver's remaining actions through the Diamond-gated charge
    ///      (the route every gated entry takes), so its bucket is empty at this
    ///      second. Bounded: the live ceiling is a handful of actions.
    function _exhaustSolver() internal {
        address s = solver; // read BEFORE the prank
        for (uint256 i = 0; i < 1000; i++) {
            (uint256 accrued,,,) = ServiceCapacityFacet(diamond).previewCapacity(SOLVER, s);
            if (accrued < classCost) break;
            vm.prank(diamond);
            ServiceCapacityFacet(diamond).capacityChargeInternal(SOLVER, s);
        }
        (uint256 left,,,) = ServiceCapacityFacet(diamond).previewCapacity(SOLVER, s);
        assertEq(left, 0, "fixture-live: the solver's bucket is exhausted");
    }

    // ─── reads and assertions ───────────────────────────────────────────────

    function _depositVpfi(address who, uint256 amount) internal {
        deal(vpfi, who, IERC20(vpfi).balanceOf(who) + amount);
        vm.prank(who);
        IERC20(vpfi).approve(diamond, amount);
        vm.prank(who);
        VPFIDiscountFacet(diamond).depositVPFIToVault(amount);
    }

    function _vaultVpfi(address who) internal view returns (uint256) {
        address vault = VaultFactoryFacet(diamond).getUserVaultAddress(who);
        return vault == address(0) ? 0 : IERC20(vpfi).balanceOf(vault);
    }

    function _credits(address who) internal view returns (uint256 c) {
        (,, c) = PerkFacet(diamond).getPerkEntitlement(who, PERK);
    }

    function _assertView(
        address owner,
        bool enabled,
        uint256 credits,
        bool capacityCovers,
        bool creditUnlocks,
        string memory tag
    ) internal view {
        (bool e, uint256 c, bool cc, bool cu) =
            LenderIntentFacet(diamond).getLenderIntentPriority(owner, weth, collateral, solver, tx.origin);
        assertEq(e, enabled, string.concat(tag, ": enabled"));
        assertEq(c, credits, string.concat(tag, ": credits"));
        assertEq(cc, capacityCovers, string.concat(tag, ": capacityCovers"));
        assertEq(cu, creditUnlocks, string.concat(tag, ": creditUnlocks"));
    }

    function _assertBucketUnchanged(LibVaipakam.CapacityBucket memory a) internal view {
        LibVaipakam.CapacityBucket memory b = ServiceCapacityFacet(diamond).getCapacityBucket(SOLVER, solver);
        assertEq(a.balance, b.balance, "credit fill: bucket balance untouched");
        assertEq(a.lastTouch, b.lastTouch, "credit fill: bucket lastTouch untouched");
        assertEq(a.curveEpoch, b.curveEpoch, "credit fill: bucket curveEpoch untouched");
        assertEq(a.seen, b.seen, "credit fill: bucket seen untouched");
    }

    function _assertPriorityFillEvent(Vm.Log[] memory logs, uint256 loanId) internal view {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != T_PRIORITY_FILL) continue;
            assertEq(logs[i].emitter, diamond, "IntentPriorityFill: emitted by the Diamond");
            assertEq(address(uint160(uint256(logs[i].topics[1]))), flagged, "IntentPriorityFill: owner");
            assertEq(address(uint160(uint256(logs[i].topics[2]))), weth, "IntentPriorityFill: lendingAsset");
            assertEq(address(uint160(uint256(logs[i].topics[3]))), collateral, "IntentPriorityFill: collateralAsset");
            (uint256 lid, address slv, uint256 left) = abi.decode(logs[i].data, (uint256, address, uint256));
            assertEq(lid, loanId, "IntentPriorityFill: loanId");
            assertEq(slv, solver, "IntentPriorityFill: solver");
            assertEq(left, 0, "IntentPriorityFill: creditsLeft");
        }
    }

    function _count(Vm.Log[] memory logs, bytes32 topic0) internal view returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == diamond && logs[i].topics.length != 0 && logs[i].topics[0] == topic0) n++;
        }
    }

    /// @dev Collateral amount worth `ratioBps` of `principal`, from the live
    ///      oracle prices of both legs.
    function _collateralFor(uint256 principal, uint256 ratioBps) internal view returns (uint256) {
        (uint256 pPrice, uint8 pDec) = OracleFacet(diamond).getAssetPrice(weth);
        (uint256 cPrice, uint8 cDec) = OracleFacet(diamond).getAssetPrice(collateral);
        uint256 usd = principal * pPrice / (10 ** pDec); // 18-dec token amounts
        return usd * ratioBps * (10 ** cDec) / cPrice / 10_000;
    }
}
