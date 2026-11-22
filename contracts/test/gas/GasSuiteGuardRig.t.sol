// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {PriceGuardDeployment} from "../../script/lib/PriceGuardDeployment.sol";
import {IFeedRegistryPairBase} from "../../src/interfaces/IFeedRegistryPairBase.sol";
import {ITellor} from "../../src/interfaces/ITellor.sol";
import {IApi3ServerV1} from "../../src/interfaces/IApi3ServerV1.sol";
import {IDIAOracleV2} from "../../src/interfaces/IDIAOracleV2.sol";
import {IPyth} from "../../src/interfaces/IPyth.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {PriceGuardState} from "../../src/oracle/PriceGuardState.sol";

/**
 * @title  GasSuiteGuardRig
 * @notice The cost of one price-guard read against a fully set-up,
 *         mainnet-shaped guard (#3915; design re-ruling 2026-11-22, instant
 *         borrow source cap). The gas suite answers the guard with mocks, so
 *         its figures leave out what a read costs on a network. This rig
 *         builds the real `PriceGuard` with every source the mainnet guard
 *         reads set and live (the feed registry, WETH, the ETH/USD anchor,
 *         the sequencer feed, Pyth and the three secondary sources), all
 *         answering fresh and in agreement, so every check runs to the end.
 *
 *         For each read the Diamond makes, and for WETH, an asset with a
 *         direct USD feed and an asset priced through ETH, it records the
 *         read's gas as its own transaction (the guard's own code, cold) and
 *         how many calls the read makes to each outside source. The sources
 *         are answered by mocks here, so `check-gas-budgets.mjs` adds each
 *         source's cold read cost, measured on live networks
 *         (test/fork/GuardSourceReadCostFork.t.sol, recorded in
 *         budgets.json), per call. The worst read is the figure the source
 *         rule counts per guard read.
 *
 *         Output: one file per read in `out-gas-suite/config/guard-rig/`.
 *
 * forge-config: default.isolate = true
 */
