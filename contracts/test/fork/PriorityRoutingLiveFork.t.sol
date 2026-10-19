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
 *         Self-gates on `FORK_URL_BASE_SEPOLIA` like the other fork suites, and
 *         reads the Diamond from `FORK_DIAMOND` (defaulting to Base Sepolia's).
 *         The curve and price are the figures proposed for the live arming.
 */
interface IDiamondForProof {
    // ServiceCapacityFacet
    function setCapacityCurve(uint8, uint256, uint256, uint256, uint256) external;
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
    function updateRiskParams(address, uint256, uint256, uint256) external;
    function depositVPFIToVault(uint256) external;
    function getVPFIToken() external view returns (address);
    function owner() external view returns (address);
    function setPartialFillEnabled(bool) external;
}

contract PriorityRoutingLiveFork is Test {
    address internal constant BASE_SEPOLIA_DIAMOND = 0x2535baC87F3df287268fC697F2f31cf418365303;

    uint256 internal constant PERK = 1; // LibPriorityRouting.PERK_ID
    uint8 internal constant SOLVER = uint8(LibVaipakam.ServiceCapacityRole.Solver);
    // The proposed testnet Solver curve: one fill costs 3.6e9 units, the free
    // refill is 1e6 units a second (one fill an hour), the free tier holds five
    // fills, and capacity reaches 4x at a 10,000 VPFI deposit.
    uint256 internal constant COST = 3_600_000_000;
    uint256 internal constant RATE = 1_000_000;
    uint256 internal constant FREE = 5 * COST;
    uint256 internal constant AT4X = 10_000e18;
    uint256 internal constant PRICE = 10e18; // VPFI per credit (proposed)

    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant MIN_RATE_BPS = 500;
    uint32 internal constant MAX_DURATION = 30;

    bytes32 internal constant T_PRIORITY_FILL =
        keccak256("IntentPriorityFill(address,address,address,uint256,address,uint256)");
    bytes32 internal constant T_CREDIT_CONSUMED = keccak256("PerkCreditConsumed(address,uint256,uint256)");
    bytes32 internal constant T_CAPACITY_SPENT = keccak256("CapacitySpent(uint8,address,uint256,uint256)");

    IDiamondForProof internal d;
    address internal admin;
    address internal solver;
    address internal flagged; // the intent owner who buys a credit and opts in
    address internal plain; // an intent owner who does not
    address internal lendAsset;
    address internal collAsset;
    bool internal live;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL_BASE_SEPOLIA", string(""));
        if (bytes(url).length == 0) return; // self-gate: no RPC, no proof
        vm.createSelectFork(url);
        live = true;
        d = IDiamondForProof(vm.envOr("FORK_DIAMOND", BASE_SEPOLIA_DIAMOND));
        admin = d.owner();
        solver = makeAddr("proofSolver");
        flagged = makeAddr("flaggedOwner");
        plain = makeAddr("plainOwner");

        // Two throwaway tokens, priced through the oracle seam only.
        lendAsset = address(new ERC20Mock("Proof Lend", "pL", 18));
        collAsset = address(new ERC20Mock("Proof Coll", "pC", 18));
        _mockOracle(lendAsset);
        _mockOracle(collAsset);
        vm.mockCall(address(d), abi.encodeWithSignature("calculateHealthFactor(uint256)"), abi.encode(2e18));
        vm.mockCall(address(d), abi.encodeWithSignature("calculateLTV(uint256)"), abi.encode(uint256(5000)));

        vm.startPrank(admin);
        d.updateRiskParams(lendAsset, 8000, 300, 1000);
        d.updateRiskParams(collAsset, 8000, 300, 1000);
        d.setPartialFillEnabled(true);
        d.setLenderIntentEnabled(true);
        vm.stopPrank();

        _openIntent(flagged);
        _openIntent(plain);
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
        ERC20Mock(lendAsset).mint(who, 10 * PRINCIPAL);
        vm.startPrank(who);
        d.setLenderIntent(lendAsset, collAsset, 10_000 ether, MIN_RATE_BPS, 5000, MAX_DURATION, 100 ether, false, true);
        ERC20Mock(lendAsset).approve(address(d), 3 * PRINCIPAL);
        d.fundLenderIntent(lendAsset, collAsset, 3 * PRINCIPAL);
        vm.stopPrank();
    }

    function _postBorrower(string memory name) internal returns (uint256 offerId) {
        address b = makeAddr(name);
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
                collateralAmount: 2 * PRINCIPAL,
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
                collateralAmountMax: 2 * PRINCIPAL,
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

    function _credits(address who) internal view returns (uint256 c) {
        (,, c) = d.getPerkEntitlement(who, PERK);
    }

    function test_ForkProof_OneCreditFillsOnePriorityIntentWhileAnOrdinaryOneIsRefused() public {
        if (!live) {
            vm.skip(true);
            return;
        }
        // 1. Light the limiter, then arm the perk: the arming write is the price.
        vm.startPrank(admin);
        d.setCapacityCurve(SOLVER, FREE, RATE, AT4X, COST);
        d.setPerkConfig(PERK, PRICE, 0);
        vm.stopPrank();

        // 2. The flagged owner buys ONE credit with VPFI from their vault, and
        //    opts the intent in.
        address vpfi = d.getVPFIToken();
        deal(vpfi, flagged, PRICE);
        vm.startPrank(flagged);
        (bool ok,) = vpfi.call(abi.encodeWithSignature("approve(address,uint256)", address(d), PRICE));
        assertTrue(ok, "approve");
        d.depositVPFIToVault(PRICE);
        d.purchasePerk(PERK, 1, PRICE, 0);
        d.setLenderIntentPriority(lendAsset, collAsset, true);
        vm.stopPrank();
        assertEq(_credits(flagged), 1, "one credit bought");

        // 3. Exhaust the solver's bucket through the Diamond-gated charge the
        //    gated routes use, until the limiter refuses. A bucket seen for the
        //    first time holds exactly one free action (TokenomicsTechSpec), so
        //    one charge spends it; the loop does not assume the count.
        uint256 charged;
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(address(d));
            (bool spent,) = address(d).call(abi.encodeCall(IDiamondForProof.capacityChargeInternal, (SOLVER, solver)));
            if (!spent) break;
            charged++;
        }
        assertGt(charged, 0, "fixture-live: at least one free action was spent");
        (uint256 accrued,,,) = d.previewCapacity(SOLVER, solver);
        assertLt(accrued, COST, "fixture-live: the solver cannot afford a fill");
        (, , bool covers, bool unlocks) = d.getLenderIntentPriority(flagged, lendAsset, collAsset, solver, solver);
        assertFalse(covers, "capacity does not cover");
        assertTrue(unlocks, "the credit unlocks the flagged intent");

        // 4. The flagged fill goes through on the credit, spending exactly one,
        //    with no capacity charge.
        uint256 cp1 = _postBorrower("proof-borrower-1");
        vm.recordLogs();
        vm.prank(solver);
        uint256 loanId = d.matchIntent(flagged, lendAsset, collAsset, cp1, PRINCIPAL);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(loanId, 0, "the flagged fill landed");
        assertEq(_credits(flagged), 0, "exactly one credit spent");
        assertEq(_count(logs, T_PRIORITY_FILL), 1, "IntentPriorityFill once");
        assertEq(_count(logs, T_CREDIT_CONSUMED), 1, "PerkCreditConsumed once");
        assertEq(_count(logs, T_CAPACITY_SPENT), 0, "no capacity charge");

        // 5. The unflagged intent is refused for capacity at the same moment.
        uint256 cp2 = _postBorrower("proof-borrower-2");
        (, , bool plainCovers, bool plainUnlocks) = d.getLenderIntentPriority(plain, lendAsset, collAsset, solver, solver);
        assertFalse(plainCovers || plainUnlocks, "nothing lets the unflagged intent through");
        vm.prank(solver);
        vm.expectPartialRevert(bytes4(keccak256("ServiceCapacityExhausted(uint8,address,uint256,uint256)")));
        d.matchIntent(plain, lendAsset, collAsset, cp2, PRINCIPAL);
    }
}
