// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {PriceGuardState} from "../src/oracle/PriceGuardState.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {VaipakamFeedRegistry} from "../src/oracle/VaipakamFeedRegistry.sol";
import {Erc4626RateReader} from "../src/oracle/rate/Erc4626RateReader.sol";
import {PriceGuardDeployment} from "../script/lib/PriceGuardDeployment.sol";
import {VersionFeed, VersionToken} from "./PriceGuardVersionTest.t.sol";

/// @dev A token-rate reader whose rate the test sets.
contract SetRateReader {
    uint256 public value;

    function set(uint256 v) external {
        value = v;
    }

    function rate(address, address) external view returns (uint256) {
        return value;
    }
}

/// @dev A minimal ERC-4626-shaped share: `convertToAssets` is set by the test.
contract ShareMock {
    address public asset;
    uint8 public decimals;
    uint256 public assetsPerShare;

    constructor(address asset_, uint8 decimals_) {
        asset = asset_;
        decimals = decimals_;
    }

    function setAssetsPerShare(uint256 a) external {
        assetsPerShare = a;
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return shares * assetsPerShare / (10 ** uint256(decimals));
    }
}

/// @dev An underlying with settable decimals.
contract DecToken {
    uint8 public decimals;

    constructor(uint8 d) {
        decimals = d;
    }
}

/**
 * @title  PriceGuardRateTest
 * @notice #3683: collateral priced by an exchange rate. The price is the
 *         underlying's price times the accepted rate, the lower of that and
 *         a bound market feed; the rate never jumps up, a large fall stops
 *         trust until it is confirmed on one rule, and a binding starts from
 *         the rate reported when it was proposed.
 */
