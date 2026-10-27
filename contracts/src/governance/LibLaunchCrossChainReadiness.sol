// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibLaunchReadiness, ILaunchReadableDiamond} from "./LibLaunchReadiness.sol";
import {VpfiPoolRateBounds} from "../crosschain/VpfiPoolRateBounds.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title LibLaunchCrossChainReadiness
 * @notice The cross-chain half of the launch requirements (#945, #2975):
 *         the VPFI pool the CCIP registry routes the Diamond's token through,
 *         and the lanes that pool carries.
 *
 * @dev These are two entries of the ONE list {LibLaunchReadiness.check}
 *      composes; they live in their own library only so that
 *      {LaunchGate}, which must re-read the whole list on-chain, can host
 *      them in a companion contract ({LaunchCrossChainChecks}) instead of
 *      inlining all ten checks into one contract over the EIP-170 limit.
 *      The launch script still reads both halves through
 *      {LibLaunchReadiness.check}, so the script and the gate cannot
 *      disagree on what is checked or in what order.
 */
library LibLaunchCrossChainReadiness {
    /// @dev The most lanes the CCIP check reads. Every lane costs four probes,
    ///      so the bound keeps the gate's execution bounded; a pool with more
    ///      is reported NOT CHECKED rather than read in part.
    uint256 internal constant MAX_LANES = 32;

    /// @notice The two cross-chain requirements, in the order
    ///         {LibLaunchReadiness.compose} places them: the VPFI pool, then
    ///         its CCIP lanes.
    /// @param diamond The Diamond to read.
    /// @param declared What the chain must match. The VPFI pool is read FROM
    ///        the registry, for the token the Diamond itself records, and
    ///        then compared with the declared one.
    function checks(address diamond, LibLaunchReadiness.Declared memory declared)
        internal
        view
        returns (LibLaunchReadiness.Check[2] memory c)
    {
        VpfiRoute memory route = _vpfiRoute(diamond, declared.tokenAdminRegistry);
        c[0] = _vpfiPool(diamond, route, declared);
        c[1] = _ccipLanes(diamond, route, declared);
    }

    /// @dev The Diamond's VPFI token and the pool the CCIP registry routes it
    ///      through, read once for both CCIP checks.
    struct VpfiRoute {
        /// @dev The token and (when there is one) the pool were read.
        bool readable;
        address token;
        address pool;
        string detail;
    }

    function _vpfiRoute(address diamond, address registry) private view returns (VpfiRoute memory r) {
        try ILaunchReadableDiamond(diamond).getVPFIToken() returns (address t) {
            r.token = t;
        } catch {
            r.detail = "getVPFIToken() unreadable";
            return r;
        }
        if (r.token == address(0)) {
            r.readable = true;
            return r;
        }
        if (registry == address(0)) {
            r.detail = "no CCIP TokenAdminRegistry given (CCIP_TOKEN_ADMIN_REGISTRY), so the VPFI pool is unknown";
            return r;
        }
        (bool ok, bytes memory ret) =
            registry.staticcall{gas: LibLaunchReadiness.PROBE_GAS}(abi.encodeWithSignature("getPool(address)", r.token));
        if (!ok || ret.length != 32 || uint256(bytes32(ret)) >> 160 != 0) {
            r.detail = "getPool(vpfiToken) unreadable on the TokenAdminRegistry";
            return r;
        }
        r.readable = true;
        r.pool = address(uint160(uint256(bytes32(ret))));
    }

    /// @dev A deployment with no VPFI token (`deploy-chain.sh --skip-vpfi`)
    ///      carries no cross-chain VPFI, and both CCIP checks say so as MET
    ///      only when the launch declares none either; a declared pool or
    ///      lane with no token behind it is NOT MET (Codex #2686 r7).
    function _noVpfi(LibLaunchReadiness.Check memory c, LibLaunchReadiness.Declared memory declared) private pure {
        c.checkable = true;
        c.met = declared.vpfiPool == address(0) && declared.lanes.length == 0;
        c.detail = c.met
            ? "not applicable: the Diamond records no VPFI token and the launch declares no VPFI pool or lane, so this deployment carries no cross-chain VPFI"
            : "the Diamond records no VPFI token, yet the launch declares a VPFI pool or lane: run the configure phase";
    }

    /// @dev The registry must route the Diamond's VPFI token through the
    ///      DECLARED pool, and that route must be governed by the Diamond's
    ///      own owner (the Timelock on production) at the moment of the read.
    ///      Binding the address alone is not enough (Codex #2686 r7, r8):
    ///      the handover gate proves the authorities before the proposal, but
    ///      another operation queued in the same delay could re-point the
    ///      pool's rate-limit admin, its owner, the governor's owner or the
    ///      token's registry administrator, and the launch would then open a
    ///      route someone else can uncap. So the gate re-reads, in the
    ///      transaction that unpauses:
    ///        - the registry's VPFI administrator is the Diamond's owner, with
    ///          no transfer pending;
    ///        - the pool's owner is the Diamond's owner;
    ///        - the pool's rate-limit admin is the declared governor;
    ///        - the governor is owned by the Diamond's owner, with no transfer
    ///          pending, and administers this pool.
    ///      What it cannot read: a CCIP pool keeps its pending owner private,
    ///      so a transfer the owner has started and nobody accepted yet is
    ///      invisible here (the handover gate reads it from the pool's
    ///      events). Accepting it would itself need a later transaction.
    function _vpfiPool(address diamond, VpfiRoute memory route, LibLaunchReadiness.Declared memory declared)
        private
        view
        returns (LibLaunchReadiness.Check memory c)
    {
        c.label = "VPFI routes through the declared pool, governed by the Diamond's owner";
        if (!route.readable) {
            c.detail = route.detail;
            return c;
        }
        if (route.token == address(0)) {
            _noVpfi(c, declared);
            return c;
        }
        if (route.pool == address(0)) {
            c.checkable = true;
            c.detail = "the TokenAdminRegistry maps no pool to the Diamond's VPFI token: run the ccip-wire phase";
            return c;
        }
        if (declared.vpfiPool == address(0) || declared.rateGovernor == address(0)) {
            c.detail = "no VPFI pool or rate governor declared (the artifact records no vpfiTokenPool or vpfiPoolRateGovernor) to compare the route against";
            return c;
        }
        if (route.pool != declared.vpfiPool) {
            c.checkable = true;
            c.detail = "the TokenAdminRegistry routes the Diamond's VPFI token through a pool other than the declared one (the pool the handover gate checked)";
            return c;
        }
        address governance;
        try ILaunchReadableDiamond(diamond).owner() returns (address o) {
            governance = o;
        } catch {
            c.detail = "the Diamond's owner() unreadable";
            return c;
        }
        (bool ok, bytes memory ret) = declared.tokenAdminRegistry.staticcall{gas: LibLaunchReadiness.PROBE_GAS}(
            abi.encodeWithSignature("getTokenConfig(address)", route.token)
        );
        if (!ok || ret.length != 96) {
            c.detail = "getTokenConfig(vpfiToken) unreadable on the TokenAdminRegistry";
            return c;
        }
        (uint256 administrator, uint256 pendingAdministrator,) = abi.decode(ret, (uint256, uint256, uint256));
        (bool poolOwnerRead, address poolOwner) = _readAddress(route.pool, abi.encodeWithSignature("owner()"));
        (bool rateAdminRead, address rateAdmin) =
            _readAddress(route.pool, abi.encodeWithSignature("getRateLimitAdmin()"));
        (bool govOwnerRead, address govOwner) = _readAddress(declared.rateGovernor, abi.encodeWithSignature("owner()"));
        (bool govPendingRead, address govPending) =
            _readAddress(declared.rateGovernor, abi.encodeWithSignature("pendingOwner()"));
        (bool govPoolRead, address govPool) = _readAddress(declared.rateGovernor, abi.encodeWithSignature("pool()"));
        if (
            administrator >> 160 != 0 || pendingAdministrator >> 160 != 0 || !poolOwnerRead || !rateAdminRead
                || !govOwnerRead || !govPendingRead || !govPoolRead
        ) {
            c.detail = "an authority of the VPFI route (registry administrator, pool owner or rate admin, governor owner or pool) is unreadable";
            return c;
        }
        address mintAuthority;
        address tokenOwner;
        address tokenPending;
        if (declared.mirrorToken) {
            bool mintRead;
            bool tokenOwnerRead;
            bool tokenPendingRead;
            (mintRead, mintAuthority) = _readAddress(route.token, abi.encodeWithSignature("tokenPool()"));
            (tokenOwnerRead, tokenOwner) = _readAddress(route.token, abi.encodeWithSignature("owner()"));
            (tokenPendingRead, tokenPending) = _readAddress(route.token, abi.encodeWithSignature("pendingOwner()"));
            if (!mintRead || !tokenOwnerRead || !tokenPendingRead) {
                c.detail = "the mirror VPFI token's mint authority (tokenPool) or its owner is unreadable";
                return c;
            }
        }
        c.checkable = true;
        if (address(uint160(administrator)) != governance || pendingAdministrator != 0) {
            c.detail = "the registry's VPFI administrator is not the Diamond's owner, or a transfer of it is pending";
        } else if (poolOwner != governance) {
            c.detail = "the VPFI pool's owner is not the Diamond's owner";
        } else if (rateAdmin != declared.rateGovernor) {
            c.detail = "the VPFI pool's rate-limit admin is not the declared rate governor, so its limits could be changed outside the governor's bounds";
        } else if (govOwner != governance || govPending != address(0) || govPool != route.pool) {
            c.detail = "the rate governor is not owned by the Diamond's owner, has an ownership transfer pending, or administers another pool";
        } else if (declared.mirrorToken && mintAuthority != route.pool) {
            c.detail = "the mirror VPFI token's mint and burn authority (tokenPool) is not the routed pool: the route cannot deliver, and whoever it names can mint";
        } else if (declared.mirrorToken && (tokenOwner != governance || tokenPending != address(0))) {
            c.detail = "the mirror VPFI token is not owned by the Diamond's owner, or a transfer of it is pending, so its mint authority could be re-pointed";
        } else {
            c.met = true;
            c.detail = declared.mirrorToken
                ? "the TokenAdminRegistry routes VPFI through the declared pool, the mirror token's mint authority is that pool, and the registry administrator, the pool owner, the rate governor's owner and the token's owner are all the Diamond's owner (a CCIP pool's pending owner is private: the handover gate reads it from events, and the launch refuses any Timelock call after its proposal)"
                : "the TokenAdminRegistry routes VPFI through the declared pool, and the registry administrator, the pool owner and the rate governor's owner are all the Diamond's owner (a CCIP pool's pending owner is private: the handover gate reads it from events, and the launch refuses any Timelock call after its proposal)";
        }
    }

    /// @dev One `address` answer from `target`, or unreadable.
    function _readAddress(address target, bytes memory call) private view returns (bool, address) {
        (bool ok, bytes memory ret) = target.staticcall{gas: LibLaunchReadiness.PROBE_GAS}(call);
        if (!ok || ret.length != 32 || uint256(bytes32(ret)) >> 160 != 0) return (false, address(0));
        return (true, address(uint160(uint256(bytes32(ret)))));
    }

    /// @dev The pool CCIP actually routes VPFI through must carry EXACTLY
    ///      the declared lanes: every declared lane present, so no
    ///      destination of the topology is left unreachable, and no lane
    ///      beyond them, since an undeclared lane is an unreviewed route
    ///      (Codex #2686 r7). And EVERY lane must carry the rate limits the
    ///      mainnet gate requires: inbound and outbound enabled, with
    ///      capacity and refill rate inside the `VpfiPoolRateGovernor`
    ///      bounds. A lane whose limiter is disabled moves tokens with no
    ///      cap at all (CCIP skips a disabled bucket), which is the state a
    ///      wiring run leaves when the lane landed and its limits did not
    ///      (Codex #2686 r6). And every declared lane must reach exactly its
    ///      declared peer, the remote token and the one remote pool, since a
    ///      selector alone says nothing about where its messages go (Codex
    ///      #2686 r11).
    ///
    ///      #918 adds an ADVISORY that never changes `met`: when the smallest
    ///      lane capacity is below the largest fresh day slice the schedule
    ///      can owe (twice the day-1 half-pool), the detail says such a day is
    ///      remitted in several parts. That is supported behaviour (the owner's
    ///      "send in parts" decision), so it is disclosed, not refused; the
    ///      blocking form of the same comparison is in ConfigureCcip.
    function _ccipLanes(address diamond, VpfiRoute memory route, LibLaunchReadiness.Declared memory declared)
        private
        view
        returns (LibLaunchReadiness.Check memory c)
    {
        c.label = "CCIP lanes are exactly the declared set, rate-limited";
        if (!route.readable) {
            c.detail = route.detail;
            return c;
        }
        if (route.token == address(0)) {
            _noVpfi(c, declared);
            return c;
        }
        if (route.pool == address(0)) {
            c.checkable = true;
            c.detail = "the TokenAdminRegistry maps no pool to the Diamond's VPFI token: run the ccip-wire phase";
            return c;
        }
        (bool ok, bytes memory ret) = route.pool.staticcall{gas: LibLaunchReadiness.PROBE_GAS}(abi.encodeWithSignature("getSupportedChains()"));
        (bool wellFormed, uint256 count) = ok ? LibLaunchReadiness.dynamicLength(ret, true) : (false, 0);
        if (!wellFormed) {
            c.detail = "getSupportedChains() unreadable on the registry's VPFI pool";
            return c;
        }
        if (count == 0) {
            c.checkable = true;
            c.detail = "the registry's VPFI pool has no lane: run the ccip-wire phase";
            return c;
        }
        if (count > MAX_LANES || declared.lanes.length > MAX_LANES) {
            c.detail = "more lanes than the check reads";
            return c;
        }
        if (declared.lanes.length == 0) {
            c.detail = "no lane set declared (CCIP_LANE_CHAIN_IDS), so whether every destination is wired is unknown";
            return c;
        }
        // Decoded as full words, which cannot revert once the shape above is
        // checked; each word is then range-checked as a chain selector.
        uint256[] memory selectors = abi.decode(ret, (uint256[]));
        for (uint256 i; i < count; ++i) {
            if (selectors[i] > type(uint64).max) {
                c.detail = "getSupportedChains() returned a value that is no chain selector";
                return c;
            }
        }
        c.checkable = true;
        // Both containments, so the sets are equal whatever duplicates the
        // declared list carries.
        for (uint256 i; i < declared.lanes.length; ++i) {
            if (!_contains(selectors, count, declared.lanes[i].selector)) {
                c.detail = string.concat(
                    "declared lane ",
                    Strings.toString(declared.lanes[i].selector),
                    " is not on the registry's VPFI pool: run the ccip-wire phase for every chain in CCIP_LANE_CHAIN_IDS"
                );
                return c;
            }
        }
        for (uint256 i; i < count; ++i) {
            if (!_declares(declared.lanes, uint64(selectors[i]))) {
                c.detail = string.concat(
                    "the registry's VPFI pool carries lane ",
                    Strings.toString(selectors[i]),
                    ", which is not declared: an undeclared lane is an unreviewed route"
                );
                return c;
            }
        }
        for (uint256 i; i < declared.lanes.length; ++i) {
            (bool peerRead, string memory peerDetail) = _lanePeer(route.pool, declared.lanes[i]);
            if (bytes(peerDetail).length != 0) {
                c.checkable = peerRead;
                c.detail = peerDetail;
                return c;
            }
        }
        uint256 minCapacity = type(uint256).max;
        for (uint256 i; i < count; ++i) {
            for (uint256 dir; dir < 2; ++dir) {
                (bool readable, bool bounded, uint256 capacity) =
                    _laneLimited(route.pool, uint64(selectors[i]), dir == 0);
                if (capacity < minCapacity) minCapacity = capacity;
                if (!readable) {
                    c.checkable = false;
                    c.detail = "a lane's rate-limiter state is unreadable on the registry's VPFI pool";
                    return c;
                }
                if (!bounded) {
                    c.detail = dir == 0
                        ? "a lane's INBOUND rate limit is disabled or outside the governor's bounds: run the ccip-wire phase's rate limits"
                        : "a lane's OUTBOUND rate limit is disabled or outside the governor's bounds: run the ccip-wire phase's rate limits";
                    return c;
                }
            }
        }
        c.met = true;
        c.detail = string.concat(
            "the registry's VPFI pool carries exactly the ",
            Strings.toString(count),
            " declared lane(s), each reaching exactly its declared remote pool and token and rate-limited both ways within the governor's bounds",
            _partsAdvisory(diamond, minCapacity)
        );
    }

    /// @dev #918: the advisory suffix for the lane check — empty unless the
    ///      smallest lane capacity is below the largest fresh day slice the
    ///      emission schedule can owe, in which case it says such a day goes
    ///      in several parts. An unreadable schedule says so rather than
    ///      staying silent, since the comparison was then not made.
    function _partsAdvisory(address diamond, uint256 minCapacity) private view returns (string memory) {
        (bool ok, bytes memory ret) = diamond.staticcall{gas: LibLaunchReadiness.PROBE_GAS}(
            abi.encodeCall(ILaunchReadableDiamond.getInteractionHalfPoolForDay, (uint256(1)))
        );
        if (!ok || ret.length != 32) {
            return "; advisory: the day-1 half-pool is unreadable, so whether a day's fresh slice fits one lane transfer is unknown";
        }
        uint256 slice = 2 * abi.decode(ret, (uint256));
        if (minCapacity >= slice) return "";
        return string.concat(
            "; advisory: the smallest lane capacity (",
            Strings.toString(minCapacity),
            ") is below the largest fresh day slice (",
            Strings.toString(slice),
            "), so such a day is remitted in several parts and opens on the mirror only once every part has landed (#918)"
        );
    }

    /// @dev Whether `lane`'s peer on `pool` is exactly the declared one: the
    ///      remote token, and the remote pool as the ONLY pool the lane
    ///      accepts (a second one is an unreviewed inbound source). Compared
    ///      byte for byte with the canonical encoding of the declared value,
    ///      so a malformed answer is a mismatch, never a revert. Returns an
    ///      empty detail when the peer matches; otherwise the detail, with
    ///      `readable` false when the pool could not answer or nothing was
    ///      declared to compare it with.
    function _lanePeer(address pool, LibLaunchReadiness.Lane memory lane) private view returns (bool readable, string memory detail) {
        string memory which = Strings.toString(lane.selector);
        if (lane.remotePool == address(0) || lane.remoteToken == address(0)) {
            return (false, string.concat("lane ", which, ": no remote pool or token declared (that chain's artifact records none) to compare its peer against"));
        }
        (bool tokenOk, bytes memory token) =
            pool.staticcall{gas: LibLaunchReadiness.PROBE_GAS}(abi.encodeWithSignature("getRemoteToken(uint64)", lane.selector));
        (bool poolsOk, bytes memory pools) =
            pool.staticcall{gas: LibLaunchReadiness.PROBE_GAS}(abi.encodeWithSignature("getRemotePools(uint64)", lane.selector));
        if (!tokenOk || !poolsOk) {
            return (false, string.concat("lane ", which, ": getRemoteToken or getRemotePools unreadable on the registry's VPFI pool"));
        }
        bytes[] memory expectedPools = new bytes[](1);
        expectedPools[0] = abi.encode(lane.remotePool);
        if (keccak256(token) != keccak256(abi.encode(abi.encode(lane.remoteToken)))) {
            return (true, string.concat("lane ", which, ": its remote token is not the declared one, so outbound transfers would mint or release another asset: run the ccip-wire phase"));
        }
        if (keccak256(pools) != keccak256(abi.encode(expectedPools))) {
            return (true, string.concat("lane ", which, ": its remote pools are not exactly the declared one (missing, wrong, or an extra pool the review never saw): run the ccip-wire phase"));
        }
        return (true, "");
    }

    function _contains(uint256[] memory words, uint256 count, uint64 value) private pure returns (bool) {
        for (uint256 i; i < count; ++i) {
            if (words[i] == value) return true;
        }
        return false;
    }

    function _declares(LibLaunchReadiness.Lane[] memory lanes, uint64 value) private pure returns (bool) {
        for (uint256 i; i < lanes.length; ++i) {
            if (lanes[i].selector == value) return true;
        }
        return false;
    }

    /// @dev Reads one lane's current token bucket (`TokenBucket`: tokens,
    ///      lastUpdated, isEnabled, capacity, rate — five static words) and
    ///      whether it is enabled with capacity and rate inside the
    ///      governor's bounds. Read word by word so a malformed answer is
    ///      reported, never a revert of the whole check.
    function _laneLimited(address pool, uint64 chainSelector, bool inbound)
        private
        view
        returns (bool readable, bool bounded, uint256 capacity)
    {
        (bool ok, bytes memory ret) = pool.staticcall{gas: LibLaunchReadiness.PROBE_GAS}(
            abi.encodeWithSignature(
                inbound ? "getCurrentInboundRateLimiterState(uint64)" : "getCurrentOutboundRateLimiterState(uint64)",
                chainSelector
            )
        );
        if (!ok || ret.length != 160) return (false, false, 0);
        uint256 enabled;
        uint256 rate;
        (, , enabled, capacity, rate) = abi.decode(ret, (uint256, uint256, uint256, uint256, uint256));
        if (enabled > 1) return (false, false, 0);
        readable = true;
        bounded = enabled == 1 && capacity >= VpfiPoolRateBounds.MIN_CAPACITY
            && capacity <= VpfiPoolRateBounds.MAX_CAPACITY
            && rate >= VpfiPoolRateBounds.MIN_RATE
            && rate <= VpfiPoolRateBounds.MAX_RATE;
    }
}
