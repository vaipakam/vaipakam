// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {ISanctionsList} from "../src/interfaces/ISanctionsList.sol";
import {SanctionsDelistingTimelock} from "../src/compliance/SanctionsDelistingTimelock.sol";
import {SanctionsClearanceAttestor} from "../src/compliance/SanctionsClearanceAttestor.sol";
import {TestnetSanctionsOracleStandIn} from "../src/compliance/TestnetSanctionsOracleStandIn.sol";
import {TestnetChains} from "../src/compliance/TestnetChains.sol";
import {Deployments} from "./lib/Deployments.sol";
import {ArtifactRootBase} from "./lib/ArtifactRoot.sol";
import {AdminControl} from "./lib/AdminControl.sol";
import {SanctionsRecords} from "./lib/SanctionsRecords.sol";
import {SanctionsClearanceReport} from "./lib/SanctionsClearanceReport.sol";
import {TotalRead} from "./lib/TotalRead.sol";
import {StandInFlagReplay} from "./lib/StandInFlagReplay.sol";

/// @dev The two reads {ConfigureSanctionsClearance._recordedAttestorToReuse}
///      makes of a recorded attestor, as an interface so their selectors can
///      be named (a public immutable's getter has none on the contract type).
interface IClearanceAttestorReads {
    function oracle() external view returns (address);
    function messenger() external view returns (address);
}

/// @dev The stand-in's refresher getter (#3113), named the same way: a
///      stand-in built before the role does not answer it.
interface IStandInRefresherRead {
    function refresher() external view returns (address);
}

