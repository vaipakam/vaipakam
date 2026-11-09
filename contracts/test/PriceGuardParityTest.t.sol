// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {MockProtocolRegistry} from "./mocks/MockProtocolRegistry.sol";
import {RegistryKeys} from "../src/governance/RegistryKeys.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {HelperTest} from "./HelperTest.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {IFeedRegistryPairBase} from "../src/interfaces/IFeedRegistryPairBase.sol";
import {ITellor} from "../src/interfaces/ITellor.sol";
import {IApi3ServerV1} from "../src/interfaces/IApi3ServerV1.sol";
import {IDIAOracleV2} from "../src/interfaces/IDIAOracleV2.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";

/**
 * @title  PriceGuardParityTest
 * @notice #3272: the Diamond's prices are its guard's. Step 1 used this suite
 *         to show the guard ran the Diamond's own pricing path unchanged;
 *         part 2 retired that path, so the same worlds now show the
 *         forwarding is exact. Each run arranges one world of feeds,
 *         secondary sources, Pyth and sequencer answers, builds a guard for
 *         it and a Diamond that names that guard, and requires both to give
 *         the same answer for every asset: the same status, price and
 *         decimals, and byte-identical revert data from the reverting read.
 * @dev    Every external source is a sentinel address with code etched (the
 *         guard refuses a config address without code) whose replies are
 *         `vm.mockCall`s.
 */
