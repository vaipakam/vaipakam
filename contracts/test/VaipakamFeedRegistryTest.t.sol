// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamFeedRegistry} from "../src/oracle/VaipakamFeedRegistry.sol";

/// @dev A Chainlink feed stand-in with a description, decimals and a
///      settable answer and update time.
contract RegistryFeedStub {
    string public description;
    uint8 public decimals;
    int256 public answer = 2000e8;
    uint256 public updatedAt;

    constructor(string memory d, uint8 dec) {
        description = d;
        decimals = dec;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @dev A feed whose `description()` returns a string whose length word
///      points past the returned data.
contract MalformedDescriptionFeed {
    uint8 public decimals = 8;

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 1e8, block.timestamp, block.timestamp, 1);
    }

    fallback() external {
        // description(): offset 32, length 1000, then one word of data.
        assembly {
            mstore(0, 32)
            mstore(32, 1000)
            mstore(64, 0x4c494e4b202f2055534400000000000000000000000000000000000000000000)
            return(0, 96)
        }
    }
}

contract RegistryTokenStub {
    uint8 public decimals = 18;
}

contract VaipakamFeedRegistryTest is Test {
    address internal constant USD = 0x0000000000000000000000000000000000000348;
    address internal constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address internal constant OWNER = address(0xA11CE);
    address internal constant SAFE = address(0x5AFE);
    address internal constant BOT = address(0xB07);
    bytes32 internal constant DIR = keccak256("directory");
    uint32 internal constant DIR_DATE = 20261026;

    VaipakamFeedRegistry internal reg;
    address internal link;
    RegistryFeedStub internal linkUsd;

    function setUp() public {
        vm.chainId(8453); // a production chain: the 1-14 day delay applies
        vm.warp(1_800_000_000);
        reg = new VaipakamFeedRegistry(OWNER, SAFE);
        vm.prank(OWNER);
        reg.setProposer(BOT, true);
        link = address(new RegistryTokenStub());
        linkUsd = new RegistryFeedStub("LINK / USD", 8);
    }

    function _change(address base, address quote, address expected, address feed, string memory pair)
        internal
        pure
        returns (VaipakamFeedRegistry.Change[] memory cs)
    {
        cs = new VaipakamFeedRegistry.Change[](1);
        cs[0] = VaipakamFeedRegistry.Change({
            base: base,
            quote: quote,
            expectedFeed: expected,
            feed: feed,
            feedDecimals: 8,
            category: VaipakamFeedRegistry.Category.Low,
            heartbeat: 86400,
            pair: pair
        });
    }

    function _proposeAndExecute(VaipakamFeedRegistry.Change[] memory cs) internal returns (uint256 id) {
        vm.prank(BOT);
        id = reg.propose(cs, DIR, DIR_DATE);
        vm.warp(block.timestamp + reg.DEFAULT_DELAY());
        // The feed must still be live when the change takes effect.
        for (uint256 i; i < cs.length; ++i) {
            if (cs[i].feed != address(0)) RegistryFeedStub(cs[i].feed).set(2000e8, block.timestamp);
        }
        reg.execute(id, cs);
    }

    function test_AddThenGetFeed() public {
        assertEq(reg.getFeed(link, USD), address(0), "nothing before");
        _proposeAndExecute(_change(link, USD, address(0), address(linkUsd), "LINK / USD"));
        assertEq(reg.getFeed(link, USD), address(linkUsd));
        VaipakamFeedRegistry.Entry memory e = reg.entry(link, USD);
        assertEq(e.pair, "LINK / USD");
        assertEq(e.directorySha256, DIR);
        assertEq(e.directoryDate, DIR_DATE);
        assertEq(reg.entryCount(), 1);
        (address[] memory b, address[] memory q,) = reg.entriesPage(0, 10);
        assertEq(b[0], link);
        assertEq(q[0], USD);
    }

    function test_NothingTakesEffectBeforeTheDelay() public {
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        vm.prank(BOT);
        uint256 id = reg.propose(cs, DIR, DIR_DATE);
        vm.warp(block.timestamp + reg.DEFAULT_DELAY() - 1);
        vm.expectRevert();
        reg.execute(id, cs);
    }

    function test_GuardianVetoStopsIt() public {
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        vm.prank(BOT);
        uint256 id = reg.propose(cs, DIR, DIR_DATE);
        vm.prank(SAFE);
        reg.veto(id);
        vm.warp(block.timestamp + reg.DEFAULT_DELAY());
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamFeedRegistry.ProposalNotPending.selector, id, VaipakamFeedRegistry.State.Vetoed
            )
        );
        reg.execute(id, cs);
    }

    function test_OnlyGuardianOrOwnerVetoes() public {
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        vm.prank(BOT);
        uint256 id = reg.propose(cs, DIR, DIR_DATE);
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(VaipakamFeedRegistry.NotGuardianOrOwner.selector, BOT));
        reg.veto(id);
    }

    function test_EthQuotedFeedCannotBeFiledAsUsd() public {
        RegistryFeedStub linkEth = new RegistryFeedStub("LINK / ETH", 8);
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkEth), "LINK / ETH");
        vm.prank(BOT);
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamFeedRegistry.PairQuoteMismatch.selector, 0, "LINK / ETH", "USD")
        );
        reg.propose(cs, DIR, DIR_DATE);
    }

    function test_DescriptionMustMatch() public {
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "UNI / USD");
        vm.prank(BOT);
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamFeedRegistry.FeedDescriptionMismatch.selector, 0, address(linkUsd))
        );
        reg.propose(cs, DIR, DIR_DATE);
    }

    function test_MalformedDescriptionReadsAsMismatchNotRevert() public {
        address bad = address(new MalformedDescriptionFeed());
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), bad, "LINK / USD");
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(VaipakamFeedRegistry.FeedDescriptionMismatch.selector, 0, bad));
        reg.propose(cs, DIR, DIR_DATE);
    }

    function test_DecimalsMustMatch() public {
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        cs[0].feedDecimals = 18;
        vm.prank(BOT);
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamFeedRegistry.FeedDecimalsMismatch.selector, 0, address(linkUsd), 18)
        );
        reg.propose(cs, DIR, DIR_DATE);
    }

    function test_StaleFeedRefused() public {
        linkUsd.set(2000e8, block.timestamp - 86401);
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(VaipakamFeedRegistry.FeedNotLive.selector, 0, address(linkUsd)));
        reg.propose(cs, DIR, DIR_DATE);
    }

    function test_FeedThatWentStaleDuringTheDelayDoesNotExecute() public {
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        vm.prank(BOT);
        uint256 id = reg.propose(cs, DIR, DIR_DATE);
        vm.warp(block.timestamp + reg.DEFAULT_DELAY()); // feed not updated since
        vm.expectRevert(abi.encodeWithSelector(VaipakamFeedRegistry.FeedNotLive.selector, 0, address(linkUsd)));
        reg.execute(id, cs);
    }

    function test_TokenMustBeAContract() public {
        VaipakamFeedRegistry.Change[] memory cs =
            _change(address(0xBEEF), USD, address(0), address(linkUsd), "LINK / USD");
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(VaipakamFeedRegistry.TokenNotReadable.selector, 0, address(0xBEEF)));
        reg.propose(cs, DIR, DIR_DATE);
    }

    function test_ProposerLimitedToLowAndMedium_OwnerMayAddHigh() public {
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        cs[0].category = VaipakamFeedRegistry.Category.High;
        vm.prank(BOT);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamFeedRegistry.CategoryNeedsOwner.selector, 0, VaipakamFeedRegistry.Category.High
            )
        );
        reg.propose(cs, DIR, DIR_DATE);
        vm.prank(OWNER);
        uint256 id = reg.propose(cs, DIR, DIR_DATE);
        vm.warp(block.timestamp + reg.DEFAULT_DELAY());
        linkUsd.set(2000e8, block.timestamp);
        reg.execute(id, cs);
        assertEq(uint8(reg.entry(link, USD).category), uint8(VaipakamFeedRegistry.Category.High));
    }

    function test_StaleProposalCannotOverwriteANewerEntry() public {
        VaipakamFeedRegistry.Change[] memory first = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        vm.prank(BOT);
        uint256 a = reg.propose(first, DIR, DIR_DATE);
        vm.prank(BOT);
        uint256 b = reg.propose(first, DIR, DIR_DATE);
        vm.warp(block.timestamp + reg.DEFAULT_DELAY());
        linkUsd.set(2000e8, block.timestamp);
        reg.execute(a, first);
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamFeedRegistry.ExpectedFeedMismatch.selector, 0, address(0), address(linkUsd)
            )
        );
        reg.execute(b, first);
    }

    function test_ReplaceAndRemoveWaitTheDelayToo() public {
        _proposeAndExecute(_change(link, USD, address(0), address(linkUsd), "LINK / USD"));
        RegistryFeedStub successor = new RegistryFeedStub("LINK / USD", 8);
        _proposeAndExecute(_change(link, USD, address(linkUsd), address(successor), "LINK / USD"));
        assertEq(reg.getFeed(link, USD), address(successor));

        VaipakamFeedRegistry.Change[] memory rm = _change(link, USD, address(successor), address(0), "");
        vm.prank(BOT);
        uint256 id = reg.propose(rm, DIR, DIR_DATE);
        assertEq(reg.getFeed(link, USD), address(successor), "a removal waits like any change");
        vm.warp(block.timestamp + reg.DEFAULT_DELAY());
        reg.execute(id, rm);
        assertEq(reg.getFeed(link, USD), address(0));
        assertEq(reg.entryCount(), 0);
    }

    function test_RemovingTheProposerVoidsItsPendingProposals() public {
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        vm.prank(BOT);
        uint256 id = reg.propose(cs, DIR, DIR_DATE);
        vm.prank(OWNER);
        reg.setProposer(BOT, false);
        vm.warp(block.timestamp + reg.DEFAULT_DELAY());
        linkUsd.set(2000e8, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(VaipakamFeedRegistry.ProposerRemoved.selector, id, BOT));
        reg.execute(id, cs);
    }

    function test_ExecuteNeedsTheProposedListExactly() public {
        VaipakamFeedRegistry.Change[] memory cs = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        vm.prank(BOT);
        uint256 id = reg.propose(cs, DIR, DIR_DATE);
        vm.warp(block.timestamp + reg.DEFAULT_DELAY());
        cs[0].heartbeat = 3600;
        vm.expectRevert(abi.encodeWithSelector(VaipakamFeedRegistry.ChangesMismatch.selector, id));
        reg.execute(id, cs);
    }

    function test_DelayBoundsOnProduction_ZeroAllowedOnTestnet() public {
        vm.startPrank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(VaipakamFeedRegistry.DelayOutOfRange.selector, 0, 1 days, 14 days));
        reg.setDelay(0);
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamFeedRegistry.DelayOutOfRange.selector, 15 days, 1 days, 14 days)
        );
        reg.setDelay(15 days);
        reg.setDelay(1 days);
        vm.stopPrank();

        vm.chainId(84532);
        VaipakamFeedRegistry t = new VaipakamFeedRegistry(OWNER, SAFE);
        vm.prank(OWNER);
        t.setDelay(0);
        assertEq(t.delay(), 0);
    }

    function test_DuplicatePairInOneBatchRefused() public {
        VaipakamFeedRegistry.Change[] memory cs = new VaipakamFeedRegistry.Change[](2);
        VaipakamFeedRegistry.Change[] memory one = _change(link, USD, address(0), address(linkUsd), "LINK / USD");
        cs[0] = one[0];
        cs[1] = one[0];
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(VaipakamFeedRegistry.DuplicatePair.selector, 1));
        reg.propose(cs, DIR, DIR_DATE);
    }

    function test_RenounceDisabled() public {
        vm.prank(OWNER);
        vm.expectRevert(VaipakamFeedRegistry.RenounceDisabled.selector);
        reg.renounceOwnership();
    }
}
