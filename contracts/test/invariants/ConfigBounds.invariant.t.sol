// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {HelperTest} from "../HelperTest.sol";

/**
 * @title ConfigBoundsInvariant
 * @notice Every ConfigFacet setter individually rejects out-of-bound values
 *         (unit-tested). This invariant verifies that after ANY multi-step
 *         sequence — arbitrary interleavings of every setter, with arbitrary
 *         arguments — every effective getter still returns a value within
 *         its declared cap, and tier tables stay monotone.
 *
 *         Catches regressions where a future setter lands in storage bypassing
 *         validation, where a cap constant is relaxed without updating a
 *         sibling getter, or where a setter with a composite payload
 *         accidentally writes an invalid intermediate state.
 *
 *         Caps mirror the private constants in ConfigFacet:
 *           MAX_FEE_BPS       = 5_000 (50%)
 *           MAX_SLIPPAGE_BPS  = 2_500 (25%)
 *           MAX_INCENTIVE_BPS = 2_000 (20%)
 *           MAX_DISCOUNT_BPS  = 9_000 (90%)
 *         plus volatilityLtvThresholdBps > 10_000 when non-zero, staking APR
 *         capped at 100%, and tier monotonicity (strict thresholds up to t3,
 *         ≤ to t4; non-strict on discount BPS T1..T4).
 *
 *         Minimal diamond: only AccessControlFacet + ConfigFacet needed.
 *         No lending machinery deployed so the fuzz surface stays tight.
 */
contract ConfigBoundsInvariant is Test {
    VaipakamDiamond public DIAMOND;
    ConfigHandler public handler;

    function setUp() public {
        address owner = address(this);

        DiamondCutFacet cut = new DiamondCutFacet();
        DIAMOND = new VaipakamDiamond(owner, address(cut));

        HelperTest helper = new HelperTest();
        AccessControlFacet ac = new AccessControlFacet();
        ConfigFacet cfg = new ConfigFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(ac),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAccessControlFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(cfg),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getConfigFacetSelectors()
        });
        IDiamondCut(address(DIAMOND)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(DIAMOND)).initializeAccessControl();
        // Diamond born paused (LibPausable). Clear via direct
        // storage write since this fixture doesn't cut AdminFacet.
        vm.store(address(DIAMOND), bytes32(uint256(0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400)), bytes32(0));

        handler = new ConfigHandler(address(DIAMOND));
        // Owner has ADMIN_ROLE after initializeAccessControl; delegate to
        // handler so the fuzzer can call every setter from a consistent
        // caller without tripping access control.
        AccessControlFacet(address(DIAMOND)).grantRole(
            keccak256("ADMIN_ROLE"),
            address(handler)
        );
        targetContract(address(handler));
    }

    // ─── Invariants ─────────────────────────────────────────────────────

    uint256 private constant MAX_FEE_BPS = 5_000;
    uint256 private constant MAX_SLIPPAGE_BPS = 2_500;
    uint256 private constant MAX_INCENTIVE_BPS = 2_000;
    uint256 private constant MAX_DISCOUNT_BPS = 9_000;
    uint256 private constant MAX_STAKING_APR_BPS = 10_000;

    /// @notice Fees resolved through ConfigFacet never exceed MAX_FEE_BPS.
    function invariant_FeesWithinCap() public view {
        (uint256 treasury, uint256 init) =
            ConfigFacet(address(DIAMOND)).getFeesConfig();
        assertLe(treasury, MAX_FEE_BPS, "treasuryFeeBps > cap");
        assertLe(init, MAX_FEE_BPS, "loanInitiationFeeBps > cap");
    }

    /// @notice Liquidation knobs all sit within their individual caps.
    function invariant_LiquidationConfigWithinCaps() public view {
        (uint256 handlingFee, uint256 slippage, uint256 incentive) =
            ConfigFacet(address(DIAMOND)).getLiquidationConfig();
        assertLe(handlingFee, MAX_FEE_BPS, "handlingFeeBps > cap");
        assertLe(slippage, MAX_SLIPPAGE_BPS, "maxSlippageBps > cap");
        assertLe(incentive, MAX_INCENTIVE_BPS, "maxIncentiveBps > cap");
    }

    /// @notice Volatility-LTV threshold, when set, always sits strictly above
    ///         100% LTV — otherwise every healthy loan would trigger fallback.
    ///         Rental buffer sits within its cap.
    function invariant_RiskConfigSafe() public view {
        (uint256 vol, uint256 rental) =
            ConfigFacet(address(DIAMOND)).getRiskConfig();
        assertGt(vol, LibVaipakam.BASIS_POINTS, "volatility LTV <= 100%");
        assertLe(rental, MAX_FEE_BPS, "rentalBufferBps > cap");
    }

    /// @notice Staking APR resolved through the getter stays within 100%.
    function invariant_StakingAprWithinCap() public view {
        uint256 apr = ConfigFacet(address(DIAMOND)).getStakingAprBps();
        assertLe(apr, MAX_STAKING_APR_BPS, "stakingAprBps > 100%");
    }

    /// @notice Tier thresholds are strictly increasing up to T3 and
    ///         non-decreasing T3 → T4, regardless of how setters were
    ///         interleaved. Matches the NonMonotoneTierThresholds guard.
    function invariant_TierThresholdsMonotone() public view {
        (uint256 t1, uint256 t2, uint256 t3, uint256 t4) =
            ConfigFacet(address(DIAMOND)).getVpfiTierThresholds();
        assertLt(t1, t2, "t1 >= t2");
        assertLt(t2, t3, "t2 >= t3");
        assertLe(t3, t4, "t3 > t4");
    }

    /// @notice Tier discounts are non-decreasing across T1..T4 and each stays
    ///         within MAX_DISCOUNT_BPS. A lower-balance user must never see a
    ///         higher discount than a higher-balance user.
    function invariant_TierDiscountsMonotoneAndCapped() public view {
        (uint256 d1, uint256 d2, uint256 d3, uint256 d4) =
            ConfigFacet(address(DIAMOND)).getVpfiTierDiscountBps();
        assertLe(d1, MAX_DISCOUNT_BPS, "d1 > cap");
        assertLe(d2, MAX_DISCOUNT_BPS, "d2 > cap");
        assertLe(d3, MAX_DISCOUNT_BPS, "d3 > cap");
        assertLe(d4, MAX_DISCOUNT_BPS, "d4 > cap");
        assertLe(d1, d2, "d1 > d2");
        assertLe(d2, d3, "d2 > d3");
        assertLe(d3, d4, "d3 > d4");
    }
}

