// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory, MockUniswapV3Pool} from "./mocks/MockUniswapV3.sol";
import {MockSwapAdapter} from "../test/mocks/MockSwapAdapter.sol";
import {Deployments} from "./lib/Deployments.sol";
import {MockPoolPricing} from "./lib/MockPoolPricing.sol";

/// @dev The two Diamond views this script reads, declared narrowly so the
///      script does not compile the whole OracleFacet to call them.
///      `checkLiquidity` returns `LibVaipakam.LiquidityStatus`, which the
///      ABI encodes as a uint8: 0 = Liquid, 1 = Illiquid.
interface IOracleViews {
    function getAssetPrice(address asset) external view returns (uint256 price, uint8 decimals);
    function checkLiquidity(address asset) external view returns (uint8);
}

/**
 * @title RepriceTestnetMock
 * @notice Reprice a testnet faucet asset the way a real market moves: its
 *         mock Chainlink feed, the spot of its mock v3 `asset/WETH` pool,
 *         and (by default) its price on the registered mock swap venue —
 *         together, in one broadcast (#2314).
 *
 *         Why all three. The oracle only counts a pool whose spot agrees
 *         with the feed ratio within the TWAP-consistency band (3% by
 *         default), and the faucet pool's spot is static. Moving the feed
 *         alone past that band leaves no consistent pool, so the asset reads
 *         **Illiquid** — exactly what a pool too shallow for the trade looks
 *         like. #2314 was first diagnosed as a depth problem for that reason;
 *         it was the rehearsal, not the pool. The venue is the third place
 *         the price lives: `MockSwapAdapter` pays a liquidation's proceeds at
 *         its own registered price, so leaving it behind would settle a
 *         liquidation at the pre-move price.
 *
 *         The new pool spot is derived from ABSOLUTE prices — the new asset
 *         price against WETH's price as the Diamond's oracle reads it — with
 *         the same {MockPoolPricing} math {DeployTestnetMocks} seeded the pool
 *         with. Scaling the old spot by the price ratio would instead carry
 *         any existing drift forward.
 *
 * @dev    What it refuses, before broadcasting anything:
 *           - any chain outside the testnet set {DeployTestnetMocks} supports;
 *           - an asset other than `liquidToken` (tLIQ) or `liquidToken2`
 *             (mUSDC). mWETH is out on purpose: its feed IS the WETH quote
 *             feed, so moving it moves the quote leg of every faucet pool —
 *             the shared-feed check below refuses it even if named;
 *           - an artifact that no longer describes the chain: the recorded
 *             pool must be the factory's live `asset/WETH` pool, and the
 *             recorded feed must be the registry's live `asset/USD` feed;
 *           - a broadcaster that does not own the feed, the pool, and (unless
 *             skipped) the venue — each is owner-gated so a public testnet's
 *             demos cannot be repriced by a passer-by;
 *           - a feed not at 8 decimals, or legs at different token decimals
 *             (the pool math has no decimal term).
 *
 *         And after applying the writes in simulation, before broadcast:
 *           - the Diamond must read the new price for the asset;
 *           - an asset that read Liquid before must still read Liquid, unless
 *             `REPRICE_ALLOW_ILLIQUID=true`. A coherent move that still flips
 *             it Illiquid is a depth or band limit worth seeing, not a
 *             rehearsal state to ship silently.
 *
 *         `forge script` runs the whole body in simulation first and
 *         broadcasts only if it succeeds, so every refusal above sends
 *         nothing. The post-broadcast state is NOT re-checked by this script;
 *         the runbook (docs/ops/BaseSepoliaDeploy.md §2.6) gives the reads.
 *
 *         Env:
 *           - REPRICE_ASSET          : `liquidToken` or `liquidToken2`.
 *           - REPRICE_USD_E8         : the new USD price, 8 decimals
 *                                      (`160000000000` = $1,600).
 *           - MOCK_OWNER_PRIVATE_KEY : optional. The key that owns the mocks
 *                                      (on Base Sepolia, the mock deployer).
 *                                      Unset, the script broadcasts as
 *                                      `--sender` — with `--unlocked` on an
 *                                      Anvil fork that has impersonated the
 *                                      owner, or with `--account` /
 *                                      `--ledger` on a real chain. A dedicated
 *                                      name, so Foundry's automatic `.env`
 *                                      load cannot pick an unrelated key.
 *           - REPRICE_SKIP_VENUE     : optional, default false. Leave the
 *                                      venue's price where it is — only for a
 *                                      deliberate venue/oracle mismatch test.
 *           - REPRICE_ALLOW_ILLIQUID : optional, default false. See above.
 *
 *         Anvil first: `script/rehearse-reprice-anvil.sh` forks Base Sepolia,
 *         impersonates the mock owner and runs this script end to end.
 */
