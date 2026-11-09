// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {IFeedRegistryPairBase} from "../src/interfaces/IFeedRegistryPairBase.sol";
import {ITellor} from "../src/interfaces/ITellor.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

/**
 * @title  PriceGuardConfigTest
 * @notice How {PriceGuard}'s config changes (#3272): the starting config set
 *         at construction, the propose / wait / execute path every later
 *         change takes, the cancel, the delay and its bounds, the guardian's
 *         one instant lever, and the checks every entry passes.
 * @dev    {PriceGuardParityTest} proves the price read matches the Diamond's
 *         oracle; this suite covers what the Diamond never had.
 */
contract PriceGuardConfigTest is Test {
    address internal owner = makeAddr("timelock");
    address internal guardian = makeAddr("pauserSafe");
    address internal stranger = makeAddr("stranger");

    address internal usd = address(840);
    address internal ethDenom = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address internal weth;
    address internal asset = makeAddr("asset");

    address internal registry;
    address internal anchor;
    address internal directFeed;
    address internal tellor;
    address internal api3;

    uint64 internal constant DELAY = 3 days;

    function setUp() public {
        registry = _sentinel("registry");
        anchor = _sentinel("anchor");
        directFeed = _sentinel("directFeed");
        tellor = _sentinel("tellor");
        api3 = _sentinel("api3");
        weth = _sentinel("weth");
        vm.warp(100 days);
    }

    // ─── Construction ────────────────────────────────────────────────────

    function test_ConstructorAppliesTheStartingConfigAtOnce() public {
        PriceGuard g = _guard(DELAY);
        assertEq(g.feedRegistry(), registry, "registry");
        assertEq(g.ethNumeraireFeed(), anchor, "anchor");
        assertEq(g.secondarySource(PriceGuard.Source.Tellor), tellor, "tellor");
        assertEq(g.weth(), weth, "weth");
        assertEq(g.delay(), DELAY, "delay");
        assertEq(g.guardian(), guardian, "guardian");
        assertEq(g.owner(), owner, "owner");
        // Unnamed knobs take their defaults.
        assertEq(g.pythMaxStaleness(), 300);
        assertEq(g.pythMaxDeviationBps(), 500);
        assertEq(g.pythConfidenceMaxBps(), 100);
        assertEq(g.secondaryMaxDeviationBps(), 500);
        assertEq(g.secondaryMaxStaleness(), 3600);
        // Nothing waits: the starting config is live from the first block.
        (, uint256 at) = g.pendingChange(PriceGuard.Kind.FeedRegistry, bytes32(0));
        assertEq(at, 0, "nothing pending");
    }

    function test_TheNumeraireIdentityIsFixedAtConstruction() public {
        PriceGuard g = _guard(DELAY);
        assertEq(g.NUMERAIRE_DENOMINATOR(), usd);
        assertEq(g.NUMERAIRE_SYMBOL(), bytes32("usd"));
        assertEq(g.PAD_DENOMINATOR(), usd, "an unset PAD is the numeraire");
        assertEq(g.ETH_DENOMINATOR(), ethDenom);
        assertTrue(g.padIsNumeraire());
    }

    function test_ConstructorRefusesADelayOrReEnableEntry() public {
        PriceGuard.Change[] memory c = new PriceGuard.Change[](1);
        c[0] = PriceGuard.Change(PriceGuard.Kind.Delay, bytes32(0), bytes32(uint256(1 days)));
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.InvalidChange.selector, c[0].kind, c[0].subject, c[0].value));
        _new(owner, guardian, _identity(), DELAY, c);

        c[0] = PriceGuard.Change(PriceGuard.Kind.SecondaryEnabled, bytes32(0), bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.InvalidChange.selector, c[0].kind, c[0].subject, c[0].value));
        _new(owner, guardian, _identity(), DELAY, c);
    }

    function test_ConstructorChecksTheStartingConfigLikeAnyChange() public {
        PriceGuard.Change[] memory c = new PriceGuard.Change[](1);
        address eoa = makeAddr("eoa");
        c[0] = _change(PriceGuard.Kind.FeedRegistry, 0, eoa);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NotAContract.selector, PriceGuard.Kind.FeedRegistry, eoa));
        _new(owner, guardian, _identity(), DELAY, c);

        c[0] = _changeU(PriceGuard.Kind.SecondaryMaxDeviationBps, 50);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.InvalidChange.selector, c[0].kind, c[0].subject, c[0].value));
        _new(owner, guardian, _identity(), DELAY, c);
    }

    function test_ConstructorRefusesABadIdentityOrGuardian() public {
        PriceGuard.Change[] memory none;
        vm.expectRevert(PriceGuard.ZeroAddress.selector);
        _new(owner, address(0), _identity(), DELAY, none);

        PriceGuard.Identity memory id = _identity();
        id.numeraireDenominator = address(0);
        vm.expectRevert(PriceGuard.ZeroAddress.selector);
        _new(owner, guardian, id, DELAY, none);

        id = _identity();
        id.ethDenominator = address(0);
        vm.expectRevert(PriceGuard.ZeroAddress.selector);
        _new(owner, guardian, id, DELAY, none);

        // The symbol keys the secondary queries in lower case.
        id = _identity();
        id.numeraireSymbol = bytes32("USD");
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.InvalidNumeraireSymbol.selector, bytes32("USD")));
        _new(owner, guardian, id, DELAY, none);

        id.numeraireSymbol = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.InvalidNumeraireSymbol.selector, bytes32(0)));
        _new(owner, guardian, id, DELAY, none);
    }

    // ─── Delay bounds ────────────────────────────────────────────────────

    function test_AProductionChainHoldsTheDelayBetweenOneAndFourteenDays() public {
        vm.chainId(1);
        PriceGuard.Change[] memory none;
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.DelayOutOfRange.selector, 0, 1 days, 14 days));
        _new(owner, guardian, _identity(), 0, none);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.DelayOutOfRange.selector, 15 days, 1 days, 14 days));
        _new(owner, guardian, _identity(), 15 days, none);
        PriceGuard g = _new(owner, guardian, _identity(), 1 days, none);
        assertFalse(g.TESTNET());

        // Lowering below the floor is refused at proposal.
        vm.prank(owner);
        g.raiseDelay(3 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.DelayOutOfRange.selector, 12 hours, 1 days, 14 days));
        g.proposeChange(PriceGuard.Kind.Delay, bytes32(0), bytes32(uint256(12 hours)));
    }

    function test_ATestnetMaySetNoDelay() public {
        vm.chainId(84532);
        PriceGuard g = _guard(0);
        assertTrue(g.TESTNET());
        vm.prank(owner);
        g.proposeChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0), bytes32(uint256(600)));
        g.executeChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0));
        assertEq(g.pythMaxStaleness(), 600);
    }

    // ─── Propose, wait, execute ──────────────────────────────────────────

    function test_AChangeWaitsTheDelayThenAnyoneMayExecuteIt() public {
        PriceGuard g = _guard(DELAY);
        address next = _sentinel("nextRegistry");
        bytes32 v = _word(next);
        uint256 at = block.timestamp + DELAY;

        vm.expectEmit(address(g));
        emit PriceGuard.ChangeProposed(PriceGuard.Kind.FeedRegistry, bytes32(0), v, at);
        vm.prank(owner);
        g.proposeChange(PriceGuard.Kind.FeedRegistry, bytes32(0), v);
        (bytes32 pv, uint256 pat) = g.pendingChange(PriceGuard.Kind.FeedRegistry, bytes32(0));
        assertEq(pv, v);
        assertEq(pat, at);

        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NotReady.selector, PriceGuard.Kind.FeedRegistry, bytes32(0), at));
        g.executeChange(PriceGuard.Kind.FeedRegistry, bytes32(0));
        assertEq(g.feedRegistry(), registry, "unchanged while it waits");

        vm.warp(at);
        vm.expectEmit(address(g));
        emit PriceGuard.ConfigSet(PriceGuard.Kind.FeedRegistry, bytes32(0), v);
        vm.prank(stranger);
        g.executeChange(PriceGuard.Kind.FeedRegistry, bytes32(0));
        assertEq(g.feedRegistry(), next);
        (, pat) = g.pendingChange(PriceGuard.Kind.FeedRegistry, bytes32(0));
        assertEq(pat, 0, "cleared");

        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NothingPending.selector, PriceGuard.Kind.FeedRegistry, bytes32(0)));
        g.executeChange(PriceGuard.Kind.FeedRegistry, bytes32(0));
    }

    function test_OnlyTheOwnerProposes() public {
        PriceGuard g = _guard(DELAY);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        g.proposeChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0), bytes32(uint256(600)));
    }

    function test_OneChangeWaitsPerEntry() public {
        PriceGuard g = _guard(DELAY);
        bytes32 tellorKey = bytes32(uint256(PriceGuard.Source.Tellor));
        bytes32 api3Key = bytes32(uint256(PriceGuard.Source.Api3));
        vm.startPrank(owner);
        g.proposeChange(PriceGuard.Kind.SecondarySource, tellorKey, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.ChangePending.selector, PriceGuard.Kind.SecondarySource, tellorKey));
        g.proposeChange(PriceGuard.Kind.SecondarySource, tellorKey, _word(api3));
        // Another subject of the same kind is its own entry.
        g.proposeChange(PriceGuard.Kind.SecondarySource, api3Key, _word(api3));
        vm.stopPrank();
    }

    function test_AnExecutionChecksTheChangeAgain() public {
        PriceGuard g = _guard(DELAY);
        address next = _sentinel("nextAnchor");
        vm.prank(owner);
        g.proposeChange(PriceGuard.Kind.EthNumeraireFeed, bytes32(0), _word(next));
        vm.etch(next, "");
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NotAContract.selector, PriceGuard.Kind.EthNumeraireFeed, next));
        g.executeChange(PriceGuard.Kind.EthNumeraireFeed, bytes32(0));
    }

    // ─── Cancel ──────────────────────────────────────────────────────────

    function test_TheOwnerOrTheGuardianMayCancel() public {
        PriceGuard g = _guard(DELAY);
        bytes32 v = bytes32(uint256(600));
        vm.prank(owner);
        g.proposeChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0), v);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NotOwnerOrGuardian.selector, stranger));
        g.cancelChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0));

        vm.expectEmit(address(g));
        emit PriceGuard.ChangeCancelled(PriceGuard.Kind.PythMaxStaleness, bytes32(0), guardian);
        vm.prank(guardian);
        g.cancelChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0));

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NothingPending.selector, PriceGuard.Kind.PythMaxStaleness, bytes32(0)));
        g.executeChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0));
        assertEq(g.pythMaxStaleness(), 300, "cancelled change never applied");

        // The entry is free again, and the owner may cancel too.
        vm.startPrank(owner);
        g.proposeChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0), v);
        g.cancelChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NothingPending.selector, PriceGuard.Kind.PythMaxStaleness, bytes32(0)));
        g.cancelChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0));
        vm.stopPrank();
    }

    // ─── The delay itself ────────────────────────────────────────────────

    function test_RaisingTheDelayIsInstantAndOnlyUpward() public {
        PriceGuard g = _guard(DELAY);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        g.raiseDelay(7 days);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.DelayOutOfRange.selector, DELAY, DELAY + 1, 14 days));
        g.raiseDelay(DELAY);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.DelayOutOfRange.selector, 15 days, 0, 14 days));
        g.raiseDelay(15 days);
        vm.expectEmit(address(g));
        emit PriceGuard.DelaySet(DELAY, 7 days);
        g.raiseDelay(7 days);
        vm.stopPrank();
        assertEq(g.delay(), 7 days);
    }

    function test_LoweringTheDelayWaitsTheCurrentDelay() public {
        PriceGuard g = _guard(7 days);
        vm.startPrank(owner);
        // A raise goes through raiseDelay, never the queue.
        bytes32 up = bytes32(uint256(10 days));
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.InvalidChange.selector, PriceGuard.Kind.Delay, bytes32(0), up));
        g.proposeChange(PriceGuard.Kind.Delay, bytes32(0), up);
        // The delay is one entry: a subject would queue a second lowering.
        bytes32 down = bytes32(uint256(DELAY));
        vm.expectRevert(
            abi.encodeWithSelector(PriceGuard.InvalidChange.selector, PriceGuard.Kind.Delay, bytes32(uint256(1)), down)
        );
        g.proposeChange(PriceGuard.Kind.Delay, bytes32(uint256(1)), down);
        g.proposeChange(PriceGuard.Kind.Delay, bytes32(0), down);
        vm.stopPrank();
        (, uint256 at) = g.pendingChange(PriceGuard.Kind.Delay, bytes32(0));
        assertEq(at, block.timestamp + 7 days);
        vm.warp(at);
        vm.expectEmit(address(g));
        emit PriceGuard.DelaySet(7 days, DELAY);
        g.executeChange(PriceGuard.Kind.Delay, bytes32(0));
        assertEq(g.delay(), DELAY);
    }

    function test_AChangeKeepsTheDelaySetWhenItWasProposed() public {
        PriceGuard g = _guard(DELAY);
        vm.startPrank(owner);
        g.proposeChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0), bytes32(uint256(600)));
        g.raiseDelay(10 days);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        g.executeChange(PriceGuard.Kind.PythMaxStaleness, bytes32(0));
        assertEq(g.pythMaxStaleness(), 600);
    }

    // ─── The guardian's lever ────────────────────────────────────────────

    function test_DisablingASecondaryIsInstantAndReEnablingWaits() public {
        PriceGuard g = _guard(DELAY);
        bytes32 tellorKey = bytes32(uint256(PriceGuard.Source.Tellor));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NotOwnerOrGuardian.selector, stranger));
        g.disableSecondary(PriceGuard.Source.Tellor);

        vm.expectEmit(address(g));
        emit PriceGuard.SecondaryDisabled(PriceGuard.Source.Tellor, guardian);
        vm.prank(guardian);
        g.disableSecondary(PriceGuard.Source.Tellor);
        assertTrue(g.secondaryDisabled(PriceGuard.Source.Tellor));
        // A second disable is a no-op, not a revert.
        vm.prank(owner);
        g.disableSecondary(PriceGuard.Source.Tellor);

        // The guardian has no way back: re-enabling is the owner's, delayed.
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        g.proposeChange(PriceGuard.Kind.SecondaryEnabled, tellorKey, bytes32(uint256(1)));
        vm.prank(owner);
        g.proposeChange(PriceGuard.Kind.SecondaryEnabled, tellorKey, bytes32(uint256(1)));
        assertTrue(g.secondaryDisabled(PriceGuard.Source.Tellor), "still off while it waits");
        vm.warp(block.timestamp + DELAY);
        g.executeChange(PriceGuard.Kind.SecondaryEnabled, tellorKey);
        assertFalse(g.secondaryDisabled(PriceGuard.Source.Tellor));
        // The address was kept: re-enabling restores the same source.
        assertEq(g.secondarySource(PriceGuard.Source.Tellor), tellor);
    }

    /// @dev Stop-only, measured on a price: a source that contradicts the
    ///      primary makes the price Divergent; disabling it leaves the quorum
    ///      with no source, which accepts the primary. No price is introduced.
    function test_ADisabledSecondaryLeavesTheQuorum() public {
        PriceGuard g = _guard(DELAY);
        _arrangeDirectPrice(10e8);
        _tellorSays(20e18); // twice the primary

        (IPriceGuard.PriceStatus st,,) = g.getAssetPriceStatus(asset);
        assertEq(uint8(st), uint8(IPriceGuard.PriceStatus.Divergent), "contradicted");
        vm.expectRevert(IPriceGuard.OraclePriceDivergence.selector);
        g.getAssetPrice(asset);

        vm.prank(guardian);
        g.disableSecondary(PriceGuard.Source.Tellor);
        uint256 price;
        uint8 dec;
        (st, price, dec) = g.getAssetPriceStatus(asset);
        assertEq(uint8(st), uint8(IPriceGuard.PriceStatus.Priced), "the primary stands");
        assertEq(price, 10e8, "the primary's own figure");
        assertEq(dec, 8);
        (uint8 agreeing, uint8 disagreeing) = g.countLiveSecondaryOracleFeeds(asset);
        assertEq(agreeing + disagreeing, 0, "a disabled source is not live");
    }

    /// @dev A sequencer feed that reports a start time in the future is
    ///      read as down, never left to underflow.
    function test_ASequencerStartingInTheFutureIsDown() public {
        address seq = _sentinel("sequencer");
        PriceGuard.Change[] memory c = new PriceGuard.Change[](3);
        c[0] = _change(PriceGuard.Kind.FeedRegistry, 0, registry);
        c[1] = _change(PriceGuard.Kind.EthNumeraireFeed, 0, anchor);
        c[2] = _change(PriceGuard.Kind.SequencerFeed, 0, seq);
        PriceGuard g = _new(owner, guardian, _identity(), DELAY, c);
        _arrangeDirectPrice(10e8);
        uint256 future = block.timestamp + 1;
        vm.mockCall(
            seq, abi.encodeWithSignature("latestRoundData()"), abi.encode(uint80(1), int256(0), future, future, uint80(1))
        );
        assertFalse(g.sequencerHealthy());
        vm.expectRevert(IPriceGuard.SequencerDown.selector);
        g.getAssetPrice(asset);
        (IPriceGuard.PriceStatus st,,) = g.getAssetPriceStatus(asset);
        assertEq(uint8(st), uint8(IPriceGuard.PriceStatus.Unavailable));
    }

    // ─── Guardian and owner ──────────────────────────────────────────────

    function test_TheOwnerSetsTheGuardianAndCannotRenounce() public {
        PriceGuard g = _guard(DELAY);
        address next = makeAddr("nextSafe");
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        g.setGuardian(next);
        vm.startPrank(owner);
        vm.expectRevert(PriceGuard.ZeroAddress.selector);
        g.setGuardian(address(0));
        vm.expectEmit(address(g));
        emit PriceGuard.GuardianSet(guardian, next);
        g.setGuardian(next);
        vm.expectRevert(PriceGuard.RenounceDisabled.selector);
        g.renounceOwnership();
        vm.stopPrank();
        assertEq(g.guardian(), next);
    }

    function test_OwnershipMovesInTwoSteps() public {
        PriceGuard g = _guard(DELAY);
        address next = makeAddr("nextTimelock");
        vm.prank(owner);
        g.transferOwnership(next);
        assertEq(g.owner(), owner, "not until accepted");
        vm.prank(next);
        g.acceptOwnership();
        assertEq(g.owner(), next);
    }

    // ─── Entry checks ────────────────────────────────────────────────────

    function test_EveryEntryIsChecked() public {
        PriceGuard g = _guard(DELAY);
        address eoa = makeAddr("eoa");
        bytes32 big = bytes32(uint256(type(uint160).max) + 1);

        // A single entry takes no subject.
        _refuse(g, PriceGuard.Kind.PythMaxStaleness, bytes32(uint256(1)), bytes32(uint256(600)));
        // Ranges.
        _refuseU(g, PriceGuard.Kind.PythMaxStaleness, 59);
        _refuseU(g, PriceGuard.Kind.PythMaxStaleness, 3601);
        _refuseU(g, PriceGuard.Kind.PythMaxDeviationBps, 99);
        _refuseU(g, PriceGuard.Kind.PythMaxDeviationBps, 2001);
        _refuseU(g, PriceGuard.Kind.PythConfidenceMaxBps, 49);
        _refuseU(g, PriceGuard.Kind.PythConfidenceMaxBps, 501);
        _refuseU(g, PriceGuard.Kind.SecondaryMaxDeviationBps, 99);
        _refuseU(g, PriceGuard.Kind.SecondaryMaxDeviationBps, 2001);
        _refuseU(g, PriceGuard.Kind.SecondaryMaxStaleness, 59);
        _refuseU(g, PriceGuard.Kind.SecondaryMaxStaleness, 29 hours + 1);
        // A per-feed override is keyed by a contract and only tightens.
        _refuse(g, PriceGuard.Kind.FeedMaxStaleness, _word(directFeed), bytes32(uint256(25 hours + 1)));
        _refuse(g, PriceGuard.Kind.FeedMaxStaleness, bytes32(0), bytes32(uint256(1 hours)));
        _refuseNotAContract(g, PriceGuard.Kind.FeedMinAnswer, _word(eoa), bytes32(uint256(1)), eoa);
        // The load-bearing feeds cannot be unset, and must be contracts.
        _refuse(g, PriceGuard.Kind.FeedRegistry, bytes32(0), bytes32(0));
        _refuse(g, PriceGuard.Kind.EthNumeraireFeed, bytes32(0), bytes32(0));
        _refuseNotAContract(g, PriceGuard.Kind.FeedRegistry, bytes32(0), _word(eoa), eoa);
        _refuse(g, PriceGuard.Kind.SequencerFeed, bytes32(0), big);
        _refuseNotAContract(g, PriceGuard.Kind.Weth, bytes32(0), _word(eoa), eoa);
        // Keyed sources and symbols.
        _refuse(g, PriceGuard.Kind.SecondarySource, bytes32(uint256(3)), _word(api3));
        _refuse(g, PriceGuard.Kind.SecondaryEnabled, bytes32(uint256(3)), bytes32(uint256(1)));
        _refuse(g, PriceGuard.Kind.SecondaryEnabled, bytes32(0), bytes32(uint256(2)));
        _refuse(g, PriceGuard.Kind.StableRef, bytes32(0), _word(directFeed));
        _refuse(g, PriceGuard.Kind.StableRef, bytes32("ABCDEFGHIJK"), _word(directFeed));
        // A direct asset feed is industrial-only: on retail it would be dead config.
        _refuse(g, PriceGuard.Kind.AssetDirectFeed, _word(asset), _word(directFeed));

        // Zero turns the optional feeds off.
        vm.startPrank(owner);
        g.proposeChange(PriceGuard.Kind.SequencerFeed, bytes32(0), bytes32(0));
        g.proposeChange(PriceGuard.Kind.Weth, bytes32(0), bytes32(0));
        g.proposeChange(PriceGuard.Kind.SecondarySource, bytes32(uint256(PriceGuard.Source.Tellor)), bytes32(0));
        g.proposeChange(PriceGuard.Kind.PythFeedId, bytes32(0), keccak256("any id"));
        vm.stopPrank();
    }

    function test_AnIndustrialGuardTakesDirectAssetFeeds() public {
        PriceGuard.Identity memory id = _identity();
        id.numeraireDenominator = address(978);
        id.numeraireSymbol = bytes32("eur");
        id.padDenominator = usd;
        PriceGuard.Change[] memory c = new PriceGuard.Change[](3);
        c[0] = _change(PriceGuard.Kind.FeedRegistry, 0, registry);
        c[1] = _change(PriceGuard.Kind.EthNumeraireFeed, 0, anchor);
        c[2] = PriceGuard.Change(PriceGuard.Kind.AssetDirectFeed, _word(asset), _word(directFeed));
        PriceGuard g = _new(owner, guardian, id, DELAY, c);
        assertFalse(g.padIsNumeraire());
        assertEq(g.assetDirectFeed(asset), directFeed);
        _refuse(g, PriceGuard.Kind.AssetDirectFeed, bytes32(0), _word(directFeed));
    }

    function test_StableReferencesAreCapped() public {
        PriceGuard.Change[] memory c = new PriceGuard.Change[](18);
        c[0] = _change(PriceGuard.Kind.FeedRegistry, 0, registry);
        c[1] = _change(PriceGuard.Kind.EthNumeraireFeed, 0, anchor);
        for (uint256 i; i < 16; ++i) {
            c[2 + i] = PriceGuard.Change(
                PriceGuard.Kind.StableRef, bytes32(bytes2(uint16(0x4130 + i))), _word(_sentinel(vm.toString(i)))
            );
        }
        PriceGuard g = _new(owner, guardian, _identity(), 0, c);
        assertEq(g.stableRefSymbols().length, 16);

        vm.prank(owner);
        g.proposeChange(PriceGuard.Kind.StableRef, bytes32("XAU"), _word(directFeed));
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.TooManyStableRefs.selector, 16));
        g.executeChange(PriceGuard.Kind.StableRef, bytes32("XAU"));

        // Removing one frees a slot.
        bytes32 first = bytes32(bytes2(uint16(0x4130)));
        vm.startPrank(owner);
        g.cancelChange(PriceGuard.Kind.StableRef, bytes32("XAU"));
        g.proposeChange(PriceGuard.Kind.StableRef, first, bytes32(0));
        vm.stopPrank();
        g.executeChange(PriceGuard.Kind.StableRef, first);
        assertEq(g.stableRefSymbols().length, 15);
        assertEq(g.stableRefFeed(first), address(0));
        vm.prank(owner);
        g.proposeChange(PriceGuard.Kind.StableRef, bytes32("XAU"), _word(directFeed));
        g.executeChange(PriceGuard.Kind.StableRef, bytes32("XAU"));
        assertEq(g.stableRefSymbols().length, 16);
    }

    /// @dev Whatever the timing, a change applies exactly when its delay has
    ///      passed and never before.
    function testFuzz_AChangeAppliesOnlyOnceItsDelayHasPassed(uint64 delay_, uint64 wait, uint16 bps) public {
        delay_ = uint64(bound(delay_, 1 days, 14 days));
        wait = uint64(bound(wait, 0, 20 days));
        bps = uint16(bound(bps, 100, 2000));
        vm.chainId(1);
        PriceGuard g = _guard(delay_);
        vm.prank(owner);
        g.proposeChange(PriceGuard.Kind.SecondaryMaxDeviationBps, bytes32(0), bytes32(uint256(bps)));
        vm.warp(block.timestamp + wait);
        if (wait < delay_) {
            vm.expectRevert();
            g.executeChange(PriceGuard.Kind.SecondaryMaxDeviationBps, bytes32(0));
            assertEq(g.secondaryMaxDeviationBps(), 500);
        } else {
            g.executeChange(PriceGuard.Kind.SecondaryMaxDeviationBps, bytes32(0));
            assertEq(g.secondaryMaxDeviationBps(), bps);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _guard(uint64 delay_) internal returns (PriceGuard) {
        PriceGuard.Change[] memory c = new PriceGuard.Change[](5);
        c[0] = _change(PriceGuard.Kind.FeedRegistry, 0, registry);
        c[1] = _change(PriceGuard.Kind.EthNumeraireFeed, 0, anchor);
        c[2] = _change(PriceGuard.Kind.SecondarySource, uint256(PriceGuard.Source.Tellor), tellor);
        c[3] = _change(PriceGuard.Kind.SecondarySource, uint256(PriceGuard.Source.Api3), api3);
        c[4] = _change(PriceGuard.Kind.Weth, 0, weth);
        return _new(owner, guardian, _identity(), delay_, c);
    }

    /// @dev Deployed from its artifact (#2789), so the guard's creation code
    ///      is not compiled into this suite.
    function _new(
        address owner_,
        address guardian_,
        PriceGuard.Identity memory id,
        uint64 delay_,
        PriceGuard.Change[] memory c
    ) internal returns (PriceGuard) {
        return PriceGuard(
            ArtifactDeploy.deploy(type(PriceGuard).name, abi.encode(owner_, guardian_, id, delay_, c))
        );
    }

    function _identity() internal view returns (PriceGuard.Identity memory) {
        return PriceGuard.Identity({
            numeraireDenominator: usd,
            numeraireSymbol: bytes32("usd"),
            padDenominator: address(0),
            ethDenominator: ethDenom
        });
    }

    function _arrangeDirectPrice(int256 answer) internal {
        vm.mockCall(registry, abi.encodeWithSignature("getFeed(address,address)", asset, usd), abi.encode(directFeed));
        vm.mockCall(registry, abi.encodeCall(IFeedRegistryPairBase.pairBase, (asset, usd)), abi.encode(bytes32("LINK")));
        vm.mockCall(
            directFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), answer, block.timestamp - 60, block.timestamp - 60, uint80(1))
        );
        vm.mockCall(directFeed, abi.encodeWithSignature("decimals()"), abi.encode(uint8(8)));
        // API3 is configured but answers nothing, so only Tellor speaks.
        vm.mockCallRevert(api3, bytes(""), bytes("down"));
    }

    function _tellorSays(uint256 at18) internal {
        vm.mockCall(
            tellor,
            abi.encodePacked(ITellor.getDataBefore.selector),
            abi.encode(abi.encode(at18), block.timestamp - 30 minutes)
        );
    }

    function _refuseU(PriceGuard g, PriceGuard.Kind kind, uint256 value) internal {
        _refuse(g, kind, bytes32(0), bytes32(value));
    }

    function _refuse(PriceGuard g, PriceGuard.Kind kind, bytes32 subject, bytes32 value) internal {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.InvalidChange.selector, kind, subject, value));
        g.proposeChange(kind, subject, value);
    }

    function _refuseNotAContract(PriceGuard g, PriceGuard.Kind kind, bytes32 subject, bytes32 value, address a)
        internal
    {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceGuard.NotAContract.selector, kind, a));
        g.proposeChange(kind, subject, value);
    }

    function _sentinel(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.etch(a, hex"00");
    }

    function _word(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _change(PriceGuard.Kind kind, uint256 subject, address value)
        internal
        pure
        returns (PriceGuard.Change memory)
    {
        return PriceGuard.Change(kind, bytes32(subject), _word(value));
    }

    function _changeU(PriceGuard.Kind kind, uint256 value) internal pure returns (PriceGuard.Change memory) {
        return PriceGuard.Change(kind, bytes32(0), bytes32(value));
    }
}