/**
 * @dev Fuzz handler — sprays arbitrary uint16 / uint256 arguments across every
 *      ConfigFacet setter. Reverts are caught so the fuzzer exercises both
 *      in-range and out-of-range paths; the invariant check runs after every
 *      call and must survive.
 */
contract ConfigHandler is Test {
    address public immutable DIAMOND;

    constructor(address _diamond) {
        DIAMOND = _diamond;
    }

    function setFeesConfig(uint16 treasury, uint16 init) external {
        try ConfigFacet(DIAMOND).setFeesConfig(treasury, init) {} catch {}
    }

    function setLiquidationConfig(
        uint16 handlingFee,
        uint16 slippage,
        uint16 incentive
    ) external {
        try ConfigFacet(DIAMOND).setLiquidationConfig(handlingFee, slippage, incentive) {} catch {}
    }

    function setRiskConfig(uint16 volLtv, uint16 rental) external {
        try ConfigFacet(DIAMOND).setRiskConfig(volLtv, rental) {} catch {}
    }

    function setStakingApr(uint16 apr) external {
        try ConfigFacet(DIAMOND).setStakingApr(apr) {} catch {}
    }

    function setVpfiTierThresholds(
        uint256 t1,
        uint256 t2,
        uint256 t3,
        uint256 t4
    ) external {
        // Bound to sensible ranges so the fuzzer actually lands valid
        // orderings some fraction of the time; the invariant-breaking
        // sequences are still reachable because out-of-order combos get
        // rejected by the validator, leaving storage unchanged.
        t1 = bound(t1, 0, 1_000_000 ether);
        t2 = bound(t2, 0, 1_000_000 ether);
        t3 = bound(t3, 0, 1_000_000 ether);
        t4 = bound(t4, 0, 1_000_000 ether);
        try
            ConfigFacet(DIAMOND).setVpfiTierThresholds(t1, t2, t3, t4)
        {} catch {}
    }

    function setVpfiTierDiscountBps(
        uint16 t1,
        uint16 t2,
        uint16 t3,
        uint16 t4
    ) external {
        try
            ConfigFacet(DIAMOND).setVpfiTierDiscountBps(t1, t2, t3, t4)
        {} catch {}
    }
}
