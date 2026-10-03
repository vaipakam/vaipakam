// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {MockUniswapV3Pool} from "../../script/mocks/MockUniswapV3.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";
import {DeployTestnetMocks} from "../../script/DeployTestnetMocks.s.sol";
import {RepriceTestnetMock} from "../../script/RepriceTestnetMock.s.sol";
import {MockPoolPricing} from "../../script/lib/MockPoolPricing.sol";
import {TestnetMockOracleRig} from "./TestnetMockOracleRig.sol";

/**
 * @title TestnetMockRepriceTest
 * @notice Drives {RepriceTestnetMock}'s checks and writes against the real
 *         oracle wired to the real faucet mocks ({TestnetMockOracleRig}), so
 *         the script is proven against what the oracle actually counts
 *         rather than against its own arithmetic (#2314).
 *
 *         The case that matters is the contrast: a FEED-ONLY move past the
 *         TWAP-consistency band flips tLIQ Illiquid (the shape #2314 first
 *         misread as pool depth), while the script's feed + pool + venue move
 *         to the same price keeps it Liquid, all the way down a 55% drawdown.
 *
 * @dev    Inherits the script to call its internal steps directly; the rig
 *         deployed every mock from this contract, so this contract is their
 *         owner — the same relationship the broadcaster has on a testnet.
 *         Refusals go through `external` wrappers so `expectRevert` sees a
 *         call.
 */