contract PriceGuardParityTest is Test {
    VaipakamDiamond internal diamond;
    HelperTest internal helper;

    address internal registry = _sentinel("registry");
    address internal usd = _sentinel("usd");
    address internal eur = _sentinel("eur");
    address internal ethDenom = _sentinel("ethDenom");
    address internal weth = _sentinel("weth");
    address internal ethUsdFeed = _sentinel("ethUsdFeed");
    address internal ethEurFeed = _sentinel("ethEurFeed");
    address internal usdEurFeed = _sentinel("usdEurFeed");
    address internal assetDirect = _sentinel("assetDirect");
    address internal assetPivot = _sentinel("assetPivot");
    address internal assetNone = _sentinel("assetNone");
    address internal assetOverride = _sentinel("assetOverride");
    address internal directFeed = _sentinel("directFeed");
    address internal pivotFeed = _sentinel("pivotFeed");
    address internal overrideFeed = _sentinel("overrideFeed");
    address internal eurRefFeed = _sentinel("eurRefFeed");
    address internal tellor = _sentinel("tellor");
    address internal api3 = _sentinel("api3");
    address internal dia = _sentinel("dia");
    address internal pyth = _sentinel("pyth");
    address internal sequencer = _sentinel("sequencer");
    bytes32 internal constant PYTH_ID = keccak256("ETH/USD");

    /// @dev One world. Every field is fuzzed; enums are taken modulo their size.
    struct World {
        bool industrial;
        bool padRateDirect;
        Feed anchor; // ETH/USD (retail) or ETH/USD-as-PAD (industrial)
        Feed numer; // ETH/EUR (industrial)
        Feed padRate; // USD/EUR direct (industrial)
        Feed direct;
        Feed pivot;
        Feed overrideF;
        Feed eurRef;
        bool eurRefSet;
        uint8[3] secondaryMode; // 0 empty reply, 1 revert, 2 stale, 3 value, 4 zero, 5 echo of the direct feed
        uint256[3] secondaryValue;
        uint32[3] secondaryAge;
        uint8 pythMode; // 0 unset, 1 revert, 2 value
        int64 pythPrice;
        uint64 pythConf;
        int32 pythExpo;
        uint32 pythAge;
        uint8 seqMode; // 0 unset, 1 up, 2 down, 3 in grace
        uint40 overrideStaleness;
        int256 overrideMinAnswer;
        bool overrideOnDirect;
        uint16 secDevBps;
        uint40 secStaleness;
    }

    struct Feed {
        int256 answer;
        uint32 age;
        bool dec18;
        bool mismatch;
    }

    function setUp() public {
        vm.warp(30 days);
        helper = new HelperTest();
        DiamondCutFacet cut = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond = new VaipakamDiamond(address(this), address(cut));
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](5);
        cuts[0] = _cut(ArtifactDeploy.deploy(type(OracleFacet).name), helper.getOracleFacetSelectors());
        cuts[1] = _cut(ArtifactDeploy.deploy(type(AdminFacet).name), helper.getAdminFacetSelectors());
        cuts[2] =
            _cut(ArtifactDeploy.deploy(type(AccessControlFacet).name), helper.getAccessControlFacetSelectors());
        cuts[3] = _cut(ArtifactDeploy.deploy(type(OracleAdminFacet).name), helper.getOracleAdminFacetSelectors());
        cuts[4] =
            _cut(ArtifactDeploy.deploy(type(NumeraireConfigFacet).name), helper.getNumeraireConfigFacetSelectors());
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
    }

    // ─── The differential runs ───────────────────────────────────────────

    function testFuzz_GuardMatchesTheDiamond(World memory w) public {
        _normalise(w);
        PriceGuard guard = _configure(w);
        _arrange(w);
        address[5] memory assets = [weth, assetDirect, assetPivot, assetNone, assetOverride];
        for (uint256 i; i < assets.length; ++i) _assertSame(guard, assets[i]);
        assertEq(guard.sequencerHealthy(), OracleFacet(address(diamond)).sequencerHealthy(), "sequencerHealthy");
    }

    /// @dev Hand-picked worlds the fuzzer may rarely reach: every source agreeing,
    ///      every one disagreeing, Pyth diverging, the sequencer in grace.
    function test_GuardMatchesTheDiamondOnNamedWorlds() public {
        for (uint256 k; k < 6; ++k) {
            uint256 snap = vm.snapshotState();
            World memory w = _freshWorld();
            if (k == 1) w.secondaryMode = [uint8(3), 3, 3];
            if (k == 2) {
                w.secondaryMode = [uint8(3), 3, 3];
                w.secondaryValue = [uint256(9_000e18), 9_000e18, 9_000e8];
            }
            if (k == 3) {
                w.pythMode = 2;
                w.pythPrice = 3_000e8;
            }
            if (k == 4) w.seqMode = 3;
            if (k == 5) {
                w.industrial = true;
                w.padRateDirect = k % 2 == 1;
            }
            _normalise(w);
            PriceGuard guard = _configure(w);
            _arrange(w);
            address[5] memory assets = [weth, assetDirect, assetPivot, assetNone, assetOverride];
            for (uint256 i; i < assets.length; ++i) _assertSame(guard, assets[i]);
            vm.revertToState(snap);
        }
    }

    /// @dev The differential is only evidence if it reaches every outcome.
    ///      Seeded worlds, compared the same way, must land the direct-feed
    ///      asset on each of Priced, Unavailable and Divergent.
    function test_GuardMatchesTheDiamondAcrossSeededWorlds() public {
        uint256[3] memory seen;
        for (uint256 seed; seed < 200; ++seed) {
            uint256 snap = vm.snapshotState();
            World memory w = _seeded(seed);
            _normalise(w);
            // One world in three is a quorum world: no Pyth and no sequencer
            // to stop the read first, and every secondary an echo of the
            // direct feed, so the secondary tolerance alone decides. Without
            // it a seeded world rarely reaches the quorum at all.
            if (seed % 3 == 0) {
                w.pythMode = 0;
                w.seqMode = seed % 2 == 0 ? 0 : 1;
                w.secondaryMode = [uint8(5), 5, 5];
            }
            PriceGuard guard = _configure(w);
            _arrange(w);
            address[5] memory assets = [weth, assetDirect, assetPivot, assetNone, assetOverride];
            for (uint256 i; i < assets.length; ++i) _assertSame(guard, assets[i]);
            (IPriceGuard.PriceStatus st,,) = guard.getAssetPriceStatus(assetDirect);
            seen[uint8(st)]++;
            vm.revertToState(snap);
        }
        assertGt(seen[0], 10, "Priced reached");
        assertGt(seen[1], 10, "Unavailable reached");
        assertGt(seen[2], 10, "Divergent reached");
    }

    function _seeded(uint256 seed) internal pure returns (World memory w) {
        uint256 n;
        w.industrial = _r(seed, n++) % 3 == 0;
        w.padRateDirect = _r(seed, n++) % 2 == 0;
        w.anchor = _seedFeed(seed, n);
        n += 4;
        w.numer = _seedFeed(seed, n);
        n += 4;
        w.padRate = _seedFeed(seed, n);
        n += 4;
        w.direct = _seedFeed(seed, n);
        n += 4;
        w.pivot = _seedFeed(seed, n);
        n += 4;
        w.overrideF = _seedFeed(seed, n);
        n += 4;
        w.eurRef = _seedFeed(seed, n);
        n += 4;
        w.eurRefSet = _r(seed, n++) % 2 == 0;
        for (uint256 i; i < 3; ++i) {
            w.secondaryMode[i] = uint8(_r(seed, n++));
            w.secondaryValue[i] = _r(seed, n++);
            w.secondaryAge[i] = uint32(_r(seed, n++));
        }
        w.pythMode = uint8(_r(seed, n++));
        w.pythPrice = int64(int256(_r(seed, n++) % 1e13));
        w.pythConf = uint64(_r(seed, n++) % 1e11);
        w.pythExpo = int32(int256(_r(seed, n++) % 19));
        w.pythAge = uint32(_r(seed, n++));
        w.seqMode = uint8(_r(seed, n++));
        w.overrideStaleness = uint40(_r(seed, n++));
        w.overrideMinAnswer = int256(_r(seed, n++) % 1e12);
        w.overrideOnDirect = _r(seed, n++) % 2 == 0;
        w.secDevBps = uint16(_r(seed, n++));
        w.secStaleness = uint40(_r(seed, n++));
    }

    function _seedFeed(uint256 seed, uint256 n) internal pure returns (Feed memory f) {
        f.answer = int256(_r(seed, n) % 1e22) - 1e20;
        f.age = uint32(_r(seed, n + 1));
        f.dec18 = _r(seed, n + 2) % 3 == 0;
        f.mismatch = _r(seed, n + 3) % 8 == 0;
    }

    function _r(uint256 seed, uint256 n) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, n)));
    }

    // ─── Comparison ──────────────────────────────────────────────────────

    function _assertSame(PriceGuard guard, address asset) internal view {
        (OracleFacet.PriceStatus ds, uint256 dp, uint8 dd) = OracleFacet(address(diamond)).getAssetPriceStatus(asset);
        (IPriceGuard.PriceStatus gs, uint256 gp, uint8 gd) = guard.getAssetPriceStatus(asset);
        assertEq(uint8(gs), uint8(ds), "status");
        assertEq(gp, dp, "price");
        assertEq(gd, dd, "decimals");

        (bool dOk, bytes memory dRet) =
            address(diamond).staticcall(abi.encodeCall(OracleFacet.getAssetPrice, (asset)));
        (bool gOk, bytes memory gRet) = address(guard).staticcall(abi.encodeCall(IPriceGuard.getAssetPrice, (asset)));
        assertEq(gOk, dOk, "getAssetPrice success");
        assertEq(gRet, dRet, "getAssetPrice return or revert data");

        (dOk, dRet) =
            address(diamond).staticcall(abi.encodeCall(OracleFacet.countLiveSecondaryOracleFeeds, (asset)));
        (gOk, gRet) = address(guard).staticcall(abi.encodeCall(IPriceGuard.countLiveSecondaryOracleFeeds, (asset)));
        assertEq(gOk, dOk, "countLiveSecondaryOracleFeeds success");
        assertEq(gRet, dRet, "countLiveSecondaryOracleFeeds data");
    }

    // ─── The guard, and the Diamond that names it ───────────────────────────────────────────

    function _configure(World memory w) internal returns (PriceGuard guard) {
        address overrideTarget = w.overrideOnDirect ? directFeed : ethUsdFeed;

        PriceGuard.Identity memory id;
        id.numeraireSymbol = bytes32("usd");
        id.ethDenominator = ethDenom;
        PriceGuard.Change[] memory c = new PriceGuard.Change[](17);
        uint256 k;
        c[k++] = _change(PriceGuard.Kind.FeedRegistry, 0, registry);
        c[k++] = _change(PriceGuard.Kind.Weth, 0, weth);
        c[k++] = _change(PriceGuard.Kind.SecondarySource, 0, tellor);
        c[k++] = _change(PriceGuard.Kind.SecondarySource, 1, api3);
        c[k++] = _change(PriceGuard.Kind.SecondarySource, 2, dia);
        c[k++] = _changeU(PriceGuard.Kind.SecondaryMaxDeviationBps, w.secDevBps);
        c[k++] = _changeU(PriceGuard.Kind.SecondaryMaxStaleness, w.secStaleness);
        if (w.pythMode != 0) {
            c[k++] = _change(PriceGuard.Kind.PythOracle, 0, pyth);
            c[k++] = PriceGuard.Change(PriceGuard.Kind.PythFeedId, bytes32(0), PYTH_ID);
        }
        if (w.seqMode != 0) c[k++] = _change(PriceGuard.Kind.SequencerFeed, 0, sequencer);
        if (w.eurRefSet) c[k++] = _change(PriceGuard.Kind.StableRef, uint256(bytes32("EUR")), eurRefFeed);
        if (w.overrideStaleness != 0) {
            c[k++] = PriceGuard.Change(
                PriceGuard.Kind.FeedMaxStaleness, bytes32(uint256(uint160(overrideTarget))), bytes32(uint256(w.overrideStaleness))
            );
            c[k++] = PriceGuard.Change(
                PriceGuard.Kind.FeedMinAnswer, bytes32(uint256(uint160(overrideTarget))), bytes32(uint256(w.overrideMinAnswer))
            );
        }

        if (!w.industrial) {
            id.numeraireDenominator = usd;
            c[k++] = _change(PriceGuard.Kind.EthNumeraireFeed, 0, ethUsdFeed);
        } else {
            // Numeraire EUR, PAD USD: the industrial pivot.
            id.numeraireDenominator = eur;
            id.padDenominator = usd;
            c[k++] = _change(PriceGuard.Kind.EthNumeraireFeed, 0, ethEurFeed);
            c[k++] = _change(PriceGuard.Kind.EthPadFeed, 0, ethUsdFeed);
            if (w.padRateDirect) c[k++] = _change(PriceGuard.Kind.PadNumeraireRateFeed, 0, usdEurFeed);
            c[k++] = _change(PriceGuard.Kind.AssetDirectFeed, uint256(uint160(assetOverride)), overrideFeed);
        }
        assembly ("memory-safe") {
            mstore(c, k)
        }
        guard = PriceGuard(
            ArtifactDeploy.deploy(type(PriceGuard).name, abi.encode(address(this), address(this), id, uint64(0), c))
        );
        // The Diamond records a registry naming this guard, as a deploy does.
        MockProtocolRegistry r = new MockProtocolRegistry(address(diamond));
        r.setPointer(RegistryKeys.PRICE_GUARD, address(guard));
        OracleAdminFacet(address(diamond)).initializeProtocolRegistry(address(r));
    }

    // ─── The world's replies ─────────────────────────────────────────────

    function _arrange(World memory w) internal {
        _feed(ethUsdFeed, w.anchor);
        _feed(ethEurFeed, w.numer);
        _feed(usdEurFeed, w.padRate);
        _feed(directFeed, w.direct);
        _feed(pivotFeed, w.pivot);
        _feed(overrideFeed, w.overrideF);
        _feed(eurRefFeed, w.eurRef);
        address pad = usd;
        _mockGetFeed(assetDirect, pad, directFeed);
        _mockPairBase(assetDirect, pad, bytes32("LINK"));
        _mockGetFeed(assetPivot, ethDenom, pivotFeed);
        _mockPairBase(assetPivot, ethDenom, bytes32("UNI"));

        address[3] memory src = [tellor, api3, dia];
        for (uint256 i; i < 3; ++i) {
            uint8 m = w.secondaryMode[i];
            uint256 at = block.timestamp - (m == 2 ? 30 hours : w.secondaryAge[i]);
            uint256 v = m == 4 ? 0 : w.secondaryValue[i];
            if (m == 5) {
                // An echo of the direct feed's answer, nudged by up to ~10%,
                // so the tolerance decides.
                uint256 a = w.direct.answer > 0 ? uint256(w.direct.answer) : 1;
                uint256 nudge = (a * (w.secondaryValue[i] % 1000)) / 10_000;
                a = w.secondaryValue[i] % 2 == 0 ? a + nudge : a - nudge;
                uint256 fromDec = w.direct.dec18 ? 18 : 8;
                uint256 toDec = i == 2 ? 8 : 18;
                v = toDec >= fromDec ? a * 10 ** (toDec - fromDec) : a / 10 ** (fromDec - toDec);
            }
            bytes4 sel = i == 0
                ? ITellor.getDataBefore.selector
                : i == 1 ? IApi3ServerV1.readDataFeedWithDapiNameHash.selector : IDIAOracleV2.getValue.selector;
            if (m == 0) {
                vm.mockCall(src[i], abi.encodePacked(sel), "");
            } else if (m == 1) {
                vm.mockCallRevert(src[i], abi.encodePacked(sel), "down");
            } else if (i == 0) {
                vm.mockCall(src[i], abi.encodePacked(sel), abi.encode(abi.encode(v), at));
            } else if (i == 1) {
                vm.mockCall(src[i], abi.encodePacked(sel), abi.encode(int224(int256(v % 2 ** 200)), uint32(at)));
            } else {
                vm.mockCall(src[i], abi.encodePacked(sel), abi.encode(uint128(v % 2 ** 120), uint128(at)));
            }
        }

        if (w.pythMode == 1) {
            vm.mockCallRevert(pyth, abi.encodeCall(IPyth.getPriceUnsafe, (PYTH_ID)), "down");
        } else if (w.pythMode == 2) {
            vm.mockCall(
                pyth,
                abi.encodeCall(IPyth.getPriceUnsafe, (PYTH_ID)),
                abi.encode(IPyth.Price(w.pythPrice, w.pythConf, w.pythExpo, block.timestamp - w.pythAge))
            );
        }

        if (w.seqMode == 1) _seq(0, block.timestamp - 2 days);
        if (w.seqMode == 2) _seq(1, block.timestamp - 2 days);
        if (w.seqMode == 3) _seq(0, block.timestamp - 10 minutes);
    }

    function _feed(address feed, Feed memory f) internal {
        uint256 updatedAt = block.timestamp - f.age;
        vm.mockCall(feed, abi.encodeWithSignature("decimals()"), abi.encode(f.dec18 ? uint8(18) : uint8(8)));
        vm.mockCall(
            feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(5), f.answer, updatedAt, updatedAt, f.mismatch ? uint80(4) : uint80(5))
        );
    }

    function _seq(int256 answer, uint256 startedAt) internal {
        vm.mockCall(
            sequencer,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), answer, startedAt, startedAt, uint80(1))
        );
    }

    function _mockGetFeed(address base, address quote, address feed) internal {
        vm.mockCall(registry, abi.encodeWithSignature("getFeed(address,address)", base, quote), abi.encode(feed));
    }

    function _mockPairBase(address base, address quote, bytes32 symbol) internal {
        vm.mockCall(registry, abi.encodeCall(IFeedRegistryPairBase.pairBase, (base, quote)), abi.encode(symbol));
    }

    // ─── World shaping ───────────────────────────────────────────────────

    function _freshWorld() internal pure returns (World memory w) {
        w.anchor = Feed(2_000e8, 60, false, false);
        w.numer = Feed(1_850e8, 60, false, false);
        w.padRate = Feed(0.92e8, 60, false, false);
        w.direct = Feed(15e8, 60, false, false);
        w.pivot = Feed(0.004e18, 60, true, false);
        w.overrideF = Feed(14e8, 60, false, false);
        w.eurRef = Feed(1.08e8, 60, false, false);
        w.secondaryValue = [uint256(15e18), 15e18, 15e8];
        w.secondaryAge = [uint32(1 hours), 60, 60];
        w.pythConf = 1e5;
        w.pythExpo = -8;
        w.pythAge = 30;
        w.secDevBps = 500;
        w.secStaleness = 3600 * 2;
    }

    /// @dev Keep fuzzed inputs within what each source can encode, and
    ///      bias the answers toward the bands where the rules decide.
    function _normalise(World memory w) internal pure {
        _feedN(w.anchor);
        _feedN(w.numer);
        _feedN(w.padRate);
        _feedN(w.direct);
        _feedN(w.pivot);
        _feedN(w.overrideF);
        _feedN(w.eurRef);
        for (uint256 i; i < 3; ++i) {
            w.secondaryMode[i] %= 6;
            w.secondaryValue[i] %= 1e30;
            w.secondaryAge[i] %= 40 hours;
        }
        w.pythMode %= 3;
        w.pythAge %= 2 hours;
        w.pythExpo = -int32(uint32(uint256(int256(w.pythExpo)) % 19));
        w.seqMode %= 4;
        w.overrideStaleness = w.overrideStaleness % 2 == 0 ? 0 : uint40(1 + uint256(w.overrideStaleness) % 25 hours);
        w.overrideMinAnswer = w.overrideMinAnswer % 1e12;
        w.secDevBps = uint16(100 + uint256(w.secDevBps) % 1901);
        w.secStaleness = uint40(60 + uint256(w.secStaleness) % (29 hours - 59));
    }

    /// @dev Three in four feeds are fresh and positive; the rest roam the
    ///      stale, non-positive and peg-band cases.
    function _feedN(Feed memory f) internal pure {
        uint256 r = uint256(f.age);
        if (r % 4 != 0) {
            f.age = uint32(r % 2 hours);
            f.answer = int256(1 + uint256(f.answer < 0 ? -(f.answer + 1) : f.answer) % 1e14);
            f.mismatch = false;
        } else {
            f.age = uint32(r % 27 hours);
            f.answer = f.answer % 1e22;
        }
    }

    // ─── Small helpers ───────────────────────────────────────────────────

    function _sentinel(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.etch(a, hex"00");
    }

    function _cut(address facet, bytes4[] memory sels) internal pure returns (IDiamondCut.FacetCut memory) {
        return IDiamondCut.FacetCut(facet, IDiamondCut.FacetCutAction.Add, sels);
    }

    function _change(PriceGuard.Kind kind, uint256 subject, address value)
        internal
        pure
        returns (PriceGuard.Change memory)
    {
        return PriceGuard.Change(kind, bytes32(subject), bytes32(uint256(uint160(value))));
    }

    function _changeU(PriceGuard.Kind kind, uint256 value) internal pure returns (PriceGuard.Change memory) {
        return PriceGuard.Change(kind, bytes32(0), bytes32(value));
    }
}