contract RepriceTestnetMock is Script {
    /// @dev Chainlink's USD denomination sentinel — the quote the faucet
    ///      feeds are registered under (same constant as DeployTestnetMocks).
    address internal constant REPRICE_USD_DENOM = 0x0000000000000000000000000000000000000348;
    /// @dev Every faucet pool is created at the 0.3% tier.
    uint24 internal constant REPRICE_POOL_FEE = 3000;
    /// @dev The faucet feeds' decimals; `REPRICE_USD_E8` is in this scale.
    uint8 internal constant REPRICE_FEED_DECIMALS = 8;

    /// @notice Every address one reprice touches or checks, resolved once.
    struct RepriceTarget {
        address diamond;
        address asset;
        address quote;
        address feed;
        address pool;
        address venue;
        address registry;
        address factory;
    }

    /// @notice What the oracle and the mocks read for the asset at one moment.
    struct PriceReading {
        uint256 oraclePrice;
        uint8 oracleDecimals;
        uint8 liquidity;
        uint160 poolSpot;
        uint256 venuePrice8;
    }

    function run() external virtual {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || cid == 11155111 || cid == 97 || cid == 421614 || cid == 11155420 || cid == 31337,
            "RepriceTestnetMock: testnet-only (84532, 11155111, 97, 421614, 11155420, 31337)"
        );

        string memory assetKey = vm.envString("REPRICE_ASSET");
        uint256 newPrice8 = vm.envUint("REPRICE_USD_E8");
        bool skipVenue = vm.envOr("REPRICE_SKIP_VENUE", false);
        bool allowIlliquid = vm.envOr("REPRICE_ALLOW_ILLIQUID", false);
        uint256 ownerKey = vm.envOr("MOCK_OWNER_PRIVATE_KEY", uint256(0));
        address sender = ownerKey == 0 ? msg.sender : vm.addr(ownerKey);

        RepriceTarget memory t = _resolveTarget(assetKey);
        _preflight(t, sender, skipVenue);

        PriceReading memory before = _read(t);
        uint160 newSpot = _targetSpot(t, newPrice8);

        console.log("=== Reprice testnet faucet asset ===");
        console.log("Chain id:     ", cid);
        console.log("Asset key:    ", assetKey);
        console.log("Asset:        ", t.asset);
        console.log("Broadcaster:  ", sender);
        console.log("Price (e8):    %s -> %s", before.oraclePrice, newPrice8);
        console.log("Pool spot:     %s -> %s", uint256(before.poolSpot), uint256(newSpot));
        console.log("Venue (e8):    %s -> %s", before.venuePrice8, skipVenue ? before.venuePrice8 : newPrice8);
        console.log("Liquidity:     %s (0 = Liquid, 1 = Illiquid)", uint256(before.liquidity));

        if (ownerKey == 0) vm.startBroadcast();
        else vm.startBroadcast(ownerKey);
        _applyReprice(t, newPrice8, newSpot, skipVenue);
        vm.stopBroadcast();

        PriceReading memory afterReading = _verifyReprice(t, newPrice8, before, skipVenue, allowIlliquid);
        console.log("Liquidity now: %s (0 = Liquid, 1 = Illiquid)", uint256(afterReading.liquidity));
        if (skipVenue) {
            console.log("REPRICE_SKIP_VENUE: the venue still pays at e8 price", afterReading.venuePrice8);
        }
    }

    /// @notice Resolve every address from this chain's deployment artifact.
    /// @dev    Only the two faucet liquid tokens are accepted by NAME, so a
    ///         typo cannot point the script at an arbitrary artifact key.
    function _resolveTarget(string memory assetKey) internal view returns (RepriceTarget memory t) {
        bytes32 k = keccak256(bytes(assetKey));
        require(
            k == keccak256("liquidToken") || k == keccak256("liquidToken2"),
            "RepriceTestnetMock: REPRICE_ASSET must be liquidToken (tLIQ) or liquidToken2 (mUSDC)"
        );
        string memory base = string.concat(".testnetMocks.", assetKey);
        t.diamond = Deployments.readDiamond();
        t.asset = _required(base, "");
        t.feed = _required(base, "UsdFeed");
        t.pool = _required(base, "WethPool");
        t.venue = _required(".testnetMocks.mockSwapAdapter", "");
        t.registry = _required(".testnetMocks.feedRegistry", "");
        t.factory = _required(".testnetMocks.uniswapV3Factory", "");
        t.quote = Deployments.readWethOptional();
        require(t.quote != address(0), "RepriceTestnetMock: artifact has no .weth");
    }

    /// @notice Every check that needs no state change. Reverts with the
    ///         first one that fails, naming it.
    function _preflight(RepriceTarget memory t, address sender, bool skipVenue) internal view {
        require(t.diamond.code.length != 0, "RepriceTestnetMock: no code at the Diamond");
        require(t.feed.code.length != 0, "RepriceTestnetMock: no code at the recorded feed");
        require(t.pool.code.length != 0, "RepriceTestnetMock: no code at the recorded pool");

        // The artifact must still describe the chain (#2313 is a live case
        // of a committed artifact that does not).
        require(
            MockUniswapV3Factory(t.factory).getPool(t.asset, t.quote, REPRICE_POOL_FEE) == t.pool,
            "RepriceTestnetMock: recorded pool is not the factory's live asset/WETH pool"
        );
        require(
            MockChainlinkRegistry(t.registry).getFeed(t.asset, REPRICE_USD_DENOM) == t.feed,
            "RepriceTestnetMock: recorded feed is not the registry's live asset/USD feed"
        );
        require(
            MockChainlinkRegistry(t.registry).getFeed(t.quote, REPRICE_USD_DENOM) != t.feed,
            "RepriceTestnetMock: the asset shares its feed with WETH - repricing it moves every pool's quote leg"
        );

        require(
            MockChainlinkFeed(t.feed).decimals() == REPRICE_FEED_DECIMALS,
            "RepriceTestnetMock: feed is not 8-decimal"
        );
        require(
            IERC20Metadata(t.asset).decimals() == IERC20Metadata(t.quote).decimals(),
            "RepriceTestnetMock: asset and WETH differ in decimals - the pool math has no decimal term"
        );

        require(MockChainlinkFeed(t.feed).owner() == sender, "RepriceTestnetMock: broadcaster does not own the feed");
        require(MockUniswapV3Pool(t.pool).owner() == sender, "RepriceTestnetMock: broadcaster does not own the pool");
        if (!skipVenue) {
            require(t.venue.code.length != 0, "RepriceTestnetMock: no code at the recorded venue");
            require(MockSwapAdapter(t.venue).owner() == sender, "RepriceTestnetMock: broadcaster does not own the venue");
        }
    }

    /// @notice The pool spot that agrees with `newPrice8` against WETH's
    ///         price as the Diamond's oracle reads it.
    function _targetSpot(RepriceTarget memory t, uint256 newPrice8) internal view returns (uint160) {
        require(newPrice8 != 0, "RepriceTestnetMock: REPRICE_USD_E8 is zero");
        (uint256 quotePrice, uint8 quoteDecimals) = IOracleViews(t.diamond).getAssetPrice(t.quote);
        require(quotePrice != 0, "RepriceTestnetMock: the oracle reads no WETH price");
        require(quoteDecimals <= 18, "RepriceTestnetMock: WETH price has more than 18 decimals");
        // Bring both legs to one scale; the pool math is scale-free.
        uint256 assetPrice18 = newPrice8 * 10 ** (18 - REPRICE_FEED_DECIMALS);
        uint256 quotePrice18 = quotePrice * 10 ** (18 - quoteDecimals);
        return MockPoolPricing.sqrtPriceX96(t.asset, assetPrice18, t.quote, quotePrice18);
    }

    /// @notice The writes — and nothing else, so a test can drive them under
    ///         a prank exactly as the broadcast sends them.
    function _applyReprice(RepriceTarget memory t, uint256 newPrice8, uint160 newSpot, bool skipVenue) internal {
        MockChainlinkFeed(t.feed).setPrice(SafeCast.toInt256(newPrice8));
        MockUniswapV3Pool(t.pool).setSqrtPriceX96(newSpot);
        if (!skipVenue) MockSwapAdapter(t.venue).setTokenPrice(t.asset, newPrice8);
    }

    /// @notice Check the simulated result against what a reprice must
    ///         produce, and return the reading.
    function _verifyReprice(
        RepriceTarget memory t,
        uint256 newPrice8,
        PriceReading memory before,
        bool skipVenue,
        bool allowIlliquid
    ) internal view returns (PriceReading memory r) {
        r = _read(t);
        require(r.oracleDecimals <= 18, "RepriceTestnetMock: oracle price has more than 18 decimals");
        require(
            r.oraclePrice * 10 ** (18 - r.oracleDecimals) == newPrice8 * 10 ** (18 - REPRICE_FEED_DECIMALS),
            "RepriceTestnetMock: the Diamond does not read the new price - is it wired to this registry?"
        );
        if (!skipVenue) {
            require(r.venuePrice8 == newPrice8, "RepriceTestnetMock: venue price did not move");
        }
        if (before.liquidity == 0 && r.liquidity != 0 && !allowIlliquid) {
            revert(
                "RepriceTestnetMock: the asset reads Illiquid after a coherent reprice - a depth or band limit, not a rehearsal state; set REPRICE_ALLOW_ILLIQUID=true to proceed"
            );
        }
    }

    function _read(RepriceTarget memory t) internal view returns (PriceReading memory r) {
        (r.oraclePrice, r.oracleDecimals) = IOracleViews(t.diamond).getAssetPrice(t.asset);
        r.liquidity = IOracleViews(t.diamond).checkLiquidity(t.asset);
        r.poolSpot = MockUniswapV3Pool(t.pool).sqrtPriceX96();
        if (t.venue.code.length != 0) r.venuePrice8 = MockSwapAdapter(t.venue).tokenUsdPrice8(t.asset);
    }

    /// @dev Artifact-only read. `Deployments.readAddress` falls back to a
    ///      chain-prefixed env var, which has no meaning for these keys and
    ///      would turn a missing key into an opaque env error.
    function _required(string memory key, string memory suffix) private view returns (address a) {
        string memory full = string.concat(key, suffix);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(Deployments.path());
        try vm.parseJsonAddress(json, full) returns (address v) {
            a = v;
        } catch {}
        require(a != address(0), string.concat("RepriceTestnetMock: artifact has no ", full));
    }
}
