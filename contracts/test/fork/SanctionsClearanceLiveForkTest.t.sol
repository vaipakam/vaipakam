// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {CcipMessenger} from "../../src/crosschain/CcipMessenger.sol";
import {SanctionsList} from "../../src/compliance/SanctionsList.sol";
import {SanctionsDelistingTimelock} from "../../src/compliance/SanctionsDelistingTimelock.sol";
import {
    SanctionsClearanceAttestor,
    SANCTIONS_CLEARANCE_WIRE_VERSION,
    CLEARANCE_RESPONSE
} from "../../src/compliance/SanctionsClearanceAttestor.sol";
import {TestnetSanctionsOracleStandIn} from "../../src/compliance/TestnetSanctionsOracleStandIn.sol";
import {ConfigureSanctionsClearance} from "../../script/ConfigureSanctionsClearance.s.sol";

/// @dev The one Router read this test needs: the inbound lanes it accepts.
interface ICcipRouterOffRamps {
    struct OffRamp {
        uint64 sourceChainSelector;
        address offRamp;
    }

    function getOffRamps() external view returns (OffRamp[] memory);
}

/**
 * @title  SanctionsClearanceLiveForkTest
 * @notice #2443 — the delisting timelock's CROSS-CHAIN clearance route proven
 *         on forks of the live testnets: a timelock on Base Sepolia or
 *         Arbitrum Sepolia sends a clearance request to the attestor on BNB
 *         testnet, the attestor reads the testnet stand-in for RedStone when
 *         the request arrives, anyone relays its reply, and the timelock
 *         records it and executes the delisting — or refuses it when the
 *         stand-in flags the address.
 *
 * @dev    The unit suites (`SanctionsDelistingTimelockTest`,
 *         `TestnetSanctionsOracleStandInTest`) prove the contracts against a
 *         mock messenger. This proves the DEPLOYED timelocks and messengers,
 *         the wiring `ConfigureSanctionsClearance` performs, and that each
 *         chain's live CCIP router accepts the message for the other.
 *
 *         What plays the CCIP network, stated plainly. Each send goes through
 *         the source chain's REAL router and on-ramp, which accept or refuse it
 *         for that destination. The message the messenger actually handed the
 *         router is captured from the call itself (a state-diff recording),
 *         and the test then does what the destination's off-ramp would: it
 *         calls the destination messenger's `ccipReceive` AS THAT CHAIN'S
 *         ROUTER, with the captured data, the message id the source returned,
 *         and no more gas than the sender asked for. It first checks the
 *         destination router lists an off-ramp for the source chain. Chainlink's
 *         DON — committing, the risk network, execution — is not simulated:
 *         `CCIPLocalSimulatorFork` cannot read these lanes' on-ramp events (they
 *         run a newer CCIP release than the vendored simulator), and the DON's
 *         behaviour is Chainlink's to prove, not this repository's.
 *
 *         The wiring is done BY THE SCRIPT, on the forks, against copies of
 *         the committed artifacts in a scratch root. The script reads before it
 *         writes, so after the live wiring the same run reuses what is deployed
 *         and sends nothing, and the cells keep proving whatever is live.
 *
 *         A delisting needs a publication that calls for one. The live
 *         rehearsal lists record OFAC's file, which calls for none today, so
 *         each cell records a DRILL publication on the fork only: the list's
 *         owner appoints a drill adder and the timelock's owner a drill
 *         proposer, and the drill adder declares one delisting outstanding
 *         under a drill date. Nothing here touches the shared testnets.
 *
 *         Gated by `FORK_URL_BNB_TESTNET` plus `FORK_URL_BASE_SEPOLIA` or
 *         `FORK_URL_ARB_SEPOLIA`; each cell skips when either URL it needs is
 *         unset, like the other suites here.
 */