/**
 * @title  ConfigureSanctionsClearance
 * @notice Wires the delisting timelocks' CROSS-CHAIN clearance route on
 *         TESTNETS: one chain hosts a `SanctionsClearanceAttestor` reading a
 *         `TestnetSanctionsOracleStandIn`, and each timelock chain sends its
 *         clearance requests there over CCIP and takes the answers back.
 *
 * @dev    #2443, owner decision 2026-10-20 ("rehearse with a stand-in").
 *         RedStone's Sanctions Oracle is reported live only on Ethereum
 *         mainnet, so no testnet can run the real cross-chain RedStone check.
 *         The stand-in answers in RedStone's place so the route the mainnet
 *         chains will depend on — request over CCIP, reading on arrival,
 *         reply over CCIP — is exercised on live testnet contracts. What
 *         this does NOT do, stated so nobody infers it:
 *         - It configures nothing on a mainnet. It refuses every chain
 *           outside `TestnetChains`, because what it deploys is a stand-in;
 *           a mainnet attestor reads RedStone itself, which waits on
 *           RedStone's terms (#2443).
 *         - It does not make the stand-in RedStone. The stand-in flags only
 *           what its owner (the admin) flags, says so on-chain
 *           (`isTestnetStandIn`), and is only as fresh as its last
 *           publication (`markUpdated`, by the admin or the refresher the
 *           admin names); a stand-in left alone longer than a timelock's
 *           `oracleMaxAge` closes that timelock's automated route, as a
 *           frozen RedStone would.
 *         - It changes no list, no proposer, no delay and no Safe power.
 *
 *         One script, run once per chain, each run doing that chain's half:
 *         - On the ATTESTOR chain: deploy (or reuse) the stand-in and the
 *           attestor, wire a CCIP lane to every timelock chain, register the
 *           attestor as the clearance channel's handler, and set each
 *           timelock as that channel's peer for its chain.
 *         - On each TIMELOCK chain: wire a CCIP lane to the attestor chain,
 *           register the timelock as the channel's handler, set the attestor
 *           as its peer, and point the timelock at it (`setClearanceSource`).
 *           Only the timelock of the chain's recorded list is wired: a
 *           timelock record that serves another list stops the run
 *           ({SanctionsRecords}).
 *         Run the attestor chain FIRST: a timelock chain reads the attestor's
 *         address from that chain's artifact and refuses while it is absent.
 *
 *         Every step reads before it writes and is skipped when already in
 *         place, so a re-run sends nothing on a wired chain. It RECORDS LAST:
 *         the artifact is written only after every step of the run has
 *         succeeded. Forge executes the whole script before broadcasting and
 *         sends nothing if any step reverts, but an artifact write made
 *         during that execution survives the revert, so a write before a step
 *         that can still refuse could name contracts that were never sent.
 *         Nothing is re-pointed unless the run is told what to replace: a
 *         channel handler, a channel peer or a lane already set to something
 *         else stops the run. `setClearanceSource` is called only when the
 *         source differs, since every call voids requests already in flight.
 *
 *         ROTATION (#3113, owner decision 2026-11-04: a new stand-in with the
 *         refresher role). An attestor's oracle is fixed at construction, so
 *         a new stand-in means a new attestor, and the clearance channel's
 *         handler (attestor chain) and peer (each timelock chain) move to it.
 *         `SANCTIONS_CLEARANCE_REPLACE_ATTESTOR` names the attestor being
 *         replaced; only a handler or peer that IS that attestor is cleared
 *         and re-pointed, anything else still stops the run. No drain is
 *         needed on this channel: it carries no tokens, a request delivered
 *         to the new attestor is answered from the new stand-in, and an
 *         answer still in flight from the old one is refused by the
 *         re-pointed peer (a failed CCIP message) while the timelock's
 *         `setClearanceSource` voids the request it answered anyway; the
 *         delister then requests again. Until a timelock chain's own run,
 *         that timelock still accepts the old attestor: answers it already
 *         holds and answers still in flight count under its unchanged epoch.
 *         They were read from the old stand-in, which keeps the same flags
 *         (it is not changed by the rotation, and the new one is given all
 *         of them), and they still expire at the timelock's `oracleMaxAge`.
 *         New requests in that window get no answer, since the new
 *         attestor's replies are refused by the old peer. On the attestor chain the run also
 *         carries the old stand-in's flags to the new one BEFORE the handler
 *         moves, so the new attestor never answers from a shorter list. The
 *         flags are rebuilt from the old stand-in's own `StandInFlagSet`
 *         events from `SANCTIONS_STANDIN_CARRY_FROM_BLOCK` (its deployment
 *         block or earlier) to the head, the run refuses unless that range
 *         holds the stand-in's construction, and every carried account is
 *         checked against the old stand-in's live mapping. The route it reports is read from the timelock and names
 *         the oracle only from what it reads ({SanctionsClearanceReport}).
 *
 *         Keys: `ADMIN_PRIVATE_KEY` owns the messengers, the timelocks and
 *         the stand-in, and makes every configuration write. The run acts on
 *         a messenger or timelock only while the admin alone controls it
 *         ({AdminControl}: owner, nothing pending), since a pending owner
 *         could take over whatever the run just wired;
 *         `DEPLOYER_PRIVATE_KEY` deploys. `SANCTIONS_STANDIN_REFRESHER`
 *         (optional, attestor chain only) is the keeper address the run names
 *         as the stand-in's refresher (#3113), so the keeper re-publishes it
 *         before it goes stale; it can flag nothing. Unset, the run leaves
 *         the refresher as it finds it and says who it is. Topology:
 *         `SANCTIONS_CLEARANCE_ATTESTOR_CHAIN_ID` (the testnet rehearsal uses
 *         BNB testnet, 97) and `SANCTIONS_CLEARANCE_TIMELOCK_CHAIN_IDS`
 *         (comma-separated; 84532,421614).
 *
 *         Run (dry, then with `--broadcast`), attestor chain first:
 *           SANCTIONS_CLEARANCE_ATTESTOR_CHAIN_ID=97 \
 *           SANCTIONS_CLEARANCE_TIMELOCK_CHAIN_IDS=84532,421614 \
 *           forge script script/ConfigureSanctionsClearance.s.sol \
 *             --rpc-url "$BNB_TESTNET_RPC_URL" [--broadcast --slow]
 *         then the same on Base Sepolia and Arbitrum Sepolia.
 *
 *         A rotation is the same three runs with the replaced attestor named
 *         (and, on the attestor chain, where the old stand-in's history
 *         starts):
 *           SANCTIONS_CLEARANCE_REPLACE_ATTESTOR=<old attestor> \
 *           SANCTIONS_STANDIN_CARRY_FROM_BLOCK=<old stand-in deploy block> \
 *           SANCTIONS_STANDIN_REFRESHER=<keeper address> ... (attestor chain)
 *           SANCTIONS_CLEARANCE_REPLACE_ATTESTOR=<old attestor> ... (each
 *           timelock chain)
 *         Between the attestor-chain run and a timelock chain's own run, that
 *         timelock gets no NEW answers; ones it holds, or that the old
 *         attestor already sent, still count (read from the old stand-in,
 *         which keeps the same flags).
 */
