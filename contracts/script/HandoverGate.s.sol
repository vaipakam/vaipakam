// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {Deployments} from "./lib/Deployments.sol";
import {HandoverPlan} from "./lib/HandoverPlan.sol";
import {LibLaunchReadiness} from "../src/governance/LibLaunchReadiness.sol";

/**
 * @title HandoverGate
 * @notice The live-chain exit gate for the governance handover (#944,
 *         #669). Read-only: it broadcasts nothing and needs no key.
 *
 * @dev Run it against the chain, after `Handover.s.sol` has landed and the
 *      Timelock has accepted every pending two-step transfer:
 *
 *        forge script script/HandoverGate.s.sol --rpc-url $RPC
 *
 *      (`deploy-{mainnet,testnet}.sh <slug> --phase handover-gate` does
 *      exactly that). It passes only if the chain holds the topology
 *      `HandoverPlan` describes, and it reports every deviation it finds,
 *      not just the first.
 *
 *      What it reads, all from the live chain:
 *        - EVERY holder of EVERY Diamond role and Timelock role, rebuilt
 *          from the `RoleGranted` / `RoleRevoked` events since the
 *          artifact's `deployBlock`. AccessControl cannot be enumerated, so
 *          a check that only asks `hasRole` of the addresses it already
 *          knows cannot see a third key someone granted root to. The events
 *          can. Every (role, account) pair the events ever named is then
 *          compared with `hasRole` in BOTH directions, and the range must
 *          contain each contract's CONSTRUCTION — the Diamond's ownership
 *          set from the zero address, the Timelock's delay set from zero —
 *          so a late `deployBlock` or a truncated log range fails the gate
 *          instead of reading as "no other holders". (A first root grant is
 *          not proof: the handover's own grant to the Timelock is one.)
 *        - The Diamond's ERC-173 owner and every role's admin role.
 *        - The Timelock's delay and permanent floor.
 *        - Every owned target in `HandoverPlan.targets`: the contracts the
 *          chain must carry, and every other contract the artifact or the
 *          Diamond names (its swap adapters, rate model and satellites)
 *          that answers `owner()` with an owner other than the Diamond or
 *          zero (#2743). Each must be owned by the Timelock with no
 *          outstanding transfer (from `pendingOwner()`, or from the
 *          ownership events for CHAINLINK's two-step shape, which hides its
 *          pending owner), so a contract still on the deployer or admin key
 *          fails here. `guardian()` is checked on every `GuardianPausable`
 *          one. A contract the chain must carry but the artifact lacks
 *          fails on a production chain and is reported as not checked on a
 *          testnet — never read as nothing to check.
 *        - The VPFI CCT administrator on the CCIP `TokenAdminRegistry`.
 *
 *      Until #944 the documented exit gate was `DeployerZeroRolesTest`,
 *      which deploys its own throwaway Diamond and never reads the chain, so
 *      it passed whatever the chain held.
 *
 * @dev Env:
 *        CHAIN_SLUG or ADDRESSES_JSON_PATH — the artifact to read
 *            (`diamond`, `timelock`, `deployBlock`, the two-step targets).
 *        ADMIN_ADDRESS               — the admin key that must end with no role.
 *        EMERGENCY_REVOKER_ADDRESS   — the governance Safe.
 *        PAUSER_ADDRESS              — the Pauser Safe.
 *        KEEPER_ADDRESS / WATCHER_ADDRESS / NOTIF_BILLER_ADDRESS — the bot
 *            keys, as given to `Handover.s.sol` (zero = role must be unheld).
 *        TIMELOCK_EXECUTOR           — optional; zero (the default) is the
 *            open executor `DeployTimelock` installs.
 *        CCIP_TOKEN_ADMIN_REGISTRY   — optional; unset leaves the CCT
 *            administrator notChecked, which FAILS the gate on a production
 *            chain and is reported as notChecked on a testnet.
 *        HANDOVER_GATE_LOG_CHUNK     — optional; blocks per `eth_getLogs`
 *            call (default 5000). Lower it for an RPC with a tighter range.
 */