contract PriceGuardRateTest is Test {
    address internal constant USD = 0x0000000000000000000000000000000000000348;
    address internal constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    bytes32 internal constant DIR = keccak256("directory");

    VaipakamFeedRegistry internal reg;
    PriceGuard internal guard;
    VersionFeed internal ethUsd;
    VersionFeed internal linkUsd;
    address internal link;
    address internal wrapped;
    SetRateReader internal reader;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_800_000_000);
        reg = new VaipakamFeedRegistry(address(this), address(this));
        reg.setDelay(0);
        ethUsd = new VersionFeed("ETH / USD", 8, 3000e8);
        link = address(new VersionToken());
        wrapped = address(new VersionToken());
        PriceGuardState.Change[] memory c = new PriceGuardState.Change[](2);
        c[0] = PriceGuardState.Change(PriceGuardState.Kind.FeedRegistry, 0, _w(address(reg)));
        c[1] = PriceGuardState.Change(PriceGuardState.Kind.EthNumeraireFeed, 0, _w(address(ethUsd)));
        guard = PriceGuard(PriceGuardDeployment.build(address(this), address(this), _identity(), 0, c));
        linkUsd = new VersionFeed("LINK / USD", 8, 10e8);
        _registry(link, USD, VaipakamFeedRegistry.EntryKind.Price, address(0), address(linkUsd), 8, "LINK / USD");
        reader = new SetRateReader();
        reader.set(1.1e18);
    }

    // ─── price ───────────────────────────────────────────────────────────

    function test_PriceIsTheUnderlyingTimesTheRate() public {
        _bind(_readerBinding(500, address(0)));
        assertTrue(guard.isRatePriced(wrapped));
        (uint256 p, uint8 d) = guard.getAssetPrice(wrapped);
        assertEq(d, 8);
        assertEq(p, 11e8, "10 USD x 1.1");
    }

    function test_ARateFeedPricesLikeAReader() public {
        VersionFeed rf = new VersionFeed("wLINK / LINK exchange rate", 18, 1.2e18);
        _registry(wrapped, link, VaipakamFeedRegistry.EntryKind.Rate, address(0), address(rf), 18, "wLINK / LINK exchange rate");
        PriceGuardState.RateBinding memory b = _readerBinding(500, address(0));
        b.source = address(rf);
        b.sourceIsReader = false;
        b.rateHeartbeat = 3600;
        _bind(b);
        (uint256 p,) = guard.getAssetPrice(wrapped);
        assertEq(p, 12e8);
    }

    function test_AnErc4626ShareIsReadThroughItsReader() public {
        DecToken under = new DecToken(6);
        VersionFeed uf = new VersionFeed("UND / USD", 8, 1e8);
        _registry(address(under), USD, VaipakamFeedRegistry.EntryKind.Price, address(0), address(uf), 8, "UND / USD");
        ShareMock share = new ShareMock(address(under), 18);
        share.setAssetsPerShare(1.05e6); // one share = 1.05 UND
        Erc4626RateReader r = new Erc4626RateReader();
        PriceGuardState.RateBinding memory b = PriceGuardState.RateBinding({
            underlying: address(under),
            source: address(r),
            sourceIsReader: true,
            rateHeartbeat: 0,
            marketFeed: address(0),
            marketHeartbeat: 0,
            maxRiseBpsPerDay: 50,
            maxFallBps: 500
        });
        bytes32 h = guard.proposeRateBinding(address(share), b);
        guard.executeChange(PriceGuardState.Kind.RateBinding, _w(address(share)));
        assertEq(guard.rateStateOf(address(share), h).accepted, 1.05e18);
        (uint256 p,) = guard.getAssetPrice(address(share));
        assertEq(p, 1.05e8);
    }

    function test_TheMarketFeedCanOnlyLowerThePrice() public {
        VersionFeed mf = new VersionFeed("wLINK / USD", 8, 10.5e8);
        _registry(wrapped, USD, VaipakamFeedRegistry.EntryKind.Price, address(0), address(mf), 8, "wLINK / USD");
        _bind(_readerBinding(500, address(mf)));
        (uint256 p,) = guard.getAssetPrice(wrapped);
        assertEq(p, 10.5e8, "the market is below the rate price");
        mf.set(12e8);
        (p,) = guard.getAssetPrice(wrapped);
        assertEq(p, 11e8, "the market above the rate price does not raise it");
    }

    // ─── the rate never jumps up ─────────────────────────────────────────

    function test_AnInflatedRateMovesThePriceByAtMostOneDaysBound() public {
        bytes32 h = _bind(_readerBinding(500, address(0)));
        vm.warp(vm.getBlockTimestamp() + 10 days);
        linkUsd.touch();
        ethUsd.touch();
        reader.set(2e18);
        (uint256 p,) = guard.getAssetPrice(wrapped);
        assertEq(p, 11e8 * 101 / 100, "one day's 1% at most, however old the record");
        guard.recordRate(wrapped, h);
        guard.recordRate(wrapped, h);
        assertEq(guard.rateStateOf(wrapped, h).accepted, 1.1e18 * 101 / 100, "a second record in the block adds nothing");
    }

    // ─── a fall ──────────────────────────────────────────────────────────

    function test_ASmallFallIsTakenAtOnce() public {
        bytes32 h = _bind(_readerBinding(500, address(0)));
        reader.set(1.08e18); // under 5%
        (uint256 p,) = guard.getAssetPrice(wrapped);
        assertEq(p, 10.8e8);
        guard.recordRate(wrapped, h);
        assertEq(guard.rateStateOf(wrapped, h).accepted, 1.08e18);
    }

    function test_AFallPastTheBoundIsDistrustedUntilConfirmed() public {
        bytes32 h = _bind(_readerBinding(500, address(0)));
        reader.set(0.9e18);
        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.RatePriceDistrusted.selector, wrapped));
        guard.getAssetPrice(wrapped);
        guard.recordRate(wrapped, h);
        assertGt(guard.rateStateOf(wrapped, h).observedSince, 0);

        vm.expectRevert();
        guard.confirmRate(wrapped, h); // the observation is not over

        vm.warp(vm.getBlockTimestamp() + 3 hours);
        reader.set(0.88e18);
        guard.recordRate(wrapped, h); // a small further fall: the lowest moves
        vm.warp(vm.getBlockTimestamp() + 6 hours);
        reader.set(0.95e18); // the source reports higher at confirmation
        linkUsd.touch();
        ethUsd.touch();
        guard.confirmRate(wrapped, h);
        PriceGuardState.RateState memory st = guard.rateStateOf(wrapped, h);
        assertEq(st.accepted, 0.88e18, "the lowest since the fall, chosen by no one");
        assertEq(st.observedSince, 0);
        (uint256 p,) = guard.getAssetPrice(wrapped);
        assertEq(p, 8.8e8, "and it rises from there only under the daily bound");
    }

    function test_AFurtherFallRestartsTheObservation() public {
        bytes32 h = _bind(_readerBinding(500, address(0)));
        reader.set(0.9e18);
        guard.recordRate(wrapped, h);
        vm.warp(vm.getBlockTimestamp() + 5 hours);
        reader.set(0.8e18); // past the bound again, from the lowest
        guard.recordRate(wrapped, h);
        assertEq(guard.rateStateOf(wrapped, h).observedSince, vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        linkUsd.touch();
        ethUsd.touch();
        vm.expectRevert();
        guard.confirmRate(wrapped, h);
    }

    function test_MutingIsInstantAndDistrustsEveryRead() public {
        _bind(_readerBinding(500, address(0)));
        guard.muteRateSource(wrapped);
        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.RatePriceDistrusted.selector, wrapped));
        guard.getAssetPrice(wrapped);
    }

    // ─── how a binding starts ────────────────────────────────────────────

    function test_TheFirstRateIsTheOneReportedAtProposal() public {
        guard.raiseDelay(1 days);
        bytes32 h = guard.proposeRateBinding(wrapped, _readerBinding(500, address(0)));
        assertEq(guard.rateStateOf(wrapped, h).accepted, 1.1e18);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        linkUsd.touch();
        ethUsd.touch();
        reader.set(3e18); // pushed up for the execution
        guard.executeChange(PriceGuardState.Kind.RateBinding, _w(wrapped));
        assertEq(guard.rateStateOf(wrapped, h).accepted, 1.1e18 * 101 / 100, "execution takes the lower value");
    }

    function test_ACorrectionWhilePendingLowersTheRateWithoutDistrust() public {
        guard.raiseDelay(1 days);
        bytes32 h = guard.proposeRateBinding(wrapped, _readerBinding(500, address(0)));
        reader.set(0.9e18); // past the 5% bound
        guard.recordRate(wrapped, h);
        PriceGuardState.RateState memory st = guard.rateStateOf(wrapped, h);
        assertEq(st.accepted, 0.9e18);
        assertEq(st.observedSince, 0, "nothing is priced from a pending binding");
        vm.warp(vm.getBlockTimestamp() + 1 days);
        linkUsd.touch();
        ethUsd.touch();
        guard.executeChange(PriceGuardState.Kind.RateBinding, _w(wrapped));
        (uint256 p,) = guard.getAssetPrice(wrapped);
        assertEq(p, 9e8);

        reader.set(0.8e18); // the same kind of fall, now live
        guard.recordRate(wrapped, h);
        assertGt(guard.rateStateOf(wrapped, h).observedSince, 0, "after execution the fall rule applies");
    }

    function test_ARateBindingIsSetOnlyThroughItsProposal() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceGuardState.InvalidChange.selector, PriceGuardState.Kind.RateBinding, _w(wrapped), bytes32(uint256(1))
            )
        );
        guard.proposeChange(PriceGuardState.Kind.RateBinding, _w(wrapped), bytes32(uint256(1)));
    }

    function test_ABindingChangeRaisesThePriceVersion() public {
        uint64 g = guard.epoch();
        _bind(_readerBinding(500, address(0)));
        assertEq(guard.epoch(), g + 1);
        (uint256 p,) = guard.getAssetPriceAt(wrapped, g + 1, reg.epoch());
        assertEq(p, 11e8);
        guard.proposeChange(PriceGuardState.Kind.RateBinding, _w(wrapped), bytes32(0));
        guard.executeChange(PriceGuardState.Kind.RateBinding, _w(wrapped));
        assertFalse(guard.isRatePriced(wrapped));
        (p,) = guard.getAssetPriceAt(wrapped, g + 1, reg.epoch());
        assertEq(p, 11e8, "a loan on the old version keeps its binding");
    }

    function test_TheUnderlyingMayNotItselfBeRatePriced() public {
        _bind(_readerBinding(500, address(0)));
        address w2 = address(new VersionToken());
        PriceGuardState.RateBinding memory b = _readerBinding(500, address(0));
        b.underlying = wrapped;
        vm.expectRevert();
        guard.proposeRateBinding(w2, b);
    }

    // ─── helpers ─────────────────────────────────────────────────────────

    function _readerBinding(uint16 maxFallBps, address marketFeed)
        internal
        view
        returns (PriceGuardState.RateBinding memory)
    {
        return PriceGuardState.RateBinding({
            underlying: link,
            source: address(reader),
            sourceIsReader: true,
            rateHeartbeat: 0,
            marketFeed: marketFeed,
            marketHeartbeat: marketFeed == address(0) ? 0 : 3600,
            maxRiseBpsPerDay: 100,
            maxFallBps: maxFallBps
        });
    }

    function _bind(PriceGuardState.RateBinding memory b) internal returns (bytes32 h) {
        h = guard.proposeRateBinding(wrapped, b);
        guard.executeChange(PriceGuardState.Kind.RateBinding, _w(wrapped));
    }

    function _registry(
        address base,
        address quote,
        VaipakamFeedRegistry.EntryKind kind,
        address expected,
        address feed,
        uint8 dec,
        string memory pair
    ) internal {
        VaipakamFeedRegistry.Change[] memory cs = new VaipakamFeedRegistry.Change[](1);
        cs[0] = VaipakamFeedRegistry.Change({
            base: base,
            quote: quote,
            kind: kind,
            expectedFeed: expected,
            feed: feed,
            feedDecimals: dec,
            category: VaipakamFeedRegistry.Category.Low,
            heartbeat: 3600,
            pair: pair
        });
        uint256 id = reg.propose(cs, DIR, 20261115);
        reg.execute(id, cs);
    }

    function _identity() internal pure returns (PriceGuardState.Identity memory) {
        return PriceGuardState.Identity({
            numeraireDenominator: USD,
            numeraireSymbol: bytes32("usd"),
            padDenominator: address(0),
            ethDenominator: ETH
        });
    }

    function _w(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
