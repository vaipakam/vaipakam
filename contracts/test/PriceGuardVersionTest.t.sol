// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {PriceGuardState} from "../src/oracle/PriceGuardState.sol";
import {PriceGuardReader} from "../src/oracle/PriceGuardReader.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {VaipakamFeedRegistry} from "../src/oracle/VaipakamFeedRegistry.sol";
import {PriceGuardDeployment} from "../script/lib/PriceGuardDeployment.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

/// @dev A Chainlink-shaped feed whose answer and time the test sets.
contract VersionFeed {
    string public description;
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(string memory d, uint8 dec, int256 a) {
        description = d;
        decimals = dec;
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
    }

    function touch() external {
        updatedAt = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract VersionToken {
    uint8 public decimals = 18;
}

/**
 * @title  PriceGuardVersionTest
 * @notice #3437 step 1: every price read can be made at a price version
 *         (guard epoch, registry epoch); a retired version is refused by the
 *         guard's floor; and the guard answers its reads through its reader.
 *         Runs on the real feed registry, so the registry's own epochs and
 *         history are what the guard reads.
 */
contract PriceGuardVersionTest is Test {
    address internal constant USD = 0x0000000000000000000000000000000000000348;
    address internal constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    bytes32 internal constant DIR = keccak256("directory");

    VaipakamFeedRegistry internal reg;
    PriceGuard internal guard;
    VersionFeed internal ethUsd;
    address internal link;

    function setUp() public {
        vm.chainId(84532); // a testnet: both delays may be zero
        vm.warp(1_800_000_000);
        reg = new VaipakamFeedRegistry(address(this), address(this));
        reg.setDelay(0);
        ethUsd = new VersionFeed("ETH / USD", 8, 3000e8);
        link = address(new VersionToken());
        PriceGuardState.Change[] memory c = new PriceGuardState.Change[](2);
        c[0] = PriceGuardState.Change(PriceGuardState.Kind.FeedRegistry, 0, _w(address(reg)));
        c[1] = PriceGuardState.Change(PriceGuardState.Kind.EthNumeraireFeed, 0, _w(address(ethUsd)));
        guard = PriceGuard(PriceGuardDeployment.build(address(this), address(this), _identity(), 0, c));
    }

    // ─── as-of reads ─────────────────────────────────────────────────────

    function test_ReadAtAnEarlierVersionUsesTheFeedOfThatVersion() public {
        VersionFeed a = new VersionFeed("LINK / USD", 8, 10e8);
        _setFeed(link, address(0), address(a));
        (uint64 g, uint64 r) = guard.priceVersion();

        VersionFeed b = new VersionFeed("LINK / USD", 8, 12e8);
        _setFeed(link, address(a), address(b));
        (uint64 g2, uint64 r2) = guard.priceVersion();
        assertEq(g2, g, "a registry change leaves the guard epoch");
        assertEq(r2, r + 1, "one executed proposal is one registry epoch");

        (uint256 now_,) = guard.getAssetPrice(link);
        (uint256 then_,) = guard.getAssetPriceAt(link, g, r);
        assertEq(now_, 12e8, "the newest version reads the new feed");
        assertEq(then_, 10e8, "the earlier version reads the feed it had");
        (uint256 newest,) = guard.getAssetPriceAt(link, g2, r2);
        assertEq(newest, now_, "the newest version read as-of answers as the latest read");
    }

    function test_AGuardSettingIsVersionedToo() public {
        VersionFeed a = new VersionFeed("LINK / USD", 8, 10e8);
        _setFeed(link, address(0), address(a));
        (uint64 g, uint64 r) = guard.priceVersion();
        bytes32 subject = _w(address(a));
        guard.proposeChange(PriceGuardState.Kind.FeedMaxStaleness, subject, bytes32(uint256(600)));
        guard.executeChange(PriceGuardState.Kind.FeedMaxStaleness, subject);
        assertEq(guard.epoch(), g + 1, "a price setting raises the guard epoch");
        assertEq(guard.configAt(PriceGuardState.Kind.FeedMaxStaleness, subject, g), bytes32(0));
        assertEq(guard.configAt(PriceGuardState.Kind.FeedMaxStaleness, subject, g + 1), bytes32(uint256(600)));

        vm.warp(vm.getBlockTimestamp() + 700); // past the new 600 s budget, inside the old 2 h one
        a.touch();
        vm.warp(vm.getBlockTimestamp() + 700);
        vm.expectRevert(IPriceGuard.StalePriceData.selector);
        guard.getAssetPrice(link);
        (uint256 p,) = guard.getAssetPriceAt(link, g, r);
        assertEq(p, 10e8, "the earlier version still has no override");
    }

    function test_ALeverIsNotVersioned() public {
        uint64 g = guard.epoch();
        guard.proposeChange(PriceGuardState.Kind.RateObservation, 0, bytes32(uint256(2 hours)));
        guard.executeChange(PriceGuardState.Kind.RateObservation, 0);
        assertEq(guard.epoch(), g, "a lever leaves the epoch");
        assertEq(guard.rateObservation(), 2 hours);
    }

    function test_AVersionThatDoesNotExistIsRefused() public {
        (uint64 g, uint64 r) = guard.priceVersion();
        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.UnknownPriceVersion.selector, g + 1, r));
        guard.getAssetPriceAt(link, g + 1, r);
        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.UnknownPriceVersion.selector, g, r + 1));
        guard.getAssetPriceAt(link, g, r + 1);
        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.UnknownPriceVersion.selector, 0, r));
        guard.getAssetPriceStatusAt(link, 0, r);
    }

    // ─── the floor ───────────────────────────────────────────────────────

    function test_TheFloorRetiresEveryEarlierVersion() public {
        VersionFeed a = new VersionFeed("LINK / USD", 8, 10e8);
        _setFeed(link, address(0), address(a));
        (uint64 g, uint64 r) = guard.priceVersion();
        VersionFeed b = new VersionFeed("LINK / USD", 8, 12e8);
        _setFeed(link, address(a), address(b));
        (uint64 g2, uint64 r2) = guard.priceVersion();

        _raiseFloor(g2, r2);
        (uint64 fg, address fr, uint64 fre) = guard.priceFloor();
        assertEq(fg, g2);
        assertEq(fr, address(reg));
        assertEq(fre, r2);

        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.PriceVersionRetired.selector, g, r));
        guard.getAssetPriceAt(link, g, r);
        // A retired version is refused, never read as a missing price.
        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.PriceVersionRetired.selector, g, r));
        guard.getAssetPriceStatusAt(link, g, r);
        (uint256 p,) = guard.getAssetPriceAt(link, g2, r2);
        assertEq(p, 12e8);
    }

    function test_TheFloorMayOnlyNameTheCurrentVersion() public {
        (uint64 g, uint64 r) = guard.priceVersion();
        bytes32 stale = bytes32(uint256(g) << 64 | (r + 1));
        vm.expectRevert(
            abi.encodeWithSelector(PriceGuardState.InvalidChange.selector, PriceGuardState.Kind.PriceFloor, bytes32(0), stale)
        );
        guard.proposeChange(PriceGuardState.Kind.PriceFloor, 0, stale);
    }

    function test_AFloorThatComesDueAfterTheVersionMovedLapses() public {
        (uint64 g, uint64 r) = guard.priceVersion();
        guard.proposeChange(PriceGuardState.Kind.PriceFloor, 0, bytes32(uint256(g) << 64 | r));
        VersionFeed a = new VersionFeed("LINK / USD", 8, 10e8);
        _setFeed(link, address(0), address(a)); // the registry epoch moves on
        vm.expectEmit(address(guard));
        emit PriceGuardState.PriceFloorLapsed(g, r);
        guard.executeChange(PriceGuardState.Kind.PriceFloor, 0);
        (uint64 fg,,) = guard.priceFloor();
        assertEq(fg, 0, "a lapsed floor is not applied");
    }

    function test_AVersionOnALaterRegistryIsNewerThanTheFloor() public {
        VersionFeed a = new VersionFeed("LINK / USD", 8, 10e8);
        _setFeed(link, address(0), address(a));
        _setFeed(link, address(a), address(new VersionFeed("LINK / USD", 8, 11e8)));
        (uint64 g, uint64 r) = guard.priceVersion();
        _raiseFloor(g, r); // registry epoch 3 on the first registry

        VaipakamFeedRegistry reg2 = new VaipakamFeedRegistry(address(this), address(this));
        reg2.setDelay(0);
        VersionFeed c = new VersionFeed("LINK / USD", 8, 20e8);
        _setFeedOn(reg2, link, address(0), address(c)); // registry epoch 2 on the second
        guard.proposeChange(PriceGuardState.Kind.FeedRegistry, 0, _w(address(reg2)));
        guard.executeChange(PriceGuardState.Kind.FeedRegistry, 0);

        (uint64 g2, uint64 r2) = guard.priceVersion();
        assertLt(r2, r, "the new registry counts from its own start");
        (uint256 p,) = guard.getAssetPriceAt(link, g2, r2);
        assertEq(p, 20e8, "a version on the later registry is not below the floor");
    }

    // ─── the reader seam ─────────────────────────────────────────────────

    function test_TheReaderRefusesADirectRead() public {
        address reader = guard.READER();
        vm.expectRevert(PriceGuardReader.NotThroughGuard.selector);
        PriceGuardReader(reader).getAssetPrice(link);
    }

    function test_OnlyTheGuardMayRunTheReader() public {
        vm.expectRevert(PriceGuard.NotSelf.selector);
        guard.readThroughReader(abi.encodeCall(IPriceGuard.getAssetPrice, (link)));
    }

    function test_AGuardRefusesAReaderBuiltForAnotherIdentity() public {
        PriceGuardState.Identity memory other = _identity();
        other.numeraireSymbol = bytes32("eur");
        address reader = ArtifactDeploy.deploy(type(PriceGuardReader).name, abi.encode(other));
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.ReaderMismatch.selector, reader));
        ArtifactDeploy.deploy(
            type(PriceGuard).name,
            abi.encode(address(this), address(this), _identity(), uint64(0), new PriceGuardState.Change[](0), reader)
        );
    }

    function test_ARefusedReadCarriesTheReadersRevert() public {
        vm.expectRevert(IPriceGuard.NoPriceFeed.selector);
        guard.getAssetPrice(link);
        (IPriceGuard.PriceStatus s,,) = guard.getAssetPriceStatus(link);
        assertEq(uint8(s), uint8(IPriceGuard.PriceStatus.Unavailable));
    }

    // ─── helpers ─────────────────────────────────────────────────────────

    function _raiseFloor(uint64 g, uint64 r) internal {
        guard.proposeChange(PriceGuardState.Kind.PriceFloor, 0, bytes32(uint256(g) << 64 | r));
        guard.executeChange(PriceGuardState.Kind.PriceFloor, 0);
    }

    function _setFeed(address base, address expected, address feed) internal {
        _setFeedOn(reg, base, expected, feed);
    }

    function _setFeedOn(VaipakamFeedRegistry r, address base, address expected, address feed) internal {
        VaipakamFeedRegistry.Change[] memory cs = new VaipakamFeedRegistry.Change[](1);
        cs[0] = VaipakamFeedRegistry.Change({
            base: base,
            quote: USD,
            kind: VaipakamFeedRegistry.EntryKind.Price,
            expectedFeed: expected,
            feed: feed,
            feedDecimals: 8,
            category: VaipakamFeedRegistry.Category.Low,
            heartbeat: 3600,
            pair: "LINK / USD"
        });
        uint256 id = r.propose(cs, DIR, 20261115);
        r.execute(id, cs);
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
