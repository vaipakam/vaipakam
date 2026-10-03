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
import {RepriceVenueReport, IRepriceDiamondViews} from "./lib/RepriceVenueReport.sol";


/**
 * @title RepriceTestnetMock
 * @notice Reprice a testnet faucet asset the way a real market moves: its
 *         mock Chainlink feed, the spot of its mock v3 `asset/WETH` pool,
 *         and (by default) its price on the registered mock swap venue — in
 *         one run (#2314).
 *
 *         **One run is THREE transactions, and they are not atomic.** Each
 *         mock is gated to an immutable owner EOA, so no batching contract
 *         can make the three calls as that owner. Between the transactions,
 *         an observer can see the feed moved while the pool has not (the
 *         asset reads Illiquid for those blocks) or the venue still at the
 *         old price. If a send fails part-way, the testnet is left partially
 *         repriced. **Recovery is to re-run the same command**: every write
 *         is a plain set to the target value, so a re-run completes whatever
 *         did not land and ends in the same state as an uninterrupted run —
 *         Liquid, so the Illiquid guard below does not stand in its way.
 *         Broadcast with
 *         `--slow` so forge waits for each receipt and stops at the first
 *         failure rather than queueing the rest.
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
 *           - a broadcaster that does not own the feed, the pool and the
 *             venue — each is owner-gated so a public testnet's demos cannot
 *             be repriced by a passer-by;
 *           - a recorded venue the Diamond does not route
 *             liquidations through: it must be in `getSwapAdapters()` and not
 *             disabled. Repricing a different adapter would leave the one the
 *             Diamond actually uses at the old price;
 *           - a feed not at 8 decimals, or legs at different token decimals
 *             (the pool math has no decimal term).
 *
 *         And after applying the writes in simulation, before broadcast:
 *           - the Diamond must read the new price for the asset, and the venue
 *             must pay it;
 *           - the asset must read Liquid, whatever it read before the run. A
 *             coherent move that ends Illiquid is a depth, band or
 *             configuration limit worth seeing, not a rehearsal state to ship;
 *           - the recorded FEED must be what the Diamond reads: in simulation,
 *             set it to a different price and require the Diamond's price to
 *             follow, then restore. A price that merely EQUALS the target
 *             (a restore, a repeat run) is not proof of wiring;
 *           - the recorded POOL must be what the oracle routes through:
 *             zeroing its depth must flip the now-Liquid asset Illiquid, then
 *             restore. The Diamond exposes no view of its factory, registry or
 *             quote list, so both wirings are proved by behaviour. On the
 *             post-write state this also covers a recovery run that started
 *             Illiquid.
 *
 *         There are deliberately NO opt-outs. Earlier revisions had
 *         `REPRICE_SKIP_VENUE` and `REPRICE_ALLOW_ILLIQUID` for speculative
 *         "deliberate mismatch" tests nobody asked for; each review round
 *         found another way they let a weaker run through, so they were
 *         removed rather than patched (#2372).
 *
 *         Then it REPORTS, without refusing, the venue state it does not
 *         write: the execution knobs (`shouldRevert`,
 *         `outputMultiplierBps`, `restrictedTo`) and the venue's price for
 *         every faucet asset against the oracle's. Those decide what a
 *         liquidation actually pays against the repriced asset, and the
 *         script cannot fix them (mWETH/WETH cannot be repriced here). The
 *         run also states what it does not inspect: the venue's output float,
 *         and its price for any token outside the faucet set (which may be
 *         set by the owner or absent — the mapping is open). It never claims
 *         that a liquidation will settle correctly. An UNGATED venue
 *         (`restrictedTo == 0`) is reported too: the adapter is funded, so an
 *         open execute lets anyone drain its float.
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
 *                                      Unset or `0`, the script broadcasts as
 *                                      `--sender` — with `--unlocked` on an
 *                                      Anvil fork that has impersonated the
 *                                      owner, or with `--account` /
 *                                      `--ledger` on a real chain. A dedicated
 *                                      name, so Foundry's automatic `.env`
 *                                      load cannot pick an unrelated key.
 *                                      Forge loads `.env` itself, so for a
 *                                      `--sender` run set it to `0` on the
 *                                      command line (a value already in the
 *                                      environment wins over `.env`);
 *                                      unsetting it is not enough.
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
        uint256 ownerKey = vm.envOr("MOCK_OWNER_PRIVATE_KEY", uint256(0));
        address sender = ownerKey == 0 ? msg.sender : vm.addr(ownerKey);

        RepriceTarget memory t = _resolveTarget(assetKey);
        _preflight(t, sender);

        PriceReading memory before = _read(t);
        uint160 newSpot = _targetSpot(t, newPrice8);

        console.log("=== Reprice testnet faucet asset ===");
        console.log("Chain id:     ", cid);
        console.log("Asset key:    ", assetKey);
        console.log("Asset:        ", t.asset);
        console.log("Broadcaster:  ", sender);
        console.log("Price (e8):    %s -> %s", before.oraclePrice, newPrice8);
        console.log("Pool spot:     %s -> %s", uint256(before.poolSpot), uint256(newSpot));
        console.log("Venue (e8):    %s -> %s", before.venuePrice8, newPrice8);
        console.log("Liquidity:     %s (0 = Liquid, 1 = Illiquid)", uint256(before.liquidity));

        console.log("Sends 3 transactions; not atomic - re-run to finish a partial run.");

        if (ownerKey == 0) vm.startBroadcast();
        else vm.startBroadcast(ownerKey);
        _applyReprice(t, newPrice8, newSpot);
        vm.stopBroadcast();

        PriceReading memory afterReading = _verifyReprice(t, newPrice8);
        console.log("Liquidity now: %s (0 = Liquid, 1 = Illiquid)", uint256(afterReading.liquidity));

        // Both wiring proofs run on the POST-write state, where the asset
        // must read Liquid (verify just required it) — so they also cover a
        // recovery run that started Illiquid. Still simulation only: this is
        // after stopBroadcast, and each probe restores its snapshot. A refusal
        // here sends nothing, because forge broadcasts only a simulation that
        // completed.
        _requireRecordedFeedIsWhatTheDiamondReads(t, newPrice8);
        _requireRecordedPoolIsTheRoute(t);

        // The venue's settlement depends on state this run does not write.
        // Report all of it that is knowable, and say what is not.
        {
            // The report reads state this run neither writes nor controls, so
            // it must never be what stops a run: it lives in its own contract,
            // deployed here in simulation (after stopBroadcast, so nothing is
            // sent), and any read that fails inside it is caught as ONE stated
            // outcome rather than each new shape needing its own guard. The
            // writes have already been checked by _verifyReprice above.
            RepriceVenueReport reporter = new RepriceVenueReport();
            try reporter.report(t.diamond, t.venue, t.asset, _faucetPricedAssets(t)) returns (
                string[] memory deviations
            ) {
                console.log("Venue report (state this run does not write): %s deviation(s)", deviations.length);
                for (uint256 i; i < deviations.length; ++i) {
                    console.log(string.concat("WARNING: ", deviations[i]));
                }
            } catch {
                console.log(
                    "WARNING: venue report unavailable - a read of the venue or a faucet token failed, so its settlement state is not substantiated"
                );
            }
        }
        console.log(
            "Not checked: the venue's output-token float, and its price for any token outside the faucet set. A liquidation can still fail on a short float; an outside token may carry a venue price its owner set, or none (a 1:1 base before the multiplier), and this run does not inspect it."
        );
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
    function _preflight(RepriceTarget memory t, address sender) internal view {
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
        require(t.venue.code.length != 0, "RepriceTestnetMock: no code at the recorded venue");
        require(_isRoutedVenue(t), "RepriceTestnetMock: recorded venue is not in the Diamond's live adapter list");
        require(
            !IRepriceDiamondViews(t.diamond).isSwapAdapterDisabled(t.venue),
            "RepriceTestnetMock: recorded venue is registered but disabled on the Diamond"
        );
        require(MockSwapAdapter(t.venue).owner() == sender, "RepriceTestnetMock: broadcaster does not own the venue");
    }

    /// @notice The pool spot that agrees with `newPrice8` against WETH's
    ///         price as the Diamond's oracle reads it.
    function _targetSpot(RepriceTarget memory t, uint256 newPrice8) internal view returns (uint160) {
        require(newPrice8 != 0, "RepriceTestnetMock: REPRICE_USD_E8 is zero");
        (uint256 quotePrice, uint8 quoteDecimals) = IRepriceDiamondViews(t.diamond).getAssetPrice(t.quote);
        require(quotePrice != 0, "RepriceTestnetMock: the oracle reads no WETH price");
        require(quoteDecimals <= 18, "RepriceTestnetMock: WETH price has more than 18 decimals");
        // Bring both legs to one scale; the pool math is scale-free.
        uint256 assetPrice18 = newPrice8 * 10 ** (18 - REPRICE_FEED_DECIMALS);
        uint256 quotePrice18 = quotePrice * 10 ** (18 - quoteDecimals);
        return MockPoolPricing.sqrtPriceX96(t.asset, assetPrice18, t.quote, quotePrice18);
    }

    /// @notice The writes — and nothing else, so a test can drive them under
    ///         a prank exactly as the broadcast sends them.
    function _applyReprice(RepriceTarget memory t, uint256 newPrice8, uint160 newSpot) internal {
        MockChainlinkFeed(t.feed).setPrice(SafeCast.toInt256(newPrice8));
        MockUniswapV3Pool(t.pool).setSqrtPriceX96(newSpot);
        MockSwapAdapter(t.venue).setTokenPrice(t.asset, newPrice8);
    }

    /// @notice Check the simulated result against what a reprice must
    ///         produce, and return the reading.
    function _verifyReprice(RepriceTarget memory t, uint256 newPrice8)
        internal
        view
        returns (PriceReading memory r)
    {
        r = _read(t);
        require(r.oracleDecimals <= 18, "RepriceTestnetMock: oracle price has more than 18 decimals");
        require(
            r.oraclePrice * 10 ** (18 - r.oracleDecimals) == newPrice8 * 10 ** (18 - REPRICE_FEED_DECIMALS),
            "RepriceTestnetMock: the Diamond does not read the new price - is it wired to this registry?"
        );
        require(r.venuePrice8 == newPrice8, "RepriceTestnetMock: venue price did not move");
        require(r.liquidity == 0, "RepriceTestnetMock: the asset reads Illiquid after a coherent reprice - a depth, band or configuration limit, not a rehearsal state");
    }

    /// @notice The faucet assets the venue is expected to price: the two
    ///         liquid tokens, mWETH where recorded, and the WETH quote.
    function _faucetPricedAssets(RepriceTarget memory t) internal view returns (address[] memory assets) {
        address[4] memory found = [
            _optional(".testnetMocks.liquidToken"),
            _optional(".testnetMocks.liquidToken2"),
            _optional(".testnetMocks.mWeth"),
            t.quote
        ];
        uint256 n;
        for (uint256 i; i < found.length; ++i) {
            if (found[i] != address(0)) ++n;
        }
        assets = new address[](n);
        n = 0;
        for (uint256 i; i < found.length; ++i) {
            if (found[i] != address(0)) assets[n++] = found[i];
        }
    }

    /// @notice Prove, by behaviour, that the recorded feed is what the
    ///         Diamond prices the asset from.
    /// @dev    The post-write price check passes whenever the Diamond's price
    ///         EQUALS the target — which a stale record can satisfy by
    ///         coincidence (a restore, a repeat run) while the write landed on
    ///         an obsolete feed. So, in simulation only: snapshot, move the
    ///         recorded feed to a different price as its owner, require the
    ///         Diamond's price to follow, revert. Same shape as the pool probe.
    function _requireRecordedFeedIsWhatTheDiamondReads(RepriceTarget memory t, uint256 newPrice8) internal {
        uint256 probe8 = newPrice8 * 2;
        uint256 snap = vm.snapshotState();
        vm.prank(MockChainlinkFeed(t.feed).owner());
        MockChainlinkFeed(t.feed).setPrice(SafeCast.toInt256(probe8));
        (uint256 p, uint8 d) = IRepriceDiamondViews(t.diamond).getAssetPrice(t.asset);
        vm.revertToState(snap);
        require(
            d <= 18 && p * 10 ** (18 - d) == probe8 * 10 ** (18 - REPRICE_FEED_DECIMALS),
            "RepriceTestnetMock: the Diamond's price does not follow the recorded feed - it reads another feed"
        );
    }

    /// @notice Prove, by behaviour, that the recorded pool is what the
    ///         oracle's Liquid verdict for the asset depends on.
    /// @dev    The Diamond exposes no view of its V3 factory or quote list,
    ///         and the oracle routes over several factories, fee tiers and
    ///         quote assets, so the factory check in preflight only proves
    ///         the ARTIFACT's factory maps the pair to this pool. This
    ///         closes the gap the way the price check does for the feed:
    ///         in simulation only, snapshot, zero the pool's depth as its
    ///         owner, and require the asset to read Illiquid; then revert to
    ///         the snapshot. Nothing here is broadcast (`run()` calls it after
    ///         `stopBroadcast`, and the snapshot is restored).
    ///
    ///         It needs the asset to read Liquid to begin with — emptying a
    ///         pool cannot show a dependency of an asset already Illiquid —
    ///         so it refuses rather than passing silently in that state.
    ///         `run()` calls it on the post-write state, where a coherent move
    ///         must read Liquid, which also covers a recovery run that
    ///         started Illiquid.
    function _requireRecordedPoolIsTheRoute(RepriceTarget memory t) internal {
        require(
            IRepriceDiamondViews(t.diamond).checkLiquidity(t.asset) == 0,
            "RepriceTestnetMock: the route cannot be proved while the asset reads Illiquid"
        );
        uint256 snap = vm.snapshotState();
        vm.prank(MockUniswapV3Pool(t.pool).owner());
        MockUniswapV3Pool(t.pool).setLiquidity(0);
        uint8 withoutPool = IRepriceDiamondViews(t.diamond).checkLiquidity(t.asset);
        vm.revertToState(snap);
        require(
            withoutPool != 0,
            "RepriceTestnetMock: the asset stays Liquid without the recorded pool - the oracle routes elsewhere, so repricing this pool would not move what it reads"
        );
    }

    function _isRoutedVenue(RepriceTarget memory t) internal view returns (bool) {
        address[] memory adapters = IRepriceDiamondViews(t.diamond).getSwapAdapters();
        for (uint256 i; i < adapters.length; ++i) {
            if (adapters[i] == t.venue) return true;
        }
        return false;
    }

    function _read(RepriceTarget memory t) internal view returns (PriceReading memory r) {
        (r.oraclePrice, r.oracleDecimals) = IRepriceDiamondViews(t.diamond).getAssetPrice(t.asset);
        r.liquidity = IRepriceDiamondViews(t.diamond).checkLiquidity(t.asset);
        r.poolSpot = MockUniswapV3Pool(t.pool).sqrtPriceX96();
        if (t.venue.code.length != 0) r.venuePrice8 = MockSwapAdapter(t.venue).tokenUsdPrice8(t.asset);
    }

    function _optional(string memory key) private view returns (address a) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(Deployments.path());
        try vm.parseJsonAddress(json, key) returns (address v) {
            a = v;
        } catch {}
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