contract SanctionsClearanceLiveForkTest is Test {
    uint256 internal constant BNB = 97;
    uint256 internal constant BASE = 84532;
    uint256 internal constant ARB = 421614;

    bytes32 internal constant DRILL_HASH = keccak256("vaipakam.sanctions-clearance.fork-drill");
    /// @dev Later than any real publication, so the list accepts it as newer.
    uint32 internal constant DRILL_DATE = 29991231;

    uint256 internal bnbFork;
    uint256 internal tlFork;
    address internal admin;
    address internal relayer = makeAddr("relayer");

    SanctionsDelistingTimelock internal tl;
    SanctionsList internal list;
    CcipMessenger internal tlMessenger;
    CcipMessenger internal bnbMessenger;
    SanctionsClearanceAttestor internal att;
    TestnetSanctionsOracleStandIn internal standIn;

    function test_BaseSepolia_DelistsOnTheStandInsClearance() public {
        if (!_setUp("FORK_URL_BASE_SEPOLIA", "base-sepolia", BASE, "base-clears")) return;
        _clearsAndExecutes();
    }

    function test_ArbSepolia_DelistsOnTheStandInsClearance() public {
        if (!_setUp("FORK_URL_ARB_SEPOLIA", "arb-sepolia", ARB, "arb-clears")) return;
        _clearsAndExecutes();
    }

    function test_ArbSepolia_AStandInFlagRefusesTheDelisting() public {
        if (!_setUp("FORK_URL_ARB_SEPOLIA", "arb-sepolia", ARB, "arb-flagged")) return;
        (uint256 id, address target) = _drillProposal();
        vm.selectFork(bnbFork);
        address[] memory one = new address[](1);
        one[0] = target;
        vm.prank(admin);
        standIn.setFlagged(one, true);

        bool[] memory flags = new bool[](1);
        flags[0] = true;
        _roundTrip(id, target, flags);

        (uint64 requestId,,,, SanctionsDelistingTimelock.ClearanceState state) = tl.clearanceOf(id);
        assertEq(uint8(state), uint8(SanctionsDelistingTimelock.ClearanceState.Flagged), "the stand-in's flag came back");
        (bool ready, bytes4 reason) = tl.readiness(id);
        assertFalse(ready);
        assertEq(reason, SanctionsDelistingTimelock.ClearanceFlagged.selector);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceFlagged.selector, id, requestId));
        tl.execute(id);
        assertTrue(list.listedByOwnList(target), "a flagged address stays listed");
    }

    // ── Cells ─────────────────────────────────────────────────────────

    function _clearsAndExecutes() internal {
        (uint256 id, address target) = _drillProposal();
        _roundTrip(id, target, new bool[](1));

        (,,,, SanctionsDelistingTimelock.ClearanceState state) = tl.clearanceOf(id);
        assertEq(uint8(state), uint8(SanctionsDelistingTimelock.ClearanceState.Cleared), "the clearance came back");
        (bool ready,) = tl.readiness(id);
        assertTrue(ready, "the proposal is executable on the stand-in's clearance");
        tl.execute(id);
        assertFalse(list.listedByOwnList(target), "delisted through the cross-chain route");
    }

    // ── Steps ─────────────────────────────────────────────────────────

    /// @dev Forks both chains, wires them with the script, and reads the
    ///      contracts back. False (after `vm.skip`) when a URL is unset. `tag`
    ///      names this cell's scratch root, since cells run in parallel.
    function _setUp(string memory urlEnv, string memory slug, uint256 chainId, string memory tag)
        internal
        returns (bool)
    {
        string memory tlUrl = vm.envOr(urlEnv, string(""));
        string memory bnbUrl = vm.envOr("FORK_URL_BNB_TESTNET", string(""));
        if (bytes(tlUrl).length == 0 || bytes(bnbUrl).length == 0) {
            vm.skip(true);
            return false;
        }
        bnbFork = vm.createFork(bnbUrl);
        tlFork = vm.createFork(tlUrl);

        string memory root = _scratchRoot(tag);
        string memory tlArtifact = vm.readFile(string.concat(root, "/", slug, "/addresses.json"));
        uint256[] memory timelockChains = new uint256[](2);
        timelockChains[0] = BASE;
        timelockChains[1] = ARB;
        admin = vm.parseJsonAddress(tlArtifact, ".admin");
        address deployer = makeAddr("deployer");

        vm.selectFork(bnbFork);
        ConfigureSanctionsClearance onBnb = new ConfigureSanctionsClearance();
        onBnb.setArtifactRootOverride(root);
        onBnb.runWith(admin, deployer, BNB, timelockChains);
        att = SanctionsClearanceAttestor(payable(onBnb.attestor()));
        standIn = TestnetSanctionsOracleStandIn(onBnb.standIn());
        bnbMessenger = CcipMessenger(payable(address(att.messenger())));
        assertTrue(standIn.isTestnetStandIn());
        vm.deal(relayer, 10 ether);

        vm.selectFork(tlFork);
        assertEq(block.chainid, chainId);
        ConfigureSanctionsClearance onTimelockChain = new ConfigureSanctionsClearance();
        onTimelockChain.setArtifactRootOverride(root);
        onTimelockChain.runWith(admin, deployer, BNB, timelockChains);
        tl = SanctionsDelistingTimelock(payable(vm.parseJsonAddress(tlArtifact, ".sanctionsDelistingTimelock")));
        list = tl.list();
        tlMessenger = CcipMessenger(payable(tl.clearanceMessenger()));
        assertEq(uint8(tl.clearanceRoute()), uint8(SanctionsDelistingTimelock.Route.CrossChain));
        assertEq(tl.clearanceAttestor(), address(att));
        assertEq(tl.clearanceSourceChainId(), BNB);
        vm.deal(relayer, 10 ether);
        vm.removeDir(root, true);
        return true;
    }

    /// @dev A drill publication calling for one delisting, proposed and
    ///      matured, on the timelock chain's fork.
    function _drillProposal() internal returns (uint256 id, address target) {
        vm.selectFork(tlFork);
        address drillAdder = makeAddr("drill-adder");
        address drillProposer = makeAddr("drill-proposer");
        vm.prank(list.owner());
        list.setAdder(drillAdder, true);
        vm.prank(tl.owner());
        tl.setProposer(drillProposer, true);

        target = list.listedPage(0, 1)[0];
        uint64 version = list.listVersion(); // read BEFORE the prank
        vm.prank(drillAdder);
        list.applyUpdate(version, new address[](0), new address[](0), DRILL_HASH, DRILL_DATE, 0, 1);
        address[] memory one = new address[](1);
        one[0] = target;
        vm.prank(drillProposer);
        id = tl.propose(one, DRILL_HASH, DRILL_DATE);
        uint256 eta = tl.getProposal(id).eta;
        vm.warp(eta + 1);
    }

    /// @dev Request on the timelock chain, read on BNB, reply relayed back.
    ///      Leaves the timelock chain selected. The stand-in is refreshed on
    ///      BNB first, as the admin would, so its freshness is judged against
    ///      a publication made for this drill rather than whenever it was
    ///      last touched.
    function _roundTrip(uint256 id, address target, bool[] memory expectedFlags) internal {
        vm.selectFork(bnbFork);
        vm.prank(admin);
        standIn.markUpdated();
        uint64 standInUpdatedAt = uint64(standIn.getLastUpdateBlockTimestamp());

        vm.selectFork(tlFork);
        uint256 fee = tl.quoteClearanceRequest(id);
        vm.startStateDiffRecording();
        vm.prank(relayer);
        bytes32 requestMessageId = tl.requestClearance{value: fee}(id);
        Vm.AccountAccess[] memory sent = vm.stopAndReturnStateDiff();
        (uint64 requestId,,,,) = tl.clearanceOf(id);
        _deliver(sent, tlMessenger, tlFork, bnbMessenger, bnbFork, requestMessageId);

        // `_deliver` left BNB selected.
        address[] memory one = new address[](1);
        one[0] = target;
        bytes memory reply = abi.encode(
            SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, requestId, one, expectedFlags, standInUpdatedAt
        );
        (, bytes32 payloadHash,,) = att.replyOf(requestMessageId);
        assertEq(payloadHash, keccak256(reply), "the attestor read the stand-in when the request arrived");
        uint256 replyFee = att.quoteReply(requestMessageId, reply);
        vm.startStateDiffRecording();
        vm.prank(relayer);
        bytes32 replyMessageId = att.sendReply{value: replyFee}(requestMessageId, reply);
        sent = vm.stopAndReturnStateDiff();
        _deliver(sent, bnbMessenger, bnbFork, tlMessenger, tlFork, replyMessageId);
    }

    /// @dev Does what the destination's off-ramp would with the one message
    ///      `from` handed its router in `accesses`: checks the destination
    ///      router accepts that source lane, then calls `to.ccipReceive` as
    ///      that router with the captured data, the source's message id, and
    ///      the gas the sender asked for. Leaves the destination selected.
    function _deliver(
        Vm.AccountAccess[] memory accesses,
        CcipMessenger from,
        uint256 fromFork,
        CcipMessenger to,
        uint256 toFork,
        bytes32 messageId
    ) internal {
        vm.selectFork(fromFork);
        address fromRouter = from.getRouter();
        uint64 sourceSelector = _selectorOf(block.chainid);
        Client.EVM2AnyMessage memory message;
        uint64 destSelector;
        uint256 found;
        for (uint256 i; i < accesses.length; ++i) {
            Vm.AccountAccess memory acc = accesses[i];
            if (
                acc.kind != VmSafe.AccountAccessKind.Call || acc.account != fromRouter || acc.accessor != address(from)
                    || acc.reverted || acc.data.length < 4 || bytes4(acc.data) != IRouterClient.ccipSend.selector
            ) continue;
            (destSelector, message) = abi.decode(_tail(acc.data, 4), (uint64, Client.EVM2AnyMessage));
            ++found;
        }
        assertEq(found, 1, "exactly one message was handed to the source router");
        assertEq(abi.decode(message.receiver, (address)), address(to), "addressed to the destination messenger");
        assertEq(message.tokenAmounts.length, 0, "no tokens ride a clearance");
        assertEq(bytes4(message.extraArgs), Client.GENERIC_EXTRA_ARGS_V2_TAG, "gas limit carried as GenericExtraArgsV2");
        Client.GenericExtraArgsV2 memory extra = abi.decode(_tail(message.extraArgs, 4), (Client.GenericExtraArgsV2));

        vm.selectFork(toFork);
        assertEq(destSelector, _selectorOf(block.chainid), "sent to this chain's selector");
        address toRouter = to.getRouter();
        assertTrue(_routerHasOffRampFor(toRouter, sourceSelector), "the destination router accepts this source lane");
        Client.Any2EVMMessage memory delivered = Client.Any2EVMMessage({
            messageId: messageId,
            sourceChainSelector: sourceSelector,
            sender: abi.encode(address(from)),
            data: message.data,
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.prank(toRouter);
        to.ccipReceive{gas: extra.gasLimit}(delivered);
    }

    function _routerHasOffRampFor(address router, uint64 sourceSelector) internal view returns (bool) {
        ICcipRouterOffRamps.OffRamp[] memory ramps = ICcipRouterOffRamps(router).getOffRamps();
        for (uint256 i; i < ramps.length; ++i) {
            if (ramps[i].sourceChainSelector == sourceSelector) return true;
        }
        return false;
    }

    function _selectorOf(uint256 chainId) internal pure returns (uint64) {
        if (chainId == BNB) return 13264668187771770619;
        if (chainId == BASE) return 10344971235874465080;
        if (chainId == ARB) return 3478487238524512106;
        revert("no selector for chain");
    }

    /// @dev `data` from byte `from` on.
    function _tail(bytes memory data, uint256 from) internal pure returns (bytes memory out) {
        out = new bytes(data.length - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = data[from + i];
        }
    }

    /// @dev A scratch artifact root holding copies of the three committed
    ///      artifacts, so the script's writes never reach the committed files.
    function _scratchRoot(string memory tag) internal returns (string memory root) {
        root = string.concat("deployments/.forge-test/sanctions-clearance-", tag);
        string[3] memory slugs = ["bnb-testnet", "base-sepolia", "arb-sepolia"];
        for (uint256 i; i < slugs.length; ++i) {
            vm.createDir(string.concat(root, "/", slugs[i]), true);
            vm.copyFile(
                string.concat("deployments/", slugs[i], "/addresses.json"),
                string.concat(root, "/", slugs[i], "/addresses.json")
            );
        }
    }
}