contract ConfigureSanctionsClearance is Script, ArtifactRootBase {
    /// @notice The `ICrossChainMessenger` channel clearance requests and
    ///         answers travel on. The messenger stamps it from the sending
    ///         handler, so neither contract names it; both ends of every lane
    ///         must register under this id.
    bytes32 public constant SANCTIONS_CLEARANCE_CHANNEL = keccak256("vaipakam.ccip.channel.sanctions-clearance");

    /// @notice The attestor this run deployed or reused (attestor chain
    ///         only), for a test to read back.
    address public attestor;
    /// @notice The stand-in this run deployed or reused (attestor chain only).
    address public standIn;

    /// @notice The refresher this run names on the stand-in (attestor chain
    ///         only); address(0) leaves it as found. Set by {run} from
    ///         `SANCTIONS_STANDIN_REFRESHER`, or by a test.
    address public standInRefresher;

    /// @notice The attestor a rotation replaces (#3113); address(0) refuses
    ///         every re-point. Set by {run} from
    ///         `SANCTIONS_CLEARANCE_REPLACE_ATTESTOR`, or by a test.
    address public replaceAttestor;

    /// @notice First block of the replaced stand-in's history, for carrying
    ///         its flags (attestor chain only). Set by {run} from
    ///         `SANCTIONS_STANDIN_CARRY_FROM_BLOCK`, or by a test.
    uint256 public carryFromBlock;

    /// @notice The accounts this run carried to the new stand-in.
    address[] public carriedFlags;

    function run() external {
        address admin = vm.rememberKey(vm.envUint("ADMIN_PRIVATE_KEY"));
        address deployer = vm.rememberKey(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        standInRefresher = vm.envOr("SANCTIONS_STANDIN_REFRESHER", address(0));
        replaceAttestor = vm.envOr("SANCTIONS_CLEARANCE_REPLACE_ATTESTOR", address(0));
        carryFromBlock = vm.envOr("SANCTIONS_STANDIN_CARRY_FROM_BLOCK", uint256(0));
        runWith(
            admin,
            deployer,
            vm.envUint("SANCTIONS_CLEARANCE_ATTESTOR_CHAIN_ID"),
            vm.envUint("SANCTIONS_CLEARANCE_TIMELOCK_CHAIN_IDS", ",")
        );
    }

    /// @notice {run} with the signers and the topology given directly.
    /// @param admin            Owner of the messengers, timelocks and stand-in.
    /// @param deployer         Deploys the stand-in and the attestor.
    /// @param attestorChainId  The chain hosting the attestor and stand-in.
    /// @param timelockChainIds The chains whose timelocks use it.
    function runWith(address admin, address deployer, uint256 attestorChainId, uint256[] memory timelockChainIds)
        public
    {
        require(
            TestnetChains.isTestnet(block.chainid),
            "ConfigureSanctionsClearance: mainnet refused - it deploys a testnet stand-in for RedStone; a mainnet clearance route reads RedStone itself, which waits on RedStone's terms (#2443)"
        );
        _requireTopology(attestorChainId, timelockChainIds);
        bool writes = Deployments.artifactWritesEnabled();
        CcipMessenger m = CcipMessenger(payable(Deployments.readAddressForChain(block.chainid, ".ccipMessenger")));
        AdminControl.requireAloneControls(address(m), admin, "ConfigureSanctionsClearance: this chain's CcipMessenger");

        if (block.chainid == attestorChainId) {
            _wireAttestorChain(m, admin, deployer, timelockChainIds, writes);
        } else {
            _wireTimelockChain(m, admin, attestorChainId);
        }
    }

    // ── Attestor chain ─────────────────────────────────────────────────

    function _wireAttestorChain(
        CcipMessenger m,
        address admin,
        address deployer,
        uint256[] memory timelockChainIds,
        bool writes
    ) internal {
        // Reused when fit (address(0): this run deploys it). Nothing is
        // recorded until the wiring below has succeeded — see "records last".
        address reusedStandIn = _recordedStandInToReuse(admin);
        address reusedAttestor = reusedStandIn == address(0) ? address(0) : _recordedAttestorToReuse(reusedStandIn, m);
        TestnetSanctionsOracleStandIn s = reusedStandIn != address(0)
            ? TestnetSanctionsOracleStandIn(reusedStandIn)
            : _deployStandIn(admin, deployer);
        SanctionsClearanceAttestor a = reusedAttestor != address(0)
            ? SanctionsClearanceAttestor(payable(reusedAttestor))
            : _deployAttestor(s, m, deployer);
        standIn = address(s);
        attestor = address(a);
        address[] memory carry = _flagsToCarry(m, s, a);

        vm.startBroadcast(admin);
        if (standInRefresher != address(0) && s.refresher() != standInRefresher) {
            s.setRefresher(standInRefresher);
            console.log("  stand-in: refresher named", standInRefresher);
        }
        // Before the handler moves: the new attestor answers from the full list.
        if (carry.length != 0) {
            s.setFlagged(carry, true);
            console.log("  stand-in: flags carried from the replaced stand-in:", carry.length);
        }
        for (uint256 i; i < timelockChainIds.length; ++i) {
            _ensureLane(m, timelockChainIds[i]);
        }
        _ensureHandler(m, address(a));
        for (uint256 i; i < timelockChainIds.length; ++i) {
            uint256 cid = timelockChainIds[i];
            _ensurePeer(m, cid, Deployments.readAddressForChain(cid, ".sanctionsDelistingTimelock"));
        }
        vm.stopBroadcast();

        require(
            m.handlerOf(SANCTIONS_CLEARANCE_CHANNEL) == address(a),
            "ConfigureSanctionsClearance: attestor not registered"
        );
        // Every step has succeeded: record what this run deployed, last.
        if (writes && reusedStandIn == address(0)) Deployments.writeSanctionsOracleStandIn(address(s));
        if (writes && reusedAttestor == address(0)) Deployments.writeSanctionsClearanceAttestor(address(a));
        console.log("SanctionsClearanceAttestor:", address(a));
        console.log("  messenger:", address(m));
        console.log("  reads    : the TESTNET STAND-IN for", s.STAND_IN_FOR(), "- NOT RedStone:");
        console.log("            ", address(s));
        console.log("  stand-in owner      :", s.owner());
        console.log("  stand-in last update:", s.getLastUpdateBlockTimestamp());
        console.log("  stand-in refresher  :", s.refresher());
        console.log(
            "    It goes stale once older than a timelock's oracleMaxAge; its refresher (the keeper's sanctionsStandInRefresh pass) or the admin refreshes it with markUpdated()."
        );
        for (uint256 i; i < timelockChainIds.length; ++i) {
            uint256 cid = timelockChainIds[i];
            console.log("  answers the timelock on chain", cid, m.channelPeerOf(SANCTIONS_CLEARANCE_CHANNEL, cid));
        }
        console.log("Next: run this script on each timelock chain.");
    }

    /// @dev On a rotation, the accounts the replaced attestor's stand-in
    ///      flags and the new stand-in `s` does not yet; empty when this run
    ///      replaces nothing or the handler already is `a`. Refuses a replace target that is not the
    ///      channel's handler here (nor already replaced by `a`), and a
    ///      replaced oracle that is not a stand-in.
    function _flagsToCarry(CcipMessenger m, TestnetSanctionsOracleStandIn s, SanctionsClearanceAttestor a)
        internal
        returns (address[] memory missing)
    {
        if (replaceAttestor == address(0)) return missing;
        require(
            replaceAttestor != address(a),
            "ConfigureSanctionsClearance: SANCTIONS_CLEARANCE_REPLACE_ATTESTOR names the attestor this run keeps"
        );
        address handler = m.handlerOf(SANCTIONS_CLEARANCE_CHANNEL);
        // Already rotated: the flags were carried in the broadcast that moved
        // the handler, before it moved. Carrying again would re-flag an
        // account the admin has cleared on the new stand-in since.
        if (handler == address(a)) return missing;
        require(
            handler == replaceAttestor,
            "ConfigureSanctionsClearance: SANCTIONS_CLEARANCE_REPLACE_ATTESTOR is not the clearance channel's handler here"
        );
        (bool read, address oldStandIn) = TotalRead.addressOf(replaceAttestor, IClearanceAttestorReads.oracle.selector);
        require(read, "ConfigureSanctionsClearance: the replaced attestor does not answer oracle()");
        if (oldStandIn == address(s)) return missing; // same stand-in: nothing to carry
        require(
            SanctionsClearanceReport.isStandIn(oldStandIn),
            "ConfigureSanctionsClearance: the replaced attestor's oracle is not a testnet stand-in - its flags cannot be carried"
        );
        address[] memory flagged = _replayFlags(oldStandIn);
        uint256 n;
        for (uint256 i; i < flagged.length; ++i) {
            if (!s.flagged(flagged[i])) ++n;
        }
        missing = new address[](n);
        n = 0;
        for (uint256 i; i < flagged.length; ++i) {
            if (!s.flagged(flagged[i])) missing[n++] = flagged[i];
        }
        for (uint256 i; i < flagged.length; ++i) {
            carriedFlags.push(flagged[i]);
        }
        console.log("Replaced stand-in", oldStandIn, "flags", flagged.length);
    }

    /// @dev The accounts `oldStandIn` flags now, from its events between
    ///      {carryFromBlock} and the head ({StandInFlagReplay}). Refuses a
    ///      range that does not hold its construction, and any account its
    ///      live mapping does not confirm.
    function _replayFlags(address oldStandIn) internal returns (address[] memory flagged) {
        require(
            carryFromBlock != 0,
            "ConfigureSanctionsClearance: set SANCTIONS_STANDIN_CARRY_FROM_BLOCK to the replaced stand-in's deployment block (or earlier) to carry its flags"
        );
        uint256 head = block.number;
        require(carryFromBlock <= head, "ConfigureSanctionsClearance: SANCTIONS_STANDIN_CARRY_FROM_BLOCK is ahead of the head");
        uint256 chunk = vm.envOr("SANCTIONS_STANDIN_LOG_CHUNK", uint256(5000));
        require(chunk > 0, "ConfigureSanctionsClearance: SANCTIONS_STANDIN_LOG_CHUNK must be > 0");
        // Ownable's constructor emits OwnershipTransferred(address(0), owner):
        // the one event no later call can emit, so seeing it proves the range
        // starts at or before the deployment.
        bytes32[] memory constructionTopics = new bytes32[](2);
        constructionTopics[0] = keccak256("OwnershipTransferred(address,address)");
        constructionTopics[1] = bytes32(0);
        bytes32[] memory flagTopics = new bytes32[](1);
        flagTopics[0] = StandInFlagReplay.FLAG_SET;
        bool constructed;
        Vm.EthGetLogs[] memory acc = new Vm.EthGetLogs[](0);
        for (uint256 b = carryFromBlock; b <= head; b += chunk) {
            uint256 to = b + chunk - 1 > head ? head : b + chunk - 1;
            if (!constructed && vm.eth_getLogs(b, to, oldStandIn, constructionTopics).length != 0) constructed = true;
            acc = _concat(acc, vm.eth_getLogs(b, to, oldStandIn, flagTopics));
        }
        require(
            constructed,
            "ConfigureSanctionsClearance: the replaced stand-in's construction is not in the range read - SANCTIONS_STANDIN_CARRY_FROM_BLOCK is after its deployment"
        );
        flagged = StandInFlagReplay.flaggedNow(acc, oldStandIn);
        for (uint256 i; i < flagged.length; ++i) {
            require(
                TestnetSanctionsOracleStandIn(oldStandIn).flagged(flagged[i]),
                "ConfigureSanctionsClearance: the replaced stand-in's events disagree with its live flags"
            );
        }
    }

    function _concat(Vm.EthGetLogs[] memory a, Vm.EthGetLogs[] memory b)
        internal
        pure
        returns (Vm.EthGetLogs[] memory out)
    {
        out = new Vm.EthGetLogs[](a.length + b.length);
        for (uint256 i; i < a.length; ++i) {
            out[i] = a[i];
        }
        for (uint256 i; i < b.length; ++i) {
            out[a.length + i] = b[i];
        }
    }

    /// @dev The recorded stand-in while it is fit to reuse (see
    ///      {_reusableStandIn}); otherwise address(0), for a new one.
    function _recordedStandInToReuse(address admin) internal view returns (address) {
        address recorded = Deployments.readSanctionsOracleStandInOptional();
        if (recorded.code.length == 0) return address(0);
        if (_reusableStandIn(recorded, admin)) {
            console.log("Reusing the recorded stand-in");
            return recorded;
        }
        console.log("The recorded stand-in is not one the admin alone controls; deploying a new one");
        return address(0);
    }

    /// @dev A new stand-in owned by the admin (recorded by the caller once
    ///      the run has succeeded).
    function _deployStandIn(address admin, address deployer) internal returns (TestnetSanctionsOracleStandIn) {
        vm.startBroadcast(deployer);
        TestnetSanctionsOracleStandIn s = new TestnetSanctionsOracleStandIn(admin);
        vm.stopBroadcast();
        return s;
    }

    /// @dev Whether `candidate` is a stand-in only the admin controls: it says
    ///      it is one, {AdminControl.aloneControls} holds, and it has the
    ///      refresher role (#3113). An attestor binds its oracle for good, so
    ///      reusing a stand-in whose pending owner could accept it would hand
    ///      the clearance answers (flags and freshness) to someone other than
    ///      the admin; and reusing one built before the refresher role would
    ///      leave its freshness to the admin's hand for as long as it is used.
    function _reusableStandIn(address candidate, address admin) internal view returns (bool) {
        (bool hasRefresher,) = TotalRead.addressOf(candidate, IStandInRefresherRead.refresher.selector);
        return hasRefresher && AdminControl.aloneControls(candidate, admin) && SanctionsClearanceReport.isStandIn(candidate);
    }

    /// @dev The recorded attestor while it reads `standIn_` (a reused
    ///      stand-in) through this messenger; otherwise address(0), for a new
    ///      one. Both getters are {TotalRead}s, so a recorded address that
    ///      answers neither, only one, or either malformed (a stale record, a
    ///      contract sharing one selector) is "not reusable", never a stop.
    function _recordedAttestorToReuse(address standIn_, CcipMessenger m) internal view returns (address) {
        address recorded = Deployments.readSanctionsClearanceAttestorOptional();
        if (recorded.code.length == 0) return address(0);
        (bool oracleRead, address oracle) = TotalRead.addressOf(recorded, IClearanceAttestorReads.oracle.selector);
        (bool messengerRead, address messenger) =
            TotalRead.addressOf(recorded, IClearanceAttestorReads.messenger.selector);
        if (oracleRead && messengerRead && oracle == standIn_ && messenger == address(m)) {
            console.log("Reusing the recorded attestor");
            return recorded;
        }
        console.log("The recorded attestor does not read this stand-in through this messenger; deploying a new one");
        return address(0);
    }

    /// @dev A new attestor reading `s` through `m` (recorded by the caller
    ///      once the run has succeeded).
    function _deployAttestor(TestnetSanctionsOracleStandIn s, CcipMessenger m, address deployer)
        internal
        returns (SanctionsClearanceAttestor)
    {
        vm.startBroadcast(deployer);
        SanctionsClearanceAttestor a =
            new SanctionsClearanceAttestor(ISanctionsList(address(s)), ICrossChainMessenger(address(m)));
        vm.stopBroadcast();
        return a;
    }

    // ── Timelock chain ─────────────────────────────────────────────────

    function _wireTimelockChain(CcipMessenger m, address admin, uint256 attestorChainId) internal {
        // The timelock of the recorded list, never a stale record beside it:
        // registering a timelock that serves another list would give the
        // clearance channel to a set-up the current list does not use.
        SanctionsDelistingTimelock tl = SanctionsRecords.requireRecordedTimelock("ConfigureSanctionsClearance");
        AdminControl.requireAloneControls(address(tl), admin, "ConfigureSanctionsClearance: this chain's timelock");
        address a = Deployments.readSanctionsClearanceAttestorOptionalForChain(attestorChainId);
        require(
            a != address(0),
            "ConfigureSanctionsClearance: the attestor chain's artifact records no sanctionsClearanceAttestor - run this script on the attestor chain first"
        );

        require(
            replaceAttestor != a,
            "ConfigureSanctionsClearance: SANCTIONS_CLEARANCE_REPLACE_ATTESTOR names the attestor the artifact records - it would replace nothing"
        );

        vm.startBroadcast(admin);
        _ensureLane(m, attestorChainId);
        _ensureHandler(m, address(tl));
        _ensurePeer(m, attestorChainId, a);
        if (
            tl.clearanceMessenger() != address(m) || tl.clearanceSourceChainId() != attestorChainId
                || tl.clearanceAttestor() != a
        ) {
            tl.setClearanceSource(address(m), attestorChainId, a);
        }
        vm.stopBroadcast();

        console.log("SanctionsDelistingTimelock:", address(tl));
        console.log("  clearance source: attestor", a, "on chain", attestorChainId);
        console.log("  epoch           :", uint256(tl.clearanceEpoch()));
        // A LOCAL route means the list's own secondary wins; the source above
        // is configured but unused while it is set.
        SanctionsDelistingTimelock.Route route = SanctionsClearanceReport.logRoute(tl);
        require(
            route != SanctionsDelistingTimelock.Route.Unavailable,
            "ConfigureSanctionsClearance: the timelock reports no clearance route after wiring"
        );
    }

    // ── Shared steps (inside the admin's broadcast) ────────────────────

    /// @dev This messenger's lane to `remote`: CCIP must support it, and the
    ///      selector and remote messenger are set when absent and must match
    ///      when present.
    function _ensureLane(CcipMessenger m, uint256 remote) internal {
        uint64 selector = Deployments.ccipSelectorForChainId(remote);
        require(
            IRouterClient(m.getRouter()).isChainSupported(selector),
            string.concat("ConfigureSanctionsClearance: CCIP does not support a lane to chain ", vm.toString(remote))
        );
        uint64 currentSelector = m.chainSelectorOf(remote);
        if (currentSelector == 0) {
            m.setChainSelector(remote, selector);
            console.log("  lane: selector set for chain", remote);
        } else {
            require(
                currentSelector == selector,
                "ConfigureSanctionsClearance: the messenger maps that chain to another selector"
            );
        }
        address remoteMessenger = Deployments.readAddressForChain(remote, ".ccipMessenger");
        address currentMessenger = m.remoteMessengerOf(remote);
        if (currentMessenger == address(0)) {
            m.setRemoteMessenger(remote, remoteMessenger);
            console.log("  lane: remote messenger set for chain", remote);
        } else {
            require(
                currentMessenger == remoteMessenger,
                "ConfigureSanctionsClearance: the messenger trusts another remote messenger for that chain"
            );
        }
    }

    /// @dev Registers `handler` on the clearance channel. Replaces only
    ///      {replaceAttestor} (cleared, then re-pointed); any other handler
    ///      stops the run.
    function _ensureHandler(CcipMessenger m, address handler) internal {
        address current = m.handlerOf(SANCTIONS_CLEARANCE_CHANNEL);
        if (current == handler) return;
        if (current != address(0) && current == replaceAttestor) {
            m.registerChannel(SANCTIONS_CLEARANCE_CHANNEL, address(0));
            console.log("  channel: handler cleared (replaced attestor)", current);
            current = address(0);
        }
        require(
            current == address(0),
            "ConfigureSanctionsClearance: another contract handles the clearance channel here - rotating it needs a drain (CcipMessenger.registerChannel); clear it deliberately first"
        );
        require(
            m.channelOf(handler) == bytes32(0),
            "ConfigureSanctionsClearance: that contract already handles another channel on this messenger"
        );
        m.registerChannel(SANCTIONS_CLEARANCE_CHANNEL, handler);
        console.log("  channel: handler registered", handler);
    }

    /// @dev Sets `peer` as the clearance channel's peer for `remote`.
    ///      Replaces only {replaceAttestor} (cleared, then re-pointed); any
    ///      other peer stops the run.
    function _ensurePeer(CcipMessenger m, uint256 remote, address peer) internal {
        address current = m.channelPeerOf(SANCTIONS_CLEARANCE_CHANNEL, remote);
        if (current == peer) return;
        if (current != address(0) && current == replaceAttestor) {
            m.setChannelPeer(SANCTIONS_CLEARANCE_CHANNEL, remote, address(0));
            console.log("  channel: peer cleared (replaced attestor) for chain", remote, current);
            current = address(0);
        }
        require(
            current == address(0),
            "ConfigureSanctionsClearance: the clearance channel already has another peer for that chain - rotating it needs a drain (CcipMessenger.setChannelPeer); clear it deliberately first"
        );
        m.setChannelPeer(SANCTIONS_CLEARANCE_CHANNEL, remote, peer);
        console.log("  channel: peer set for chain", remote, peer);
    }

    /// @dev Every chain a testnet, the attestor chain not among the timelock
    ///      chains, no timelock chain twice, and this chain one of them.
    function _requireTopology(uint256 attestorChainId, uint256[] memory timelockChainIds) internal view {
        require(timelockChainIds.length != 0, "ConfigureSanctionsClearance: name at least one timelock chain");
        require(
            TestnetChains.isTestnet(attestorChainId),
            "ConfigureSanctionsClearance: the attestor chain must be a testnet"
        );
        bool here = block.chainid == attestorChainId;
        for (uint256 i; i < timelockChainIds.length; ++i) {
            uint256 cid = timelockChainIds[i];
            require(TestnetChains.isTestnet(cid), "ConfigureSanctionsClearance: every timelock chain must be a testnet");
            require(
                cid != attestorChainId,
                "ConfigureSanctionsClearance: the attestor chain cannot also be a timelock chain"
            );
            for (uint256 j; j < i; ++j) {
                require(timelockChainIds[j] != cid, "ConfigureSanctionsClearance: a timelock chain is named twice");
            }
            if (cid == block.chainid) here = true;
        }
        require(here, "ConfigureSanctionsClearance: this chain is neither the attestor chain nor a timelock chain");
    }
}