contract HandoverGate is Script {
    /// @notice What the chain is checked against.
    struct Inputs {
        address diamond;
        address timelock;
        address admin;
        address governanceSafe;
        address pauserSafe;
        /// @dev The Timelock's executor; zero is the open executor.
        address executor;
        /// @dev Parallel to `HandoverPlan.botRoles()`; zero = must be unheld.
        address[] botHolders;
        HandoverPlan.Target[] targets;
        address vpfiToken;
        /// @dev The artifact's VPFI pool and its rate governor: the pool
        ///      whose ownership `_checkTargets` proves, and the governor it
        ///      must be bound to.
        address vpfiPool;
        address rateGovernor;
        address cctRegistry;
        /// @dev `Deployments.requiresProductionGovernance()` for the chain.
        bool production;
    }

    /// @notice One event, reduced to what the gate reads. `order` sorts
    ///         events from several queries back into chain order.
    struct LogEntry {
        address emitter;
        bytes32[] topics;
        bytes data;
        uint256 order;
    }

    bytes32 internal constant ROLE_GRANTED = keccak256("RoleGranted(bytes32,address,address)");
    bytes32 internal constant ROLE_REVOKED = keccak256("RoleRevoked(bytes32,address,address)");
    bytes32 internal constant OWNERSHIP_REQUESTED = keccak256("OwnershipTransferRequested(address,address)");
    bytes32 internal constant OWNERSHIP_TRANSFERRED = keccak256("OwnershipTransferred(address,address)");
    /// @dev OpenZeppelin `TimelockController`; `(0, minDelay)` only in its constructor.
    bytes32 internal constant MIN_DELAY_CHANGE = keccak256("MinDelayChange(uint256,uint256)");

    string[] private _failures;
    string[] private _unchecked;
    /// @dev The chain class of the current `evaluate`, for `_notCheckable`.
    bool private _production;

    // ── Entry point ─────────────────────────────────────────────────────

    function run() external {
        (Inputs memory inp, uint256 fromBlock) = _loadInputs();
        uint256 head = _rpcBlockNumber();
        require(fromBlock <= head, "HandoverGate: deployBlock is ahead of the RPC head (wrong chain or wrong artifact)");

        address[] memory emitters = new address[](2 + inp.targets.length);
        emitters[0] = inp.diamond;
        emitters[1] = inp.timelock;
        uint256 n = 2;
        for (uint256 i; i < inp.targets.length; ++i) {
            if (inp.targets[i].kind == HandoverPlan.OwnableKind.Chainlink && inp.targets[i].addr != address(0)) {
                emitters[n++] = inp.targets[i].addr;
            }
        }
        LogEntry[] memory logs = _fetchLogs(emitters, n, fromBlock, head);
        console.log("HandoverGate: read %s role/ownership events, blocks %s..%s", logs.length, fromBlock, head);

        (string[] memory failures, string[] memory notChecked) = evaluate(inp, logs);
        _report(failures, notChecked);
        if (failures.length > 0) {
            revert(string.concat("HandoverGate: FAILED with ", vm.toString(failures.length), " finding(s) - see above"));
        }
        _printHandoverProof(inp.diamond, inp.timelock);
    }

    /// @dev What this run proved, on lines of their own that the deploy
    ///      wrappers record (`lib/handover-proof.sh`) and the launch binds
    ///      its Timelock call to (#945):
    ///        - the Diamond's role epoch (Codex #2686 r9), so a role that
    ///          changes hands after this proof makes the launch revert
    ///          instead of admitting users under holders nobody checked;
    ///        - the Timelock's executed-call count (Codex #2686 r14), so any
    ///          governance call executed after this proof (a queued pool
    ///          `transferOwnership` whose pending owner this run's event
    ///          scan never saw, say) makes the launch proposal refuse and
    ///          the gate run again.
    ///      Both are read in the same state as every holder, role admin and
    ///      owner this run compared, so a change after that state moves
    ///      one of them, and the launch never binds a value newer than the
    ///      state proved.
    function _printHandoverProof(address diamond, address timelock) internal view returns (uint64 epoch, uint64 calls) {
        try IAccessControlRead(diamond).roleEpoch() returns (uint64 e) {
            epoch = e;
        } catch {
            revert("HandoverGate: the Diamond has no roleEpoch() - it predates the launch binding (#945); fresh deploy");
        }
        bool readable;
        (readable, calls) = LibLaunchReadiness.timelockCalls(timelock);
        if (!readable) {
            revert(
                "HandoverGate: the Timelock does not count its executed calls (executedCalls) - it predates the launch binding (#945); fresh deploy"
            );
        }
        console.log("HandoverGate: every role's holders proven at role epoch", uint256(epoch));
        console.log("HandoverGate: proven after the Timelock's executed call", uint256(calls));
        console.log(string.concat("HANDOVER_ROLE_EPOCH=", vm.toString(uint256(epoch))));
        console.log(string.concat("HANDOVER_TIMELOCK_CALLS=", vm.toString(uint256(calls))));
    }

    // ── The check ───────────────────────────────────────────────────────

    /// @notice Every deviation of the live chain from the handover plan.
    /// @param  logs The Diamond's and the Timelock's role events and their
    ///         construction events (the Diamond's `OwnershipTransferred`, the
    ///         Timelock's `MinDelayChange`), and the ownership events of every
    ///         CHAINLINK-shaped target, in chain order, from the Diamond's
    ///         deploy block on.
    /// @return failures Each deviation, as one line. Empty means the gate passes.
    /// @return notChecked Each authority the gate could NOT check on this
    ///         chain (only ever non-empty off a production chain; on one,
    ///         the same item is a failure).
    function evaluate(Inputs memory inp, LogEntry[] memory logs)
        public
        returns (string[] memory failures, string[] memory notChecked)
    {
        delete _failures;
        delete _unchecked;
        _production = inp.production;

        _checkDiamond(inp, logs);
        _checkTimelock(inp, logs);
        _checkTargets(inp, logs);
        _checkCct(inp);

        return (_failures, _unchecked);
    }

    function _checkDiamond(Inputs memory inp, LogEntry[] memory logs) internal {
        IAccessControlRead ac = IAccessControlRead(inp.diamond);

        address owner_ = IOwnerRead(inp.diamond).owner();
        if (owner_ != inp.timelock) {
            _fail(string.concat("Diamond owner() is ", vm.toString(owner_), ", not the Timelock"));
        }

        (bytes32[] memory roles, address[][] memory expected) = _diamondPlan(inp);
        // Completeness: the range must contain the Diamond's construction,
        // the only place its owner is set from the zero address (#906 forbids
        // ownership ever returning to zero). Then no role event can predate
        // the range, and its first root grant is the deploy's bootstrap.
        bool born = _diamondConstructed(logs, inp.diamond);
        (bool anchored, address bootstrap) = _historyAnchor(logs, inp.diamond, HandoverPlan.DEFAULT_ADMIN_ROLE);
        anchored = anchored && born;
        if (!born) {
            _fail(
                "Diamond history in range does not reach its construction (no OwnershipTransferred from the zero address) - deployBlock is late or the log range is incomplete; holder sets below are unproven"
            );
        } else if (!anchored) {
            _fail("Diamond role history does not open with a DEFAULT_ADMIN_ROLE grant - holder sets below are unproven");
        } else {
            console.log("  Diamond bootstrap key (first root grant):", bootstrap);
        }
        _checkHolderSets("Diamond", inp.diamond, logs, roles, expected);

        // Every role must be administered by the root, so nothing below the
        // Timelock can mint or strip a role.
        for (uint256 i; i < roles.length; ++i) {
            bytes32 adminRole = ac.getRoleAdmin(roles[i]);
            if (adminRole != HandoverPlan.DEFAULT_ADMIN_ROLE) {
                _fail(
                    string.concat(
                        "Diamond ", _labelFor(roles[i]), " is administered by ", vm.toString(adminRole),
                        ", not DEFAULT_ADMIN_ROLE"
                    )
                );
            }
        }

        // Named outright as well, so the report says it in words.
        if (inp.admin != address(0)) _requireNoKnownRole(ac, roles, inp.admin, "ADMIN_ADDRESS");
        if (anchored && bootstrap != inp.admin) _requireNoKnownRole(ac, roles, bootstrap, "the deployer key");
    }

    function _checkTimelock(Inputs memory inp, LogEntry[] memory logs) internal {
        bytes32[] memory roles = new bytes32[](4);
        address[][] memory expected = new address[][](4);
        roles[0] = HandoverPlan.DEFAULT_ADMIN_ROLE;
        expected[0] = _one(inp.timelock);
        roles[1] = HandoverPlan.PROPOSER_ROLE;
        expected[1] = _one(inp.governanceSafe);
        // OpenZeppelin makes every proposer a canceller too; the Pauser Safe
        // is the independent canceller (#938).
        roles[2] = HandoverPlan.CANCELLER_ROLE;
        expected[2] = new address[](2);
        expected[2][0] = inp.governanceSafe;
        expected[2][1] = inp.pauserSafe;
        roles[3] = HandoverPlan.EXECUTOR_ROLE;
        expected[3] = _one(inp.executor);

        // Completeness, as for the Diamond: the constructor is the only place
        // the delay changes from zero (the floor, checked below, is > 0).
        if (!_timelockConstructed(logs, inp.timelock)) {
            _fail(
                "Timelock history in range does not reach its construction (no MinDelayChange from zero) - the Timelock predates deployBlock or the log range is incomplete; holder sets below are unproven"
            );
        }
        _checkHolderSets("Timelock", inp.timelock, logs, roles, expected);

        ITimelockRead tl = ITimelockRead(inp.timelock);
        uint256 delay = tl.getMinDelay();
        uint256 floor = tl.MIN_DELAY_FLOOR();
        if (floor == 0) _fail("Timelock MIN_DELAY_FLOOR is zero (a pass-through)");
        if (inp.production) {
            if (delay < 48 hours) _fail(string.concat("Timelock delay ", vm.toString(delay), "s < 48h on a production chain"));
            if (floor < 48 hours) _fail(string.concat("Timelock MIN_DELAY_FLOOR ", vm.toString(floor), "s < 48h on a production chain"));
        }
    }

    function _checkTargets(Inputs memory inp, LogEntry[] memory logs) internal {
        for (uint256 i; i < inp.targets.length; ++i) {
            HandoverPlan.Target memory t = inp.targets[i];
            if (t.addr == address(0)) {
                // HandoverPlan lists a required slot with no address when the
                // artifact lacks it. Absent is not authority-free.
                _notCheckable(string.concat(t.label, " is missing from addresses.json, so who owns it is unknown"));
                continue;
            }
            (bool ok, bytes memory ret) = t.addr.staticcall(abi.encodeWithSignature("owner()"));
            if (!ok || ret.length < 32) {
                _fail(string.concat(t.label, ": owner() unreadable at ", vm.toString(t.addr)));
                continue;
            }
            address owner_ = abi.decode(ret, (address));
            if (owner_ != inp.timelock) {
                _fail(string.concat(t.label, ": owner() is ", vm.toString(owner_), ", not the Timelock"));
            }

            if (t.kind == HandoverPlan.OwnableKind.OpenZeppelin) {
                (ok, ret) = t.addr.staticcall(abi.encodeWithSignature("pendingOwner()"));
                if (!ok || ret.length < 32) {
                    _fail(string.concat(t.label, ": pendingOwner() unreadable"));
                } else {
                    address pending = abi.decode(ret, (address));
                    if (pending != address(0)) {
                        _fail(string.concat(t.label, ": a transfer to ", vm.toString(pending), " is still pending"));
                    }
                }
            } else if (!_chainlinkTransferSettled(logs, t.addr)) {
                _fail(
                    string.concat(
                        t.label, ": its last OwnershipTransferRequested is still outstanding (pending owner is private; read from events)"
                    )
                );
            }

            // Every GuardianPausable contract's guardian is the Pauser Safe,
            // and an unreadable getter there is a failure, not a skip: the
            // artifact names the wrong contract or its implementation lost
            // the fast pause. The rate governor and the CCIP pool carry no
            // guardian; ownership above covers them. The canonical token
            // carries one since #937.
            if (t.guardian) {
                (ok, ret) = t.addr.staticcall(abi.encodeWithSignature("guardian()"));
                if (!ok || ret.length < 32) {
                    _fail(string.concat(t.label, ": guardian() unreadable - it must be GuardianPausable"));
                } else {
                    address guardian = abi.decode(ret, (address));
                    if (guardian != inp.pauserSafe) {
                        _fail(string.concat(t.label, ": guardian() is ", vm.toString(guardian), ", not the Pauser Safe"));
                    }
                }
            }
        }
    }

    function _checkCct(Inputs memory inp) internal {
        if (inp.vpfiToken == address(0)) {
            // Every chain carries VPFI (the token on Base, the mirror
            // elsewhere); an artifact without it is incomplete, not tokenless.
            _notCheckable(
                "VPFI CCT administrator NOT CHECKED: addresses.json records no VPFI token for this chain, so whoever administers its CCIP pool is unknown"
            );
            return;
        }
        if (inp.cctRegistry == address(0)) {
            _notCheckable(
                "VPFI CCT administrator NOT CHECKED: CCIP_TOKEN_ADMIN_REGISTRY is unset, so whoever administers the token's CCIP pool is unknown"
            );
            return;
        }
        (bool ok, bytes memory ret) =
            inp.cctRegistry.staticcall(abi.encodeWithSignature("getTokenConfig(address)", inp.vpfiToken));
        if (!ok || ret.length < 96) {
            _fail("VPFI CCT administrator unreadable on CCIP_TOKEN_ADMIN_REGISTRY");
            return;
        }
        (address administrator, address pendingAdministrator, address tokenPool) =
            abi.decode(ret, (address, address, address));
        if (administrator != inp.timelock) {
            _fail(string.concat("VPFI CCT administrator is ", vm.toString(administrator), ", not the Timelock"));
        }
        if (pendingAdministrator != address(0)) {
            _fail(string.concat("VPFI CCT administrator transfer to ", vm.toString(pendingAdministrator), " is still pending"));
        }
        _checkRoutedPool(inp, tokenPool);
    }

    /// @dev The ownership checks above cover the ARTIFACT's pool; CCIP routes
    ///      through the REGISTRY's (Codex #2686 r7). The two must be the same
    ///      pool, or a stale artifact proves an unused pool Timelock-owned
    ///      while VPFI moves through one nobody checked. That pool's rate
    ///      limits must also be settable only through the bounded
    ///      `VpfiPoolRateGovernor` the artifact records (itself
    ///      Timelock-owned, above): a different rate-limit admin could
    ///      disable every lane's limit outside the governor's bounds.
    function _checkRoutedPool(Inputs memory inp, address tokenPool) internal {
        if (inp.vpfiPool == address(0)) {
            _notCheckable("VPFI pool binding NOT CHECKED: addresses.json records no vpfiTokenPool");
            return;
        }
        if (tokenPool != inp.vpfiPool) {
            _fail(
                string.concat(
                    "the CCIP registry routes VPFI through ",
                    vm.toString(tokenPool),
                    ", not the artifact's vpfiTokenPool ",
                    vm.toString(inp.vpfiPool)
                )
            );
            return;
        }
        if (inp.rateGovernor == address(0)) {
            _notCheckable("VPFI pool rate-limit admin NOT CHECKED: addresses.json records no vpfiPoolRateGovernor");
            return;
        }
        (bool ok, bytes memory ret) = tokenPool.staticcall(abi.encodeWithSignature("getRateLimitAdmin()"));
        if (!ok || ret.length < 32) {
            _fail("VPFI pool getRateLimitAdmin() unreadable");
            return;
        }
        address rateAdmin = abi.decode(ret, (address));
        if (rateAdmin != inp.rateGovernor) {
            _fail(
                string.concat(
                    "VPFI pool rate-limit admin is ",
                    vm.toString(rateAdmin),
                    ", not the artifact's VpfiPoolRateGovernor ",
                    vm.toString(inp.rateGovernor)
                )
            );
        }
    }

    // ── Role holders ────────────────────────────────────────────────────

    /// @dev The Diamond half of the plan: each known role and who must hold it.
    ///      The role list is `HandoverPlan.diamondRoles()`, the same list the
    ///      launch checks the admin key against.
    function _diamondPlan(Inputs memory inp) internal pure returns (bytes32[] memory roles, address[][] memory expected) {
        roles = HandoverPlan.diamondRoles();
        bytes32[] memory bots = HandoverPlan.botRoles();
        expected = new address[][](roles.length);
        for (uint256 k; k < roles.length; ++k) {
            bytes32 role = roles[k];
            if (role == LibAccessControl.PAUSER_ROLE) {
                expected[k] = _one(inp.pauserSafe);
                continue;
            }
            if (role == LibAccessControl.EMERGENCY_REVOKER_ROLE) {
                expected[k] = _one(inp.governanceSafe);
                continue;
            }
            expected[k] = _one(inp.timelock);
            for (uint256 i; i < bots.length; ++i) {
                if (role == bots[i]) {
                    expected[k] = inp.botHolders[i] == address(0) ? new address[](0) : _one(inp.botHolders[i]);
                }
            }
        }
    }

    /// @dev Rebuilds every (role, account) pair `emitter` currently grants
    ///      from its role events, then requires: each known role's holders
    ///      are exactly the expected set; no role outside the known set has
    ///      a holder; and the chain agrees (`hasRole`) with every rebuilt and
    ///      every expected holder.
    function _checkHolderSets(
        string memory who,
        address emitter,
        LogEntry[] memory logs,
        bytes32[] memory roles,
        address[][] memory expected
    ) internal {
        (bytes32[] memory pr, address[] memory pa, bool[] memory held, uint256 np) = _replayRoles(logs, emitter);
        IAccessControlRead ac = IAccessControlRead(emitter);

        for (uint256 p; p < np; ++p) {
            string memory label = _labelFor(pr[p]);
            // Every pair the events ever named is compared with the chain in
            // BOTH directions: a pair whose last event was a revoke but which
            // still holds the role is a live holder the replay would miss.
            bool live = ac.hasRole(pr[p], pa[p]);
            if (live != held[p]) {
                _fail(
                    string.concat(
                        who, " events say ", vm.toString(pa[p]), held[p] ? " holds " : " does not hold ", label,
                        " but hasRole says ", live ? "yes" : "no", " - the log range is incomplete"
                    )
                );
            }
            if (!held[p] && !live) continue;
            (bool known, uint256 r) = _indexOf(roles, pr[p]);
            if (!known) {
                _fail(string.concat(who, " role ", label, " (not in the plan) is held by ", vm.toString(pa[p])));
            } else if (!_contains(expected[r], pa[p])) {
                _fail(string.concat(who, " ", label, " is held by ", vm.toString(pa[p]), ", which the plan does not name"));
            }
        }
        for (uint256 r; r < roles.length; ++r) {
            for (uint256 e; e < expected[r].length; ++e) {
                address acct = expected[r][e];
                if (!ac.hasRole(roles[r], acct)) {
                    _fail(string.concat(who, " ", _labelFor(roles[r]), " is not held by ", vm.toString(acct)));
                } else if (!_heldInReplay(pr, pa, held, np, roles[r], acct)) {
                    _fail(
                        string.concat(
                            who, " ", _labelFor(roles[r]), " holder ", vm.toString(acct),
                            " has no grant event in range - the log range is incomplete"
                        )
                    );
                }
            }
        }
    }

    function _replayRoles(LogEntry[] memory logs, address emitter)
        internal
        pure
        returns (bytes32[] memory roles, address[] memory accounts, bool[] memory held, uint256 n)
    {
        roles = new bytes32[](logs.length);
        accounts = new address[](logs.length);
        held = new bool[](logs.length);
        for (uint256 i; i < logs.length; ++i) {
            LogEntry memory l = logs[i];
            if (l.emitter != emitter || l.topics.length < 3) continue;
            bool granted = l.topics[0] == ROLE_GRANTED;
            if (!granted && l.topics[0] != ROLE_REVOKED) continue;
            bytes32 role = l.topics[1];
            address account = address(uint160(uint256(l.topics[2])));
            uint256 j;
            for (; j < n; ++j) {
                if (roles[j] == role && accounts[j] == account) break;
            }
            if (j == n) {
                roles[n] = role;
                accounts[n] = account;
                ++n;
            }
            held[j] = granted;
        }
    }

    /// @dev Whether `emitter`'s first role event is a grant of `rootRole`,
    ///      and to whom. A history cut short at the front fails this.
    function _historyAnchor(LogEntry[] memory logs, address emitter, bytes32 rootRole)
        internal
        pure
        returns (bool, address)
    {
        for (uint256 i; i < logs.length; ++i) {
            LogEntry memory l = logs[i];
            if (l.emitter != emitter || l.topics.length < 3) continue;
            if (l.topics[0] != ROLE_GRANTED && l.topics[0] != ROLE_REVOKED) continue;
            if (l.topics[0] == ROLE_GRANTED && l.topics[1] == rootRole) {
                return (true, address(uint160(uint256(l.topics[2]))));
            }
            return (false, address(0));
        }
        return (false, address(0));
    }

    /// @dev Whether `logs` contain the Diamond's construction: its ERC-173
    ///      owner set from the zero address. Only the constructor does that,
    ///      since ownership can never be transferred to zero (#906).
    function _diamondConstructed(LogEntry[] memory logs, address diamond) internal pure returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            LogEntry memory l = logs[i];
            if (
                l.emitter == diamond && l.topics.length >= 3 && l.topics[0] == OWNERSHIP_TRANSFERRED
                    && l.topics[1] == bytes32(0)
            ) return true;
        }
        return false;
    }

    /// @dev Whether `logs` contain the Timelock's construction:
    ///      `MinDelayChange(0, minDelay)`, emitted by OpenZeppelin's
    ///      constructor. A later `updateDelay` reports the previous delay,
    ///      which is never zero once the floor is (checked separately).
    function _timelockConstructed(LogEntry[] memory logs, address timelock) internal pure returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            LogEntry memory l = logs[i];
            if (l.emitter != timelock || l.topics.length == 0 || l.topics[0] != MIN_DELAY_CHANGE) continue;
            if (l.data.length >= 64) {
                (uint256 oldDuration,) = abi.decode(l.data, (uint256, uint256));
                if (oldDuration == 0) return true;
            }
        }
        return false;
    }

    /// @dev CHAINLINK's two-step ownership keeps its pending owner private,
    ///      so it is read from the events (GovernanceRunbook step 6): the
    ///      LAST `OwnershipTransferRequested` is settled when it names zero
    ///      (a cancellation) or a LATER `OwnershipTransferred` names the same
    ///      new owner. No request at all is settled.
    function _chainlinkTransferSettled(LogEntry[] memory logs, address target) internal pure returns (bool) {
        uint256 last = type(uint256).max;
        address pendingTo;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != target || logs[i].topics.length < 3) continue;
            if (logs[i].topics[0] == OWNERSHIP_REQUESTED) {
                last = i;
                pendingTo = address(uint160(uint256(logs[i].topics[2])));
            }
        }
        if (last == type(uint256).max || pendingTo == address(0)) return true;
        for (uint256 i = last + 1; i < logs.length; ++i) {
            if (logs[i].emitter != target || logs[i].topics.length < 3) continue;
            if (
                logs[i].topics[0] == OWNERSHIP_TRANSFERRED
                    && address(uint160(uint256(logs[i].topics[2]))) == pendingTo
            ) return true;
        }
        return false;
    }

    function _requireNoKnownRole(IAccessControlRead ac, bytes32[] memory roles, address who, string memory name)
        internal
    {
        for (uint256 i; i < roles.length; ++i) {
            if (ac.hasRole(roles[i], who)) {
                _fail(string.concat(name, " (", vm.toString(who), ") still holds Diamond ", _labelFor(roles[i])));
            }
        }
    }

    // ── Inputs and logs ─────────────────────────────────────────────────

    function _loadInputs() internal returns (Inputs memory inp, uint256 fromBlock) {
        string memory path = _resolveAddressesPath();
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(path);
        inp.diamond = _readRequired(json, "diamond", path);
        inp.timelock = _readRequired(json, "timelock", path);
        try vm.parseJsonUint(json, ".deployBlock") returns (uint256 b) {
            fromBlock = b;
        } catch {
            revert(string.concat("HandoverGate: no deployBlock in ", path, " - the role history cannot be bounded"));
        }
        inp.admin = vm.envAddress("ADMIN_ADDRESS");
        inp.governanceSafe = vm.envAddress("EMERGENCY_REVOKER_ADDRESS");
        inp.pauserSafe = vm.envAddress("PAUSER_ADDRESS");
        inp.executor = vm.envOr("TIMELOCK_EXECUTOR", address(0));
        string[] memory botEnv = HandoverPlan.botRoleEnvNames();
        inp.botHolders = new address[](botEnv.length);
        for (uint256 i; i < botEnv.length; ++i) {
            inp.botHolders[i] = vm.envAddress(botEnv[i]);
        }
        inp.targets = HandoverPlan.targets(json, inp.diamond, inp.timelock);
        inp.vpfiToken = HandoverPlan.vpfiToken(json);
        inp.vpfiPool = HandoverPlan.readOptional(json, "vpfiTokenPool");
        inp.rateGovernor = HandoverPlan.readOptional(json, "vpfiPoolRateGovernor");
        inp.cctRegistry = vm.envOr("CCIP_TOKEN_ADMIN_REGISTRY", address(0));
        inp.production = Deployments.requiresProductionGovernance();
    }

    /// @dev The Diamond's and the Timelock's role and construction events and
    ///      every CHAINLINK target's ownership events, `chunk` blocks per
    ///      call, merged into chain order.
    function _fetchLogs(address[] memory emitters, uint256 count, uint256 fromBlock, uint256 head)
        internal
        returns (LogEntry[] memory merged)
    {
        uint256 chunk = vm.envOr("HANDOVER_GATE_LOG_CHUNK", uint256(5000));
        require(chunk > 0, "HANDOVER_GATE_LOG_CHUNK must be > 0");
        LogEntry[] memory acc = new LogEntry[](0);
        for (uint256 e; e < count; ++e) {
            // Diamond: role events + its ownership (the construction anchor).
            // Timelock: role events + MinDelayChange (its anchor). A CHAINLINK
            // target: its two ownership events.
            bytes32[3] memory sigs;
            if (e == 0) sigs = [ROLE_GRANTED, ROLE_REVOKED, OWNERSHIP_TRANSFERRED];
            else if (e == 1) sigs = [ROLE_GRANTED, ROLE_REVOKED, MIN_DELAY_CHANGE];
            else sigs = [OWNERSHIP_REQUESTED, OWNERSHIP_TRANSFERRED, bytes32(0)];
            for (uint256 s; s < 3; ++s) {
                if (sigs[s] == bytes32(0)) continue;
                bytes32[] memory topics = new bytes32[](1);
                topics[0] = sigs[s];
                for (uint256 b = fromBlock; b <= head; b += chunk) {
                    uint256 to = b + chunk - 1 > head ? head : b + chunk - 1;
                    Vm.EthGetLogs[] memory got = vm.eth_getLogs(b, to, emitters[e], topics);
                    acc = _append(acc, got);
                }
            }
        }
        merged = _sortByOrder(acc);
    }

    function _append(LogEntry[] memory acc, Vm.EthGetLogs[] memory got) internal pure returns (LogEntry[] memory out) {
        out = new LogEntry[](acc.length + got.length);
        for (uint256 i; i < acc.length; ++i) {
            out[i] = acc[i];
        }
        for (uint256 i; i < got.length; ++i) {
            out[acc.length + i] = LogEntry({
                emitter: got[i].emitter,
                topics: got[i].topics,
                data: got[i].data,
                order: (uint256(got[i].blockNumber) << 128) | got[i].logIndex
            });
        }
    }

    function _sortByOrder(LogEntry[] memory a) internal pure returns (LogEntry[] memory) {
        for (uint256 i = 1; i < a.length; ++i) {
            LogEntry memory x = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1].order > x.order) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = x;
        }
        return a;
    }

    /// @dev The RPC's own head, in the numbering `eth_getLogs` uses (the L2
    ///      height on Arbitrum, where the in-EVM `block.number` is L1's).
    function _rpcBlockNumber() internal returns (uint256 n) {
        bytes memory raw = vm.rpc("eth_blockNumber", "[]");
        require(raw.length > 0 && raw.length <= 32, "HandoverGate: unreadable eth_blockNumber");
        for (uint256 i; i < raw.length; ++i) {
            n = (n << 8) | uint8(raw[i]);
        }
    }

    function _report(string[] memory failures, string[] memory notChecked) internal pure {
        console.log("");
        console.log("=========================================================");
        if (failures.length == 0) {
            console.log("HandoverGate: PASSED");
        } else {
            console.log("HandoverGate: FAILED - %s finding(s):", failures.length);
            for (uint256 i; i < failures.length; ++i) {
                console.log(string.concat("  FAIL ", failures[i]));
            }
        }
        for (uint256 i; i < notChecked.length; ++i) {
            console.log(string.concat("  UNCHECKED ", notChecked[i]));
        }
        console.log("=========================================================");
    }

    // ── Small helpers ───────────────────────────────────────────────────

    function _fail(string memory what) internal {
        _failures.push(what);
    }

    /// @dev Something the gate cannot check on this chain: a failure on a
    ///      production chain, reported as not checked on a testnet.
    function _notCheckable(string memory what) internal {
        if (_production) _fail(what);
        else _unchecked.push(what);
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _contains(address[] memory set, address a) internal pure returns (bool) {
        for (uint256 i; i < set.length; ++i) {
            if (set[i] == a) return true;
        }
        return false;
    }

    function _indexOf(bytes32[] memory set, bytes32 x) internal pure returns (bool, uint256) {
        for (uint256 i; i < set.length; ++i) {
            if (set[i] == x) return (true, i);
        }
        return (false, 0);
    }

    function _heldInReplay(
        bytes32[] memory pr,
        address[] memory pa,
        bool[] memory held,
        uint256 np,
        bytes32 role,
        address acct
    ) internal pure returns (bool) {
        for (uint256 p; p < np; ++p) {
            if (pr[p] == role && pa[p] == acct) return held[p];
        }
        return false;
    }

    function _labelFor(bytes32 role) internal pure returns (string memory) {
        if (role == HandoverPlan.DEFAULT_ADMIN_ROLE) return "DEFAULT_ADMIN_ROLE";
        if (role == LibAccessControl.ADMIN_ROLE) return "ADMIN_ROLE";
        if (role == LibAccessControl.PAUSER_ROLE) return "PAUSER_ROLE";
        if (role == LibAccessControl.UNPAUSER_ROLE) return "UNPAUSER_ROLE";
        if (role == LibAccessControl.KYC_ADMIN_ROLE) return "KYC_ADMIN_ROLE";
        if (role == LibAccessControl.ORACLE_ADMIN_ROLE) return "ORACLE_ADMIN_ROLE";
        if (role == LibAccessControl.RISK_ADMIN_ROLE) return "RISK_ADMIN_ROLE";
        if (role == LibAccessControl.VAULT_ADMIN_ROLE) return "VAULT_ADMIN_ROLE";
        if (role == LibAccessControl.WATCHER_ROLE) return "WATCHER_ROLE";
        if (role == LibAccessControl.NOTIF_BILLER_ROLE) return "NOTIF_BILLER_ROLE";
        if (role == LibAccessControl.KEEPER_ROLE) return "KEEPER_ROLE";
        if (role == LibAccessControl.EMERGENCY_REVOKER_ROLE) return "EMERGENCY_REVOKER_ROLE";
        if (role == HandoverPlan.PROPOSER_ROLE) return "PROPOSER_ROLE";
        if (role == HandoverPlan.EXECUTOR_ROLE) return "EXECUTOR_ROLE";
        if (role == HandoverPlan.CANCELLER_ROLE) return "CANCELLER_ROLE";
        return vm.toString(role);
    }

    function _resolveAddressesPath() internal returns (string memory) {
        try vm.envString("ADDRESSES_JSON_PATH") returns (string memory p) {
            if (bytes(p).length > 0) return p;
        } catch {}
        string memory slug = vm.envString("CHAIN_SLUG");
        require(bytes(slug).length > 0, "Set CHAIN_SLUG or ADDRESSES_JSON_PATH");
        return Deployments.pathForSlug(slug);
    }

    function _readRequired(string memory json, string memory key, string memory path) internal pure returns (address) {
        try vm.parseJsonAddress(json, string.concat(".", key)) returns (address a) {
            require(a != address(0), string.concat("HandoverGate: '", key, "' is zero in ", path));
            return a;
        } catch {
            revert(string.concat("HandoverGate: missing key '", key, "' in ", path));
        }
    }
}

interface IAccessControlRead {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function getRoleAdmin(bytes32 role) external view returns (bytes32);
    function roleEpoch() external view returns (uint64);
}

interface IOwnerRead {
    function owner() external view returns (address);
}

interface ITimelockRead {
    function getMinDelay() external view returns (uint256);
    function MIN_DELAY_FLOOR() external view returns (uint256);
}