contract GasSuiteGuardRig is Test {
    string internal constant OUT_DIR = "./out-gas-suite/config/guard-rig/";

    address internal registry = _sentinel("registry");
    address internal usd = _sentinel("usd");
    address internal ethDenom = _sentinel("ethDenom");
    address internal weth = _sentinel("weth");
    address internal ethUsdFeed = _sentinel("ethUsdFeed");
    address internal assetDirect = _sentinel("assetDirect");
    address internal assetPivot = _sentinel("assetPivot");
    address internal directFeed = _sentinel("directFeed");
    address internal pivotFeed = _sentinel("pivotFeed");
    address internal tellor = _sentinel("tellor");
    address internal api3 = _sentinel("api3");
    address internal dia = _sentinel("dia");
    address internal pyth = _sentinel("pyth");
    address internal sequencer = _sentinel("sequencer");
    bytes32 internal constant PYTH_ID = keccak256("ETH/USD");

    IPriceGuard internal guard;

    /// @dev Source kinds, as named in budgets.json `guardSourceCosts`.
    string[7] internal KINDS = ["chainlinkFeed", "feedRegistry", "sequencer", "pyth", "tellor", "api3", "dia"];

    function setUp() public {
        vm.warp(30 days);
        PriceGuardState.Identity memory id;
        id.numeraireSymbol = bytes32("usd");
        id.ethDenominator = ethDenom;
        id.numeraireDenominator = usd;
        PriceGuardState.Change[] memory c = new PriceGuardState.Change[](11);
        c[0] = _change(PriceGuardState.Kind.FeedRegistry, 0, registry);
        c[1] = _change(PriceGuardState.Kind.Weth, 0, weth);
        c[2] = _change(PriceGuardState.Kind.SecondarySource, 0, tellor);
        c[3] = _change(PriceGuardState.Kind.SecondarySource, 1, api3);
        c[4] = _change(PriceGuardState.Kind.SecondarySource, 2, dia);
        c[5] = PriceGuardState.Change(PriceGuardState.Kind.SecondaryMaxDeviationBps, bytes32(0), bytes32(uint256(500)));
        c[6] = PriceGuardState.Change(PriceGuardState.Kind.SecondaryMaxStaleness, bytes32(0), bytes32(uint256(2 hours)));
        c[7] = _change(PriceGuardState.Kind.PythOracle, 0, pyth);
        c[8] = PriceGuardState.Change(PriceGuardState.Kind.PythFeedId, bytes32(0), PYTH_ID);
        c[9] = _change(PriceGuardState.Kind.SequencerFeed, 0, sequencer);
        c[10] = _change(PriceGuardState.Kind.EthNumeraireFeed, 0, ethUsdFeed);
        guard = IPriceGuard(PriceGuardDeployment.build(address(this), address(this), id, uint64(0), c));

        // Every source fresh and in agreement: ETH 2,000 USD, the direct asset
        // 15 USD, the pivot asset 0.004 ETH (8 USD).
        _feed(ethUsdFeed, 2_000e8, 8);
        _feed(directFeed, 15e8, 8);
        _feed(pivotFeed, 0.004e18, 18);
        vm.mockCall(registry, abi.encodeWithSignature("getFeed(address,address)", assetDirect, usd), abi.encode(directFeed));
        vm.mockCall(registry, abi.encodeCall(IFeedRegistryPairBase.pairBase, (assetDirect, usd)), abi.encode(bytes32("LINK")));
        // The pivot asset has no USD feed: the registry refuses, as Chainlink's does.
        vm.mockCallRevert(registry, abi.encodeWithSignature("getFeed(address,address)", assetPivot, usd), "Feed not found");
        vm.mockCall(registry, abi.encodeWithSignature("getFeed(address,address)", assetPivot, ethDenom), abi.encode(pivotFeed));
        vm.mockCall(registry, abi.encodeCall(IFeedRegistryPairBase.pairBase, (assetPivot, ethDenom)), abi.encode(bytes32("UNI")));
        _secondaries();
        vm.mockCall(
            pyth,
            abi.encodeCall(IPyth.getPriceUnsafe, (PYTH_ID)),
            abi.encode(IPyth.Price(2_000e8, 1e5, -8, block.timestamp - 30))
        );
        vm.mockCall(
            sequencer,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), int256(0), block.timestamp - 2 days, block.timestamp - 2 days, uint80(1))
        );
    }

    /// @dev One test per read: `vm.expectCall` counts over a whole test, and
    ///      each test's call is its own transaction. Forge leaves a mocked
    ///      call that succeeds out of the state diff, so each read's calls to
    ///      the outside sources are stated per asset and asserted with
    ///      `vm.expectCall` (an exact count): a guard that changes how often it
    ///      asks a source fails here rather than going uncounted.
    function test_gas_guard_rig_price_weth() public { _price(0, 0); }
    function test_gas_guard_rig_status_weth() public { _price(0, 1); }
    function test_gas_guard_rig_try_weth() public { _price(0, 2); }
    function test_gas_guard_rig_live_weth() public { _price(0, 3); }
    function test_gas_guard_rig_price_direct() public { _price(1, 0); }
    function test_gas_guard_rig_status_direct() public { _price(1, 1); }
    function test_gas_guard_rig_try_direct() public { _price(1, 2); }
    function test_gas_guard_rig_live_direct() public { _price(1, 3); }
    function test_gas_guard_rig_price_pivot() public { _price(2, 0); }
    function test_gas_guard_rig_status_pivot() public { _price(2, 1); }
    function test_gas_guard_rig_try_pivot() public { _price(2, 2); }
    function test_gas_guard_rig_live_pivot() public { _price(2, 3); }

    function test_gas_guard_rig_sequencer() public {
        uint256[7] memory k;
        k[2] = 1;
        vm.expectCall(sequencer, abi.encodeWithSignature("latestRoundData()"), 1);
        _record("sequencerHealthy()", abi.encodeCall(IPriceGuard.sequencerHealthy, ()), k);
    }

    function _price(uint256 asset, uint256 f) internal {
        address a = [weth, assetDirect, assetPivot][asset];
        string memory name = ["weth", "direct", "pivot"][asset];
        bytes memory data = [
            abi.encodeCall(IPriceGuard.getAssetPrice, (a)),
            abi.encodeCall(IPriceGuard.getAssetPriceStatus, (a)),
            abi.encodeCall(IPriceGuard.tryGetAssetPrice, (a)),
            abi.encodeCall(IPriceGuard.countLiveSecondaryOracleFeeds, (a))
        ][f];
        string memory fn = ["getAssetPrice", "getAssetPriceStatus", "tryGetAssetPrice", "countLiveSecondaryOracleFeeds"][f];
        uint256[7] memory k = _expectPriceRead(asset);
        _record(string.concat(fn, "(", name, ")"), data, k);
    }

    /// @dev The calls one price read makes, by asset (0 WETH, 1 the direct
    ///      asset, 2 the pivot asset), set as exact expectations and returned
    ///      in {KINDS} order. Every read asks the sequencer and the three
    ///      secondaries once. WETH reads the ETH/USD anchor and checks it
    ///      against Pyth. The direct asset asks the registry for its feed and
    ///      its symbol. The pivot asset asks the registry under USD (refused)
    ///      and then ETH, reads its ETH feed and the anchor, and checks the
    ///      anchor against Pyth.
    function _expectPriceRead(uint256 asset) internal returns (uint256[7] memory k) {
        k[2] = 1;
        k[4] = 1;
        k[5] = 1;
        k[6] = 1;
        if (asset == 0) {
            _expectFeed(ethUsdFeed);
            k[0] = 2;
            k[3] = 1;
        } else if (asset == 1) {
            _expectFeed(directFeed);
            k[0] = 2;
            k[1] = 2;
            vm.expectCall(registry, abi.encodeWithSignature("getFeed(address,address)"), 1);
            vm.expectCall(registry, abi.encodeWithSelector(IFeedRegistryPairBase.pairBase.selector), 1);
        } else {
            _expectFeed(pivotFeed);
            _expectFeed(ethUsdFeed);
            k[0] = 4;
            k[1] = 4;
            k[3] = 1;
            vm.expectCall(registry, abi.encodeWithSignature("getFeed(address,address)"), 2);
            vm.expectCall(registry, abi.encodeWithSelector(IFeedRegistryPairBase.pairBase.selector), 2);
        }
        vm.expectCall(sequencer, abi.encodeWithSignature("latestRoundData()"), 1);
        vm.expectCall(pyth, abi.encodeWithSelector(IPyth.getPriceUnsafe.selector), uint64(k[3]));
        vm.expectCall(tellor, abi.encodeWithSelector(ITellor.getDataBefore.selector), 1);
        vm.expectCall(api3, abi.encodeWithSelector(IApi3ServerV1.readDataFeedWithDapiNameHash.selector), 1);
        vm.expectCall(dia, abi.encodeWithSelector(IDIAOracleV2.getValue.selector), 1);
    }

    function _expectFeed(address feed) internal {
        vm.expectCall(feed, abi.encodeWithSignature("decimals()"), 1);
        vm.expectCall(feed, abi.encodeWithSignature("latestRoundData()"), 1);
    }

    /// @dev Measures one read and writes its record to its own file, so
    ///      tests running in parallel never write the same one. The figure is
    ///      the call's gas as forge reports it, taken whole (a read made from
    ///      the Diamond pays no transaction base, so this errs high).
    function _record(string memory name, bytes memory data, uint256[7] memory k) internal {
        (bool ok, bytes memory ret) = address(guard).staticcall(data);
        uint256 gas = vm.lastCallGas().gasTotalUsed;
        require(ok, string(ret));
        string memory o = name;
        string memory calls;
        for (uint256 i; i < KINDS.length; ++i) calls = vm.serializeUint(string.concat(name, ".calls"), KINDS[i], k[i]);
        vm.serializeString(o, "read", name);
        vm.serializeUint(o, "gas", gas);
        string memory json = vm.serializeString(o, "sourceCalls", calls);
        vm.createDir(OUT_DIR, true);
        vm.writeJson(json, string.concat(OUT_DIR, name, ".json"));
    }

    function _secondaries() internal {
        _secondary("eth", "ETH", 2_000);
        _secondary("link", "LINK", 15);
        _secondary("uni", "UNI", 8);
    }

    function _secondary(string memory lower, string memory upper, uint256 usdPrice) internal {
        uint256 at = block.timestamp - 60;
        bytes32 queryId = keccak256(abi.encode("SpotPrice", abi.encode(lower, "usd")));
        vm.mockCall(
            tellor, abi.encodePacked(ITellor.getDataBefore.selector, queryId), abi.encode(abi.encode(usdPrice * 1e18), at)
        );
        string memory pair = string.concat(upper, "/USD");
        bytes32 dapiName = bytes32(bytes(pair));
        vm.mockCall(
            api3,
            abi.encodeCall(IApi3ServerV1.readDataFeedWithDapiNameHash, (keccak256(abi.encodePacked(dapiName)))),
            abi.encode(int224(int256(usdPrice * 1e18)), uint32(at))
        );
        vm.mockCall(dia, abi.encodeCall(IDIAOracleV2.getValue, (pair)), abi.encode(uint128(usdPrice * 1e8), uint128(at)));
    }

    function _feed(address feed, int256 answer, uint8 dec) internal {
        uint256 t = block.timestamp - 60;
        vm.mockCall(feed, abi.encodeWithSignature("decimals()"), abi.encode(dec));
        vm.mockCall(
            feed, abi.encodeWithSignature("latestRoundData()"), abi.encode(uint80(5), answer, t, t, uint80(5))
        );
    }

    function _sentinel(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.etch(a, hex"00");
    }

    function _change(PriceGuardState.Kind kind, uint256 subject, address value)
        internal
        pure
        returns (PriceGuardState.Change memory)
    {
        return PriceGuardState.Change(kind, bytes32(subject), bytes32(uint256(uint160(value))));
    }
}
