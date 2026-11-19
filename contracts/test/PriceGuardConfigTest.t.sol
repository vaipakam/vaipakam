// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {PriceGuardState} from "../src/oracle/PriceGuardState.sol";
import {ProtocolRegistry} from "../src/governance/ProtocolRegistry.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {IFeedRegistryPairBase} from "../src/interfaces/IFeedRegistryPairBase.sol";
import {ITellor} from "../src/interfaces/ITellor.sol";
import {IApi3ServerV1} from "../src/interfaces/IApi3ServerV1.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {PriceGuardDeployment} from "../script/lib/PriceGuardDeployment.sol";

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
        assertEq(g.secondarySource(PriceGuardState.Source.Tellor), tellor, "tellor");
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
        (, uint256 at) = g.pendingChange(PriceGuardState.Kind.FeedRegistry, bytes32(0));
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
        PriceGuardState.Change[] memory c = new PriceGuardState.Change[](1);
        c[0] = PriceGuardState.Change(PriceGuardState.Kind.Delay, bytes32(0), bytes32(uint256(1 days)));
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.InvalidChange.selector, c[0].kind, c[0].subject, c[0].value));
        _new(owner, guardian, _identity(), DELAY, c);

        c[0] = PriceGuardState.Change(PriceGuardState.Kind.SecondaryEnabled, bytes32(0), bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.InvalidChange.selector, c[0].kind, c[0].subject, c[0].value));
        _new(owner, guardian, _identity(), DELAY, c);
    }

    function test_ConstructorChecksTheStartingConfigLikeAnyChange() public {
        PriceGuardState.Change[] memory c = new PriceGuardState.Change[](1);
        address eoa = makeAddr("eoa");
        c[0] = _change(PriceGuardState.Kind.FeedRegistry, 0, eoa);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NotAContract.selector, PriceGuardState.Kind.FeedRegistry, eoa));
        _new(owner, guardian, _identity(), DELAY, c);

        c[0] = _changeU(PriceGuardState.Kind.SecondaryMaxDeviationBps, 50);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.InvalidChange.selector, c[0].kind, c[0].subject, c[0].value));
        _new(owner, guardian, _identity(), DELAY, c);
    }

    function test_ConstructorRefusesABadIdentityOrGuardian() public {
        PriceGuardState.Change[] memory none;
        vm.expectRevert(PriceGuardState.ZeroAddress.selector);
        _new(owner, address(0), _identity(), DELAY, none);

        PriceGuardState.Identity memory id = _identity();
        id.numeraireDenominator = address(0);
        vm.expectRevert(PriceGuardState.ZeroAddress.selector);
        _new(owner, guardian, id, DELAY, none);

        id = _identity();
        id.ethDenominator = address(0);
        vm.expectRevert(PriceGuardState.ZeroAddress.selector);
        _new(owner, guardian, id, DELAY, none);

        // The symbol keys the secondary queries in lower case.
        id = _identity();
        id.numeraireSymbol = bytes32("USD");
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.InvalidNumeraireSymbol.selector, bytes32("USD")));
        _new(owner, guardian, id, DELAY, none);

        id.numeraireSymbol = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.InvalidNumeraireSymbol.selector, bytes32(0)));
        _new(owner, guardian, id, DELAY, none);
    }

    // ─── Delay bounds ────────────────────────────────────────────────────

    /// @dev The production floor matches the vault code delay (owner
    ///      decision 2026-11-10): no price setting applies sooner than a vault
    ///      code change could.
    function test_AProductionChainHoldsTheDelayBetweenSevenAndFourteenDays() public {
        vm.chainId(1);
        PriceGuardState.Change[] memory none;
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.DelayOutOfRange.selector, 0, 7 days, 14 days));
        _new(owner, guardian, _identity(), 0, none);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.DelayOutOfRange.selector, 7 days - 1, 7 days, 14 days));
        _new(owner, guardian, _identity(), 7 days - 1, none);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.DelayOutOfRange.selector, 15 days, 7 days, 14 days));
        _new(owner, guardian, _identity(), 15 days, none);
        PriceGuard g = _new(owner, guardian, _identity(), 7 days, none);
        assertFalse(g.TESTNET());
        assertEq(g.MIN_DELAY(), 7 days);
        // #3540: a swap of the whole guard through the registry waits at
        // least as long as a change of one of the guard's own settings.
        ProtocolRegistry reg = new ProtocolRegistry(
            owner, guardian, 3 days, new bytes32[](0), new address[](0), new bytes32[](0), new address[](0)
        );
        assertEq(uint256(g.MIN_DELAY()), reg.PRICE_GUARD_MIN_DELAY(), "registry price-guard minimum");

        // Lowering below the floor is refused at proposal.
        vm.prank(owner);
        g.raiseDelay(10 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.DelayOutOfRange.selector, 3 days, 7 days, 14 days));
        g.proposeChange(PriceGuardState.Kind.Delay, bytes32(0), bytes32(uint256(3 days)));
    }

    function test_ATestnetMaySetNoDelay() public {
        vm.chainId(84532);
        PriceGuard g = _guard(0);
        assertTrue(g.TESTNET());
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0), bytes32(uint256(600)));
        g.executeChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0));
        assertEq(g.pythMaxStaleness(), 600);
    }

    // ─── Propose, wait, execute ──────────────────────────────────────────

    function test_AChangeWaitsTheDelayThenAnyoneMayExecuteIt() public {
        PriceGuard g = _guard(DELAY);
        address next = _sentinel("nextRegistry");
        bytes32 v = _word(next);
        uint256 at = block.timestamp + DELAY;

        vm.expectEmit(address(g));
        emit PriceGuardState.ChangeProposed(PriceGuardState.Kind.FeedRegistry, bytes32(0), v, at);
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.FeedRegistry, bytes32(0), v);
        (bytes32 pv, uint256 pat) = g.pendingChange(PriceGuardState.Kind.FeedRegistry, bytes32(0));
        assertEq(pv, v);
        assertEq(pat, at);

        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NotReady.selector, PriceGuardState.Kind.FeedRegistry, bytes32(0), at));
        g.executeChange(PriceGuardState.Kind.FeedRegistry, bytes32(0));
        assertEq(g.feedRegistry(), registry, "unchanged while it waits");

        vm.warp(at);
        vm.expectEmit(address(g));
        emit PriceGuardState.ConfigSet(PriceGuardState.Kind.FeedRegistry, bytes32(0), v);
        vm.prank(stranger);
        g.executeChange(PriceGuardState.Kind.FeedRegistry, bytes32(0));
        assertEq(g.feedRegistry(), next);
        (, pat) = g.pendingChange(PriceGuardState.Kind.FeedRegistry, bytes32(0));
        assertEq(pat, 0, "cleared");

        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NothingPending.selector, PriceGuardState.Kind.FeedRegistry, bytes32(0)));
        g.executeChange(PriceGuardState.Kind.FeedRegistry, bytes32(0));
    }

    function test_OnlyTheOwnerProposes() public {
        PriceGuard g = _guard(DELAY);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        g.proposeChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0), bytes32(uint256(600)));
    }

    function test_OneChangeWaitsPerEntry() public {
        PriceGuard g = _guard(DELAY);
        bytes32 tellorKey = bytes32(uint256(PriceGuardState.Source.Tellor));
        bytes32 api3Key = bytes32(uint256(PriceGuardState.Source.Api3));
        vm.startPrank(owner);
        g.proposeChange(PriceGuardState.Kind.SecondarySource, tellorKey, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.ChangePending.selector, PriceGuardState.Kind.SecondarySource, tellorKey));
        g.proposeChange(PriceGuardState.Kind.SecondarySource, tellorKey, _word(api3));
        // Another subject of the same kind is its own entry.
        g.proposeChange(PriceGuardState.Kind.SecondarySource, api3Key, _word(api3));
        vm.stopPrank();
    }

    function test_AnExecutionChecksTheChangeAgain() public {
        PriceGuard g = _guard(DELAY);
        address next = _sentinel("nextAnchor");
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.EthNumeraireFeed, bytes32(0), _word(next));
        vm.etch(next, "");
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NotAContract.selector, PriceGuardState.Kind.EthNumeraireFeed, next));
        g.executeChange(PriceGuardState.Kind.EthNumeraireFeed, bytes32(0));
    }

    // ─── Cancel ──────────────────────────────────────────────────────────

    function test_TheOwnerOrTheGuardianMayCancel() public {
        PriceGuard g = _guard(DELAY);
        bytes32 v = bytes32(uint256(600));
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0), v);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NotOwnerOrGuardian.selector, stranger));
        g.cancelChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0));

        vm.expectEmit(address(g));
        emit PriceGuardState.ChangeCancelled(PriceGuardState.Kind.PythMaxStaleness, bytes32(0), guardian);
        vm.prank(guardian);
        g.cancelChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0));

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NothingPending.selector, PriceGuardState.Kind.PythMaxStaleness, bytes32(0)));
        g.executeChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0));
        assertEq(g.pythMaxStaleness(), 300, "cancelled change never applied");

        // The entry is free again, and the owner may cancel too.
        vm.startPrank(owner);
        g.proposeChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0), v);
        g.cancelChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NothingPending.selector, PriceGuardState.Kind.PythMaxStaleness, bytes32(0)));
        g.cancelChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0));
        vm.stopPrank();
    }

    // ─── The delay itself ────────────────────────────────────────────────

    function test_RaisingTheDelayIsInstantAndOnlyUpward() public {
        PriceGuard g = _guard(DELAY);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        g.raiseDelay(7 days);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.DelayOutOfRange.selector, DELAY, DELAY + 1, 14 days));
        g.raiseDelay(DELAY);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.DelayOutOfRange.selector, 15 days, 0, 14 days));
        g.raiseDelay(15 days);
        vm.expectEmit(address(g));
        emit PriceGuardState.DelaySet(DELAY, 7 days);
        g.raiseDelay(7 days);
        vm.stopPrank();
        assertEq(g.delay(), 7 days);
    }

    function test_LoweringTheDelayWaitsTheCurrentDelay() public {
        PriceGuard g = _guard(7 days);
        vm.startPrank(owner);
        // A raise goes through raiseDelay, never the queue.
        bytes32 up = bytes32(uint256(10 days));
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.InvalidChange.selector, PriceGuardState.Kind.Delay, bytes32(0), up));
        g.proposeChange(PriceGuardState.Kind.Delay, bytes32(0), up);
        // The delay is one entry: a subject would queue a second lowering.
        bytes32 down = bytes32(uint256(DELAY));
        vm.expectRevert(
            abi.encodeWithSelector(PriceGuardState.InvalidChange.selector, PriceGuardState.Kind.Delay, bytes32(uint256(1)), down)
        );
        g.proposeChange(PriceGuardState.Kind.Delay, bytes32(uint256(1)), down);
        g.proposeChange(PriceGuardState.Kind.Delay, bytes32(0), down);
        vm.stopPrank();
        (, uint256 at) = g.pendingChange(PriceGuardState.Kind.Delay, bytes32(0));
        assertEq(at, block.timestamp + 7 days);
        vm.warp(at);
        vm.expectEmit(address(g));
        emit PriceGuardState.DelaySet(7 days, DELAY);
        g.executeChange(PriceGuardState.Kind.Delay, bytes32(0));
        assertEq(g.delay(), DELAY);
    }

    function test_AChangeKeepsTheDelaySetWhenItWasProposed() public {
        PriceGuard g = _guard(DELAY);
        vm.startPrank(owner);
        g.proposeChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0), bytes32(uint256(600)));
        g.raiseDelay(10 days);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        g.executeChange(PriceGuardState.Kind.PythMaxStaleness, bytes32(0));
        assertEq(g.pythMaxStaleness(), 600);
    }

    // ─── The guardian's lever (#3537) ────────────────────────────────────

    function test_MutingASecondaryIsInstantAndReEnablingWaits() public {
        PriceGuard g = _guard(DELAY);
        bytes32 tellorKey = bytes32(uint256(PriceGuardState.Source.Tellor));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NotOwnerOrGuardian.selector, stranger));
        g.muteSecondary(PriceGuardState.Source.Tellor);

        vm.expectEmit(address(g));
        emit PriceGuardState.SecondaryMuted(PriceGuardState.Source.Tellor, guardian);
        vm.prank(guardian);
        g.muteSecondary(PriceGuardState.Source.Tellor);
        assertEq(uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Muted));
        // A second mute is a no-op, not a revert.
        vm.prank(owner);
        g.muteSecondary(PriceGuardState.Source.Tellor);

        // The guardian has no way back: re-enabling is the owner's, delayed.
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        g.proposeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey, bytes32(uint256(1)));
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey, bytes32(uint256(1)));
        assertEq(
            uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Muted), "still muted while it waits"
        );
        vm.warp(block.timestamp + DELAY);
        g.executeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey);
        assertEq(uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Counted));
        // The address was kept: re-enabling restores the same source.
        assertEq(g.secondarySource(PriceGuardState.Source.Tellor), tellor);
    }

    /// @dev A stop cancels a pending re-enable, even one already due, so a
    ///      re-enable approved before the stop cannot undo it.
    function test_MutingASecondaryCancelsItsPendingReEnable() public {
        PriceGuard g = _guard(DELAY);
        bytes32 tellorKey = bytes32(uint256(PriceGuardState.Source.Tellor));
        vm.prank(guardian);
        g.muteSecondary(PriceGuardState.Source.Tellor);
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey, bytes32(uint256(1)));
        vm.warp(block.timestamp + DELAY);

        // Due, but a second stop while it is already muted still cancels it.
        vm.expectEmit(address(g));
        emit PriceGuardState.ChangeCancelled(PriceGuardState.Kind.SecondaryEnabled, tellorKey, guardian);
        vm.prank(guardian);
        g.muteSecondary(PriceGuardState.Source.Tellor);
        vm.expectRevert(
            abi.encodeWithSelector(PriceGuardState.NothingPending.selector, PriceGuardState.Kind.SecondaryEnabled, tellorKey)
        );
        g.executeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey);
        assertEq(uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Muted));

        // A removal proposal cancels a due re-enable the same way.
        bytes32 api3Key = bytes32(uint256(PriceGuardState.Source.Api3));
        vm.prank(guardian);
        g.muteSecondary(PriceGuardState.Source.Api3);
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.SecondaryEnabled, api3Key, bytes32(uint256(1)));
        vm.warp(block.timestamp + DELAY);
        vm.prank(guardian);
        g.proposeSecondaryRemoval(PriceGuardState.Source.Api3);
        (, uint256 at) = g.pendingChange(PriceGuardState.Kind.SecondaryEnabled, api3Key);
        assertEq(at, 0, "the removal proposal cancels the due re-enable");
    }

    /// @dev The issue's own case: a source that contradicts the primary keeps
    ///      the price refused after it is muted. Muting never accepts a price.
    function test_AMutedSecondaryStillRefusesAContradictedPrice() public {
        PriceGuard g = _guard(DELAY);
        _arrangeDirectPrice(10e8);
        _tellorSays(20e18); // twice the primary
        _assertDivergent(g, "contradicted");

        vm.prank(guardian);
        g.muteSecondary(PriceGuardState.Source.Tellor);
        _assertDivergent(g, "a muted source still refuses");
        (uint8 agreeing, uint8 disagreeing) = g.countLiveSecondaryOracleFeeds(asset);
        assertEq(agreeing, 0);
        assertEq(disagreeing, 1, "its disagreement still counts");
    }

    /// @dev Muting is the lever against a source that APPROVES a bad price:
    ///      once the agreeing source is muted, the other source's refusal wins.
    function test_MutingAnAgreeingSourceLetsTheOthersRefuse() public {
        PriceGuard g = _guard(DELAY);
        _arrangePrimary(10e8);
        _tellorSays(10e18); // agrees with the primary
        _api3Says(20e18); // contradicts it
        (IPriceGuard.PriceStatus st,,) = g.getAssetPriceStatus(asset);
        assertEq(uint8(st), uint8(IPriceGuard.PriceStatus.Priced), "one agreement accepts");

        vm.prank(guardian);
        g.muteSecondary(PriceGuardState.Source.Tellor);
        _assertDivergent(g, "the muted agreement no longer accepts");
        (uint8 agreeing, uint8 disagreeing) = g.countLiveSecondaryOracleFeeds(asset);
        assertEq(agreeing, 0, "a muted agreement is not counted");
        assertEq(disagreeing, 1);
    }

    /// @dev A muted source alone that agrees: the price reads as if no source
    ///      answered, which accepts the primary as before. Never stricter
    ///      than "no data", never looser than counted.
    function test_AMutedAgreementReadsAsNoData() public {
        PriceGuard g = _guard(DELAY);
        _arrangeDirectPrice(10e8);
        _tellorSays(10e18);
        vm.prank(guardian);
        g.muteSecondary(PriceGuardState.Source.Tellor);
        (IPriceGuard.PriceStatus st, uint256 price,) = g.getAssetPriceStatus(asset);
        assertEq(uint8(st), uint8(IPriceGuard.PriceStatus.Priced));
        assertEq(price, 10e8);
    }

    /// @dev Removing a source's refusals is the step that loosens, so it waits
    ///      {SECONDARY_REMOVAL_DELAY}; until then the contradicted price stays
    ///      refused.
    function test_RemovingASecondaryWaitsFortyEightHours() public {
        PriceGuard g = _guard(DELAY);
        _arrangeDirectPrice(10e8);
        _tellorSays(20e18);
        assertEq(g.SECONDARY_REMOVAL_DELAY(), 48 hours);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NotOwnerOrGuardian.selector, stranger));
        g.proposeSecondaryRemoval(PriceGuardState.Source.Tellor);

        uint256 at = block.timestamp + 48 hours;
        vm.expectEmit(address(g));
        emit PriceGuardState.SecondaryMuted(PriceGuardState.Source.Tellor, guardian);
        vm.expectEmit(address(g));
        emit PriceGuardState.SecondaryRemovalProposed(PriceGuardState.Source.Tellor, guardian, at);
        vm.prank(guardian);
        g.proposeSecondaryRemoval(PriceGuardState.Source.Tellor);
        assertEq(g.secondaryRemovalAt(PriceGuardState.Source.Tellor), at);
        assertEq(uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Muted));
        _assertDivergent(g, "still refused while the removal waits");

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.SecondaryRemovalPending.selector, PriceGuardState.Source.Tellor, at));
        g.proposeSecondaryRemoval(PriceGuardState.Source.Tellor);

        vm.warp(at - 1);
        _arrangeDirectPrice(10e8);
        _tellorSays(20e18);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.SecondaryRemovalNotReady.selector, PriceGuardState.Source.Tellor, at));
        g.executeSecondaryRemoval(PriceGuardState.Source.Tellor);

        vm.warp(at);
        _arrangeDirectPrice(10e8);
        _tellorSays(20e18);
        vm.expectEmit(address(g));
        emit PriceGuardState.SecondaryRemoved(PriceGuardState.Source.Tellor);
        vm.prank(stranger); // anyone may execute a due removal
        g.executeSecondaryRemoval(PriceGuardState.Source.Tellor);
        assertEq(uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Removed));
        assertEq(g.secondaryRemovalAt(PriceGuardState.Source.Tellor), 0);

        (IPriceGuard.PriceStatus st, uint256 price,) = g.getAssetPriceStatus(asset);
        assertEq(uint8(st), uint8(IPriceGuard.PriceStatus.Priced), "the primary stands once removed");
        assertEq(price, 10e8);
        (uint8 agreeing, uint8 disagreeing) = g.countLiveSecondaryOracleFeeds(asset);
        assertEq(agreeing + disagreeing, 0, "a removed source is not asked");

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.SecondaryAlreadyRemoved.selector, PriceGuardState.Source.Tellor));
        g.proposeSecondaryRemoval(PriceGuardState.Source.Tellor);
        // Muting a removed source changes nothing.
        vm.prank(guardian);
        g.muteSecondary(PriceGuardState.Source.Tellor);
        assertEq(uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Removed));
    }

    function test_TheOwnerOrTheGuardianMayCancelARemoval() public {
        PriceGuard g = _guard(DELAY);
        vm.prank(guardian);
        g.proposeSecondaryRemoval(PriceGuardState.Source.Tellor);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NotOwnerOrGuardian.selector, stranger));
        g.cancelSecondaryRemoval(PriceGuardState.Source.Tellor);

        vm.expectEmit(address(g));
        emit PriceGuardState.SecondaryRemovalCancelled(PriceGuardState.Source.Tellor, owner);
        vm.prank(owner);
        g.cancelSecondaryRemoval(PriceGuardState.Source.Tellor);
        assertEq(g.secondaryRemovalAt(PriceGuardState.Source.Tellor), 0);
        assertEq(
            uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Muted), "a cancel leaves it muted"
        );
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NoSecondaryRemovalPending.selector, PriceGuardState.Source.Tellor));
        g.executeSecondaryRemoval(PriceGuardState.Source.Tellor);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NoSecondaryRemovalPending.selector, PriceGuardState.Source.Tellor));
        g.cancelSecondaryRemoval(PriceGuardState.Source.Tellor);

        // The guardian may cancel too.
        vm.prank(owner);
        g.proposeSecondaryRemoval(PriceGuardState.Source.Tellor);
        vm.prank(guardian);
        g.cancelSecondaryRemoval(PriceGuardState.Source.Tellor);
        assertEq(g.secondaryRemovalAt(PriceGuardState.Source.Tellor), 0);
    }

    /// @dev Re-enabling counts a removed source again, and drops a removal
    ///      still waiting on a muted one.
    function test_ReEnablingRestoresARemovedSourceAndDropsAWaitingRemoval() public {
        PriceGuard g = _guard(DELAY);
        bytes32 tellorKey = bytes32(uint256(PriceGuardState.Source.Tellor));
        vm.prank(guardian);
        g.proposeSecondaryRemoval(PriceGuardState.Source.Tellor);
        vm.warp(block.timestamp + 48 hours);
        g.executeSecondaryRemoval(PriceGuardState.Source.Tellor);
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey, bytes32(uint256(1)));
        vm.warp(block.timestamp + DELAY);
        g.executeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey);
        assertEq(uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Counted));

        // A removal proposed while a re-enable waits cancels the re-enable.
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey, bytes32(uint256(1)));
        vm.warp(block.timestamp + DELAY - 1 hours);
        vm.prank(guardian);
        g.proposeSecondaryRemoval(PriceGuardState.Source.Tellor); // cancels the re-enable
        (, uint256 reEnableAt) = g.pendingChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey);
        assertEq(reEnableAt, 0);
        // A re-enable proposed while a removal waits, and executed before
        // anyone executes the removal, drops it.
        vm.prank(owner);
        g.cancelSecondaryRemoval(PriceGuardState.Source.Tellor);
        vm.prank(guardian);
        g.proposeSecondaryRemoval(PriceGuardState.Source.Tellor);
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey, bytes32(uint256(1)));
        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(address(g));
        emit PriceGuardState.SecondaryRemovalCancelled(PriceGuardState.Source.Tellor, address(this));
        g.executeChange(PriceGuardState.Kind.SecondaryEnabled, tellorKey);
        assertEq(uint8(g.secondaryState(PriceGuardState.Source.Tellor)), uint8(PriceGuardState.SecondaryState.Counted));
        assertEq(g.secondaryRemovalAt(PriceGuardState.Source.Tellor), 0);
    }

    /// @dev A sequencer feed that reports a start time in the future is
    ///      read as down, never left to underflow.
    function test_ASequencerStartingInTheFutureIsDown() public {
        address seq = _sentinel("sequencer");
        PriceGuardState.Change[] memory c = new PriceGuardState.Change[](3);
        c[0] = _change(PriceGuardState.Kind.FeedRegistry, 0, registry);
        c[1] = _change(PriceGuardState.Kind.EthNumeraireFeed, 0, anchor);
        c[2] = _change(PriceGuardState.Kind.SequencerFeed, 0, seq);
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
        vm.expectRevert(PriceGuardState.ZeroAddress.selector);
        g.setGuardian(address(0));
        vm.expectEmit(address(g));
        emit PriceGuardState.GuardianSet(guardian, next);
        g.setGuardian(next);
        vm.expectRevert(PriceGuardState.RenounceDisabled.selector);
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
        _refuse(g, PriceGuardState.Kind.PythMaxStaleness, bytes32(uint256(1)), bytes32(uint256(600)));
        // Ranges.
        _refuseU(g, PriceGuardState.Kind.PythMaxStaleness, 59);
        _refuseU(g, PriceGuardState.Kind.PythMaxStaleness, 3601);
        _refuseU(g, PriceGuardState.Kind.PythMaxDeviationBps, 99);
        _refuseU(g, PriceGuardState.Kind.PythMaxDeviationBps, 2001);
        _refuseU(g, PriceGuardState.Kind.PythConfidenceMaxBps, 49);
        _refuseU(g, PriceGuardState.Kind.PythConfidenceMaxBps, 501);
        _refuseU(g, PriceGuardState.Kind.SecondaryMaxDeviationBps, 99);
        _refuseU(g, PriceGuardState.Kind.SecondaryMaxDeviationBps, 2001);
        _refuseU(g, PriceGuardState.Kind.SecondaryMaxStaleness, 59);
        _refuseU(g, PriceGuardState.Kind.SecondaryMaxStaleness, 29 hours + 1);
        // A per-feed override is keyed by a contract and only tightens.
        _refuse(g, PriceGuardState.Kind.FeedMaxStaleness, _word(directFeed), bytes32(uint256(25 hours + 1)));
        _refuse(g, PriceGuardState.Kind.FeedMaxStaleness, bytes32(0), bytes32(uint256(1 hours)));
        _refuseNotAContract(g, PriceGuardState.Kind.FeedMinAnswer, _word(eoa), bytes32(uint256(1)), eoa);
        // The load-bearing feeds cannot be unset, and must be contracts.
        _refuse(g, PriceGuardState.Kind.FeedRegistry, bytes32(0), bytes32(0));
        _refuse(g, PriceGuardState.Kind.EthNumeraireFeed, bytes32(0), bytes32(0));
        _refuseNotAContract(g, PriceGuardState.Kind.FeedRegistry, bytes32(0), _word(eoa), eoa);
        _refuse(g, PriceGuardState.Kind.SequencerFeed, bytes32(0), big);
        _refuseNotAContract(g, PriceGuardState.Kind.Weth, bytes32(0), _word(eoa), eoa);
        // Keyed sources and symbols.
        _refuse(g, PriceGuardState.Kind.SecondarySource, bytes32(uint256(3)), _word(api3));
        _refuse(g, PriceGuardState.Kind.SecondaryEnabled, bytes32(uint256(3)), bytes32(uint256(1)));
        _refuse(g, PriceGuardState.Kind.SecondaryEnabled, bytes32(0), bytes32(uint256(2)));
        _refuse(g, PriceGuardState.Kind.StableRef, bytes32(0), _word(directFeed));
        _refuse(g, PriceGuardState.Kind.StableRef, bytes32("ABCDEFGHIJK"), _word(directFeed));
        // A direct asset feed is industrial-only: on retail it would be dead config.
        _refuse(g, PriceGuardState.Kind.AssetDirectFeed, _word(asset), _word(directFeed));

        // Zero turns the optional feeds off.
        vm.startPrank(owner);
        g.proposeChange(PriceGuardState.Kind.SequencerFeed, bytes32(0), bytes32(0));
        g.proposeChange(PriceGuardState.Kind.Weth, bytes32(0), bytes32(0));
        g.proposeChange(PriceGuardState.Kind.SecondarySource, bytes32(uint256(PriceGuardState.Source.Tellor)), bytes32(0));
        g.proposeChange(PriceGuardState.Kind.PythFeedId, bytes32(0), keccak256("any id"));
        vm.stopPrank();
    }

    function test_AnIndustrialGuardTakesDirectAssetFeeds() public {
        PriceGuardState.Identity memory id = _identity();
        id.numeraireDenominator = address(978);
        id.numeraireSymbol = bytes32("eur");
        id.padDenominator = usd;
        PriceGuardState.Change[] memory c = new PriceGuardState.Change[](3);
        c[0] = _change(PriceGuardState.Kind.FeedRegistry, 0, registry);
        c[1] = _change(PriceGuardState.Kind.EthNumeraireFeed, 0, anchor);
        c[2] = PriceGuardState.Change(PriceGuardState.Kind.AssetDirectFeed, _word(asset), _word(directFeed));
        PriceGuard g = _new(owner, guardian, id, DELAY, c);
        assertFalse(g.padIsNumeraire());
        assertEq(g.assetDirectFeed(asset), directFeed);
        _refuse(g, PriceGuardState.Kind.AssetDirectFeed, bytes32(0), _word(directFeed));
    }

    function test_StableReferencesAreCapped() public {
        PriceGuardState.Change[] memory c = new PriceGuardState.Change[](18);
        c[0] = _change(PriceGuardState.Kind.FeedRegistry, 0, registry);
        c[1] = _change(PriceGuardState.Kind.EthNumeraireFeed, 0, anchor);
        for (uint256 i; i < 16; ++i) {
            c[2 + i] = PriceGuardState.Change(
                PriceGuardState.Kind.StableRef, bytes32(bytes2(uint16(0x4130 + i))), _word(_sentinel(vm.toString(i)))
            );
        }
        PriceGuard g = _new(owner, guardian, _identity(), 0, c);
        assertEq(g.stableRefSymbols().length, 16);

        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.StableRef, bytes32("XAU"), _word(directFeed));
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.TooManyStableRefs.selector, 16));
        g.executeChange(PriceGuardState.Kind.StableRef, bytes32("XAU"));

        // Removing one frees a slot once no answered version can read it
        // (#3437): while an earlier version is still answered, it is kept.
        bytes32 first = bytes32(bytes2(uint16(0x4130)));
        vm.startPrank(owner);
        g.cancelChange(PriceGuardState.Kind.StableRef, bytes32("XAU"));
        g.proposeChange(PriceGuardState.Kind.StableRef, first, bytes32(0));
        vm.stopPrank();
        g.executeChange(PriceGuardState.Kind.StableRef, first);
        assertEq(g.stableRefSymbols().length, 15);
        assertEq(g.stableRefFeed(first), address(0));
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.StableRef, bytes32("XAU"), _word(directFeed));
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.TooManyStableRefs.selector, 16));
        g.executeChange(PriceGuardState.Kind.StableRef, bytes32("XAU"));

        // The sentinel registry has no code; give it an epoch so the guard can
        // name the current price version.
        vm.mockCall(registry, abi.encodeWithSignature("epoch()"), abi.encode(uint64(1)));
        (uint64 ge, uint64 re) = g.priceVersion();
        vm.startPrank(owner);
        g.cancelChange(PriceGuardState.Kind.StableRef, bytes32("XAU"));
        g.proposeChange(PriceGuardState.Kind.PriceFloor, 0, bytes32((uint256(ge) << 64) | re));
        vm.stopPrank();
        g.executeChange(PriceGuardState.Kind.PriceFloor, 0);
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.StableRef, bytes32("XAU"), _word(directFeed));
        g.executeChange(PriceGuardState.Kind.StableRef, bytes32("XAU"));
        assertEq(g.stableRefSymbols().length, 16);
    }

    /// @dev Whatever the timing, a change applies exactly when its delay has
    ///      passed and never before.
    function testFuzz_AChangeAppliesOnlyOnceItsDelayHasPassed(uint64 delay_, uint64 wait, uint16 bps) public {
        delay_ = uint64(bound(delay_, 7 days, 14 days));
        wait = uint64(bound(wait, 0, 20 days));
        bps = uint16(bound(bps, 100, 2000));
        vm.chainId(1);
        PriceGuard g = _guard(delay_);
        vm.prank(owner);
        g.proposeChange(PriceGuardState.Kind.SecondaryMaxDeviationBps, bytes32(0), bytes32(uint256(bps)));
        vm.warp(block.timestamp + wait);
        if (wait < delay_) {
            vm.expectRevert();
            g.executeChange(PriceGuardState.Kind.SecondaryMaxDeviationBps, bytes32(0));
            assertEq(g.secondaryMaxDeviationBps(), 500);
        } else {
            g.executeChange(PriceGuardState.Kind.SecondaryMaxDeviationBps, bytes32(0));
            assertEq(g.secondaryMaxDeviationBps(), bps);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _guard(uint64 delay_) internal returns (PriceGuard) {
        PriceGuardState.Change[] memory c = new PriceGuardState.Change[](5);
        c[0] = _change(PriceGuardState.Kind.FeedRegistry, 0, registry);
        c[1] = _change(PriceGuardState.Kind.EthNumeraireFeed, 0, anchor);
        c[2] = _change(PriceGuardState.Kind.SecondarySource, uint256(PriceGuardState.Source.Tellor), tellor);
        c[3] = _change(PriceGuardState.Kind.SecondarySource, uint256(PriceGuardState.Source.Api3), api3);
        c[4] = _change(PriceGuardState.Kind.Weth, 0, weth);
        return _new(owner, guardian, _identity(), delay_, c);
    }

    /// @dev Deployed from its artifact (#2789), so the guard's creation code
    ///      is not compiled into this suite.
    function _new(
        address owner_,
        address guardian_,
        PriceGuardState.Identity memory id,
        uint64 delay_,
        PriceGuardState.Change[] memory c
    ) internal returns (PriceGuard) {
        return PriceGuard(PriceGuardDeployment.build(owner_, guardian_, id, delay_, c));
    }

    function _identity() internal view returns (PriceGuardState.Identity memory) {
        return PriceGuardState.Identity({
            numeraireDenominator: usd,
            numeraireSymbol: bytes32("usd"),
            padDenominator: address(0),
            ethDenominator: ethDenom
        });
    }

    function _arrangeDirectPrice(int256 answer) internal {
        _arrangePrimary(answer);
        // API3 is configured but answers nothing, so only Tellor speaks.
        vm.mockCallRevert(api3, bytes(""), bytes("down"));
    }

    /// @dev The primary feed alone; the secondaries are left to the test.
    function _arrangePrimary(int256 answer) internal {
        vm.mockCall(registry, abi.encodeWithSignature("getFeed(address,address)", asset, usd), abi.encode(directFeed));
        vm.mockCall(registry, abi.encodeCall(IFeedRegistryPairBase.pairBase, (asset, usd)), abi.encode(bytes32("LINK")));
        vm.mockCall(
            directFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), answer, block.timestamp - 60, block.timestamp - 60, uint80(1))
        );
        vm.mockCall(directFeed, abi.encodeWithSignature("decimals()"), abi.encode(uint8(8)));
    }

    function _api3Says(uint256 at18) internal {
        vm.mockCall(
            api3,
            abi.encodePacked(IApi3ServerV1.readDataFeedWithDapiNameHash.selector),
            abi.encode(int224(int256(at18)), uint32(block.timestamp - 60))
        );
    }

    function _assertDivergent(PriceGuard g, string memory why) internal {
        (IPriceGuard.PriceStatus st,,) = g.getAssetPriceStatus(asset);
        assertEq(uint8(st), uint8(IPriceGuard.PriceStatus.Divergent), why);
        vm.expectRevert(IPriceGuard.OraclePriceDivergence.selector);
        g.getAssetPrice(asset);
    }

    function _tellorSays(uint256 at18) internal {
        vm.mockCall(
            tellor,
            abi.encodePacked(ITellor.getDataBefore.selector),
            abi.encode(abi.encode(at18), block.timestamp - 30 minutes)
        );
    }

    function _refuseU(PriceGuard g, PriceGuardState.Kind kind, uint256 value) internal {
        _refuse(g, kind, bytes32(0), bytes32(value));
    }

    function _refuse(PriceGuard g, PriceGuardState.Kind kind, bytes32 subject, bytes32 value) internal {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.InvalidChange.selector, kind, subject, value));
        g.proposeChange(kind, subject, value);
    }

    function _refuseNotAContract(PriceGuard g, PriceGuardState.Kind kind, bytes32 subject, bytes32 value, address a)
        internal
    {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PriceGuardState.NotAContract.selector, kind, a));
        g.proposeChange(kind, subject, value);
    }

    function _sentinel(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.etch(a, hex"00");
    }

    function _word(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _change(PriceGuardState.Kind kind, uint256 subject, address value)
        internal
        pure
        returns (PriceGuardState.Change memory)
    {
        return PriceGuardState.Change(kind, bytes32(subject), _word(value));
    }

    function _changeU(PriceGuardState.Kind kind, uint256 value) internal pure returns (PriceGuardState.Change memory) {
        return PriceGuardState.Change(kind, bytes32(0), bytes32(value));
    }
}