contract TestnetMockRepriceTest is TestnetMockOracleRig, RepriceTestnetMock {
    uint256 constant LIQUID = uint256(LibVaipakam.LiquidityStatus.Liquid);
    uint256 constant ILLIQUID = uint256(LibVaipakam.LiquidityStatus.Illiquid);

    RepriceTarget internal tliqTarget;

    function setUp() public override {
        super.setUp();
        tliqTarget = RepriceTarget({
            diamond: address(diamond),
            asset: address(tLIQ),
            quote: address(weth),
            feed: address(tliqFeed),
            pool: tliqPool,
            venue: address(venue),
            registry: address(registry),
            factory: address(univ3)
        });
    }

    /// @dev Both parents are scripts; this contract is not one.
    function run() external pure override(DeployTestnetMocks, RepriceTestnetMock) {
        revert("TestnetMockRepriceTest: not a script");
    }

    // ── The #2314 contrast ──────────────────────────────────────────────

    /// @notice The rehearsal shape #2314 first misdiagnosed: the feed moves,
    ///         the static mock pool does not, and the oracle stops counting
    ///         the pool. Nothing about depth changed.
    function test_feedOnlyMovePastTheBand_readsIlliquid() public {
        assertEq(_status(address(tLIQ)), LIQUID, "seeded Liquid");
        tliqFeed.setPrice(int256(1_600e8)); // -20%, far past the 3% band
        assertEq(_status(address(tLIQ)), ILLIQUID, "feed-only move reads Illiquid");
    }

    /// @notice The same drawdown done by the script stays Liquid at every
    ///         step, the oracle reads each new price, the venue pays it, and
    ///         the pool sits at the spot the shared pricing math gives.
    function test_coherentReprice_staysLiquidThroughA55PercentDrawdown() public {
        uint256[5] memory steps = [uint256(1_960e8), 1_600e8, 1_200e8, 1_000e8, 900e8];
        for (uint256 i; i < steps.length; ++i) {
            _reprice(tliqTarget, steps[i], false, false);
            assertEq(_status(address(tLIQ)), LIQUID, "Liquid after a coherent reprice");
            (uint256 p,) = OracleFacet(address(diamond)).getAssetPrice(address(tLIQ));
            assertEq(p, steps[i], "oracle reads the new price");
            assertEq(venue.tokenUsdPrice8(address(tLIQ)), steps[i], "venue pays the new price");
            assertEq(
                uint256(MockUniswapV3Pool(tliqPool).sqrtPriceX96()),
                uint256(MockPoolPricing.sqrtPriceX96(address(tLIQ), steps[i], address(weth), P_MWETH)),
                "pool spot is the value-balanced spot"
            );
        }
    }

    function test_coherentReprice_upwardMoveStaysLiquid() public {
        _reprice(tliqTarget, 2_600e8, false, false);
        assertEq(_status(address(tLIQ)), LIQUID, "Liquid after +30%");
        (uint256 p,) = OracleFacet(address(diamond)).getAssetPrice(address(tLIQ));
        assertEq(p, 2_600e8, "oracle reads the new price");
    }

    /// @notice The second faucet liquid token reprices the same way, on its
    ///         own pool, without touching tLIQ.
    function test_coherentReprice_mUsdc() public {
        RepriceTarget memory t = tliqTarget;
        t.asset = address(mUSDC);
        t.feed = address(musdcFeed);
        t.pool = musdcPool;
        _reprice(t, 0.97e8, false, false); // a depeg to $0.97
        assertEq(_status(address(mUSDC)), LIQUID, "mUSDC Liquid after the move");
        assertEq(_status(address(tLIQ)), LIQUID, "tLIQ untouched");
        (uint256 p,) = OracleFacet(address(diamond)).getAssetPrice(address(tLIQ));
        assertEq(p, P_TLIQ, "tLIQ price untouched");
    }

    function test_skipVenue_leavesTheVenueAtItsOldPrice() public {
        _reprice(tliqTarget, 1_600e8, true, false);
        assertEq(venue.tokenUsdPrice8(address(tLIQ)), P_TLIQ, "venue left at the old price");
        assertEq(_status(address(tLIQ)), LIQUID, "feed + pool still move together");
    }

    // ── Pre-flight refusals ─────────────────────────────────────────────

    /// @notice mWETH's feed IS the WETH quote feed. Repricing it would move
    ///         the quote leg of every faucet pool, so it is refused.
    function test_refuses_anAssetThatSharesTheWethFeed() public {
        RepriceTarget memory t = tliqTarget;
        t.asset = address(mWETH);
        t.feed = address(ethFeed);
        t.pool = mwethPool;
        vm.expectRevert(
            bytes("RepriceTestnetMock: the asset shares its feed with WETH - repricing it moves every pool's quote leg")
        );
        this.preflightExt(t, address(this), false);
    }

    function test_refuses_aBroadcasterThatDoesNotOwnTheMocks() public {
        vm.expectRevert(bytes("RepriceTestnetMock: broadcaster does not own the feed"));
        this.preflightExt(tliqTarget, makeAddr("passer-by"), false);
    }

    /// @notice An artifact naming another pool for the asset no longer
    ///         describes the chain (the #2313 class of drift).
    function test_refuses_aRecordedPoolTheFactoryDoesNotReturn() public {
        RepriceTarget memory t = tliqTarget;
        t.pool = musdcPool;
        vm.expectRevert(bytes("RepriceTestnetMock: recorded pool is not the factory's live asset/WETH pool"));
        this.preflightExt(t, address(this), false);
    }

    function test_refuses_aRecordedFeedTheRegistryDoesNotReturn() public {
        RepriceTarget memory t = tliqTarget;
        t.feed = address(musdcFeed);
        vm.expectRevert(bytes("RepriceTestnetMock: recorded feed is not the registry's live asset/USD feed"));
        this.preflightExt(t, address(this), false);
    }

    /// @notice A venue the Diamond does not route through — a stale record,
    ///         or another adapter the same owner deployed — would be repriced
    ///         while liquidations keep settling on the real one at the old
    ///         price.
    function test_refuses_aVenueTheDiamondDoesNotRoute() public {
        RepriceTarget memory t = tliqTarget;
        t.venue = address(new MockSwapAdapter("unregistered")); // owned by this contract, too
        vm.expectRevert(bytes("RepriceTestnetMock: recorded venue is not in the Diamond's live adapter list"));
        this.preflightExt(t, address(this), false);
    }

    function test_refuses_aDisabledVenue() public {
        AdminFacet(address(diamond)).setSwapAdapterDisabled(address(venue), true);
        vm.expectRevert(bytes("RepriceTestnetMock: recorded venue is registered but disabled on the Diamond"));
        this.preflightExt(tliqTarget, address(this), false);
    }

    /// @notice With the venue skipped, its registration is not the run's
    ///         concern — it is not touched.
    function test_skipVenue_doesNotRequireARoutedVenue() public {
        RepriceTarget memory t = tliqTarget;
        t.venue = address(new MockSwapAdapter("unregistered"));
        this.preflightExt(t, address(this), true);
    }

    function test_refuses_aZeroPrice() public {
        vm.expectRevert(bytes("RepriceTestnetMock: REPRICE_USD_E8 is zero"));
        this.targetSpotExt(tliqTarget, 0);
    }

    // ── Post-apply refusals ─────────────────────────────────────────────

    /// @notice A coherent move that still leaves the asset Illiquid is a
    ///         depth or band limit, not a rehearsal state — refused unless
    ///         the operator opts in. The oracle's verdict is mocked AFTER the
    ///         writes: this pins the guard's logic, not a pool configuration
    ///         that happens to fail at one price.
    function test_verify_refusesASilentFlipToIlliquid() public {
        RepriceTestnetMock.PriceReading memory before = _read(tliqTarget);
        assertEq(before.liquidity, LIQUID, "seeded Liquid");
        uint160 spot = _targetSpot(tliqTarget, 1_600e8);
        _applyReprice(tliqTarget, 1_600e8, spot, false);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, address(tLIQ)),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        vm.expectRevert(
            bytes(
                "RepriceTestnetMock: the asset reads Illiquid after a coherent reprice - a depth or band limit, not a rehearsal state; set REPRICE_ALLOW_ILLIQUID=true to proceed"
            )
        );
        this.verifyExt(tliqTarget, 1_600e8, before, false, false);
        // Opted in, the same state passes.
        this.verifyExt(tliqTarget, 1_600e8, before, false, true);
    }

    /// @notice If the Diamond does not read the price just written — a
    ///         registry it is not wired to — the run is refused.
    function test_verify_refusesWhenTheDiamondDoesNotReadTheNewPrice() public {
        RepriceTestnetMock.PriceReading memory before = _read(tliqTarget);
        uint160 spot = _targetSpot(tliqTarget, 1_600e8);
        _applyReprice(tliqTarget, 1_600e8, spot, false);
        // Stand in for a Diamond that never saw the write: put the feed AND
        // the pool back, so the asset stays Liquid and only the price check
        // can catch it (resetting the feed alone trips the Illiquid guard
        // instead, which is a different refusal).
        tliqFeed.setPrice(int256(P_TLIQ));
        MockUniswapV3Pool(tliqPool).setSqrtPriceX96(before.poolSpot);
        assertEq(_status(address(tLIQ)), LIQUID, "still Liquid, so only the price check can refuse");
        vm.expectRevert(
            bytes("RepriceTestnetMock: the Diamond does not read the new price - is it wired to this registry?")
        );
        this.verifyExt(tliqTarget, 1_600e8, before, false, false);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /// @dev The script's `run()` sequence minus artifact resolution and
    ///      broadcast: pre-flight, target spot, writes, verify.
    function _reprice(RepriceTarget memory t, uint256 price8, bool skipVenue, bool allowIlliquid) internal {
        _preflight(t, address(this), skipVenue);
        RepriceTestnetMock.PriceReading memory before = _read(t);
        uint160 spot = _targetSpot(t, price8);
        _applyReprice(t, price8, spot, skipVenue);
        _verifyReprice(t, price8, before, skipVenue, allowIlliquid);
    }

    function preflightExt(RepriceTarget memory t, address sender, bool skipVenue) external view {
        _preflight(t, sender, skipVenue);
    }

    function targetSpotExt(RepriceTarget memory t, uint256 price8) external view returns (uint160) {
        return _targetSpot(t, price8);
    }

    function verifyExt(
        RepriceTarget memory t,
        uint256 price8,
        RepriceTestnetMock.PriceReading memory before,
        bool skipVenue,
        bool allowIlliquid
    ) external view {
        _verifyReprice(t, price8, before, skipVenue, allowIlliquid);
    }
}
