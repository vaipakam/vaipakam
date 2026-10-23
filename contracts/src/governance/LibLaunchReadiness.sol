// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {VpfiPoolRateBounds} from "../crosschain/VpfiPoolRateBounds.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @dev The Diamond reads the launch requirements need. Declared here rather
///      than imported from the facets so the readiness rule depends on the
///      Diamond's public surface only, never on a facet's implementation.
interface ILaunchReadableDiamond {
    function getTreasury() external view returns (address);
    function getSanctionsOracle() external view returns (address);
    function getWethContract() external view returns (address);
    function getSwapAdapters() external view returns (address[] memory);
    function isSwapAdapterDisabled(address adapter) external view returns (bool);
    // forge-lint: disable-next-line(mixed-case-function)
    function getVPFIToken() external view returns (address);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function owner() external view returns (address);
    function roleEpoch() external view returns (uint64);
}

/**
 * @title LibLaunchReadiness
 * @notice The ONE statement of what a Diamond must have before it may be
 *         unpaused for the first time (#945, #946).
 *
 * @dev A Diamond is born paused and `DeployDiamond` leaves it paused. The
 *      value-configuring work happens in later deploy phases, so unpausing
 *      at the end of the contracts phase opened `createOffer` /
 *      `acceptOffer` to the public while no price feed was wired, no
 *      sanctions screen was set and no liquidation route existed.
 *
 *      Two readers share this list, so they can never disagree:
 *        - `Launch.s.sol` (and the deploy scripts' verify phases) read it
 *          off the live chain to decide whether to unpause or to print the
 *          Timelock proposal;
 *        - {LaunchGate} reads it again ON-CHAIN, inside the Timelock's
 *          execution of that proposal, so the first unpause of a
 *          Timelock-governed Diamond lands only if every requirement still
 *          holds at that moment, not merely when the proposal was printed
 *          a delay earlier.
 *
 *      An address is never accepted on the strength of having code: each
 *      contract the Diamond depends on is probed through the interface it is
 *      registered for, because the Diamond's own reads fail OPEN on a wrong
 *      contract (a failing `isSanctioned` reads as "not sanctioned").
 *
 *      Nor is a configuration accepted on the strength of reading back
 *      itself. Which WETH, which VPFI pool and which CCIP lanes the chain
 *      should carry are DECLARED ({Declared}) and the chain is compared with
 *      them; the Timelock proposal carries the declaration in its calldata,
 *      so what the Governance Safe reviews is what the gate enforces.
 *
 *      A check is one of three things, and none is ever read as another:
 *        - met;
 *        - NOT met — the chain was read and the requirement is missing;
 *        - not checkable — the chain could not answer (no CCIP registry
 *          given, a read that reverted or returned a malformed answer), or
 *          nothing was declared to compare it against. Never read as met:
 *          the gate and a production launch refuse it, a testnet launch
 *          reports it.
 */
library LibLaunchReadiness {
    /// @dev Gas each interface probe of a third-party contract may spend (an
    ///      adapter's `adapterName()`, the oracle's `isSanctioned`, the CCIP
    ///      registry's `getPool` and the pool's lanes). A real
    ///      implementation answers well inside it; the bound keeps one
    ///      misbehaving registration from consuming the whole execution.
    uint256 internal constant PROBE_GAS = 200_000;

    /// @dev The most lanes the CCIP check reads. Every lane costs four probes,
    ///      so the bound keeps the gate's execution bounded; a pool with more
    ///      is reported NOT CHECKED rather than read in part.
    uint256 internal constant MAX_LANES = 32;

    /// @notice One readiness requirement and what the chain said about it.
    struct Check {
        string label;
        /// @dev The chain answered (the read succeeded and was well formed).
        bool checkable;
        /// @dev The requirement holds. Only meaningful when `checkable`.
        bool met;
        string detail;
    }

    /// @notice What the chain is checked AGAINST: the expectations the
    ///         launch declares, which the Timelock proposal carries in its
    ///         calldata for the Governance Safe to review (Codex #2686 r7).
    /// @dev A requirement read back from the configuration it is meant to
    ///      validate proves nothing: any lane set, any pool and any WETH
    ///      pass a check that only asks the chain about itself. So the
    ///      identity and completeness questions are answered against these
    ///      declared values, and only the on-chain shape (a bounded limiter,
    ///      an 18-decimal token, a price) is read from the chain alone.
    struct Declared {
        /// @dev The chain's CCIP `TokenAdminRegistry`; zero leaves the VPFI
        ///      pool unknown, so both CCIP checks are NOT CHECKED.
        address tokenAdminRegistry;
        /// @dev The VPFI pool the deployment artifact records
        ///      (`vpfiTokenPool`): the pool whose Timelock ownership and
        ///      rate-governor wiring the handover gate proved. Zero declares
        ///      no cross-chain VPFI.
        address vpfiPool;
        /// @dev The artifact's `VpfiPoolRateGovernor`: the only rate-limit
        ///      admin the declared pool may have, so every limit change stays
        ///      inside the governor's bounds.
        address rateGovernor;
        /// @dev Every lane the pool must carry, exactly (`CCIP_LANE_CHAIN_IDS`,
        ///      the list the ccip-wire phase wires), each with the peer it
        ///      must reach. Empty declares none.
        Lane[] lanes;
        /// @dev The WETH the proposal names for review. No on-chain record
        ///      says which token is the chain's bridged WETH9 (the
        ///      `setWethContract` policy names the bridge registry as the
        ///      source), so its identity is the reviewers' to establish; the
        ///      check refuses any other configured WETH.
        address weth;
    }

    /// @notice One declared CCIP lane: the remote chain and the peer the
    ///         pool must reach there (Codex #2686 r11). A lane is a route only
    ///         with its peer: a selector whose remote pool is missing or wrong
    ///         fails every inbound message or sends outbound tokens to the
    ///         wrong asset, whatever its rate limits say.
    struct Lane {
        /// @dev The remote chain's CCIP selector.
        uint64 selector;
        /// @dev The pool on that chain the lane must accept, and only it
        ///      (that chain's artifact `vpfiTokenPool`). Zero declares none.
        address remotePool;
        /// @dev The VPFI token on that chain (`vpfiToken` on the canonical
        ///      chain, `vpfiMirror` on a mirror). Zero declares none.
        address remoteToken;
    }

    /// @notice The Diamond's facet table as the launch binds it: the hash of
    ///         its loupe's `facets()` answer, every facet with its selectors
    ///         in the loupe's order. Any `diamondCut` changes it, so a launch
    ///         decided against one table cannot execute against another
    ///         (Codex #2686 r11). `readable` is false when the loupe does not
    ///         answer.
    /// @dev Not gas-bounded like the third-party probes: the loupe is the
    ///      Diamond's own facet, and the whole table has to be read.
    function facetTable(address diamond) internal view returns (bool readable, bytes32 table) {
        (bool ok, bytes memory ret) = diamond.staticcall(abi.encodeWithSignature("facets()"));
        if (!ok || ret.length == 0) return (false, bytes32(0));
        return (true, keccak256(ret));
    }

    /// @notice Reads every launch requirement off the live chain.
    /// @param diamond The Diamond to read.
    /// @param declared What the chain must match (see {Declared}). The VPFI
    ///        pool is read FROM the registry, for the token the Diamond
    ///        itself records, and then compared with the declared one, so
    ///        no pool address is ever taken on trust.
    function check(address diamond, Declared memory declared) internal view returns (Check[] memory checks) {
        VpfiRoute memory route = _vpfiRoute(diamond, declared.tokenAdminRegistry);
        checks = new Check[](6);
        checks[0] = _treasury(diamond);
        checks[1] = _sanctions(diamond);
        checks[2] = _priceFeed(diamond, declared.weth);
        checks[3] = _swapRoute(diamond);
        checks[4] = _vpfiPool(diamond, route, declared);
        checks[5] = _ccipLanes(route, declared);
    }

    /// @notice Whether every check was answered and met.
    function allMet(Check[] memory checks) internal pure returns (bool) {
        for (uint256 i; i < checks.length; ++i) {
            if (!checks[i].checkable || !checks[i].met) return false;
        }
        return true;
    }

    /// @notice Whether every ANSWERED check was met (unanswered ones aside).
    function noneUnmet(Check[] memory checks) internal pure returns (bool) {
        for (uint256 i; i < checks.length; ++i) {
            if (checks[i].checkable && !checks[i].met) return false;
        }
        return true;
    }

    /// @notice The first Diamond role (`LibAccessControl.knownRoles()`)
    ///         `account` holds, if any. A handed-over Diamond's deploy key
    ///         holds none (#669); the launch refuses until that is so.
    function firstRoleHeld(address diamond, address account) internal view returns (bool held, bytes32 role) {
        bytes32[] memory roles = LibAccessControl.knownRoles();
        for (uint256 i; i < roles.length; ++i) {
            if (ILaunchReadableDiamond(diamond).hasRole(roles[i], account)) return (true, roles[i]);
        }
    }

    /// @notice The one-word state a check is printed with.
    function verdict(Check memory c) internal pure returns (string memory) {
        if (!c.checkable) return "NOT CHECKED";
        return c.met ? "met" : "NOT MET";
    }

    // ─── The requirements ──────────────────────────────────────────────

    /// @dev Fees and treasury shares need somewhere to go.
    function _treasury(address diamond) private view returns (Check memory c) {
        c.label = "treasury set";
        try ILaunchReadableDiamond(diamond).getTreasury() returns (address t) {
            c.checkable = true;
            c.met = t != address(0);
            c.detail = c.met ? "getTreasury() is set" : "getTreasury() is the zero address";
        } catch {
            c.detail = "getTreasury() unreadable";
        }
    }

    /// @dev Until a sanctions oracle is set, every wallet reads as not
    ///      sanctioned (#946). Required on every chain the retail product
    ///      runs on. The Diamond reads it with a try/catch that treats a
    ///      failed call as "not sanctioned", so a contract that does not
    ///      implement `isSanctioned(address)` would screen nobody: the oracle
    ///      must answer that call, for the Diamond's own address, with a
    ///      well-formed boolean.
    function _sanctions(address diamond) private view returns (Check memory c) {
        c.label = "sanctions oracle set";
        try ILaunchReadableDiamond(diamond).getSanctionsOracle() returns (address o) {
            c.checkable = true;
            if (o == address(0)) {
                c.detail = "getSanctionsOracle() is the zero address: every wallet would read as unsanctioned";
            } else if (o.code.length == 0) {
                c.detail = "getSanctionsOracle() names an address with no code";
            } else if (!_answersIsSanctioned(o, diamond)) {
                c.detail = "getSanctionsOracle() names a contract that does not answer isSanctioned(address) with a boolean: the Diamond would read every wallet as unsanctioned";
            } else {
                c.met = true;
                c.detail = "getSanctionsOracle() answers isSanctioned(address)";
            }
        } catch {
            c.detail = "getSanctionsOracle() unreadable";
        }
    }

    /// @dev The ETH reference feed is the anchor every price conversion in
    ///      the risk engine goes through: it prices WETH directly, and every
    ///      asset/ETH fallback multiplies against it. So the requirement is
    ///      that the Diamond's OWN oracle prices WETH now, read through
    ///      `getAssetPriceStatus` — the classification every flow reads —
    ///      rather than a restatement of the oracle's acceptance rules (round
    ///      shape, timestamps, staleness, the sequencer, the secondary quorum,
    ///      the Pyth cross-check) that would drift from them. A price that is
    ///      missing, stale or distrusted at the moment of the read is NOT
    ///      MET: the Diamond could not price anything ETH-anchored then.
    ///
    ///      That price alone says nothing about WHICH token is configured:
    ///      the oracle prices whatever address is stored as WETH from the
    ///      ETH feed without touching it (Codex #2686 r7). So the configured
    ///      WETH must first be the declared one, and a contract answering
    ///      `decimals()` with 18, which an EOA or an unrelated contract
    ///      stored by mistake does not.
    function _priceFeed(address diamond, address declaredWeth) private view returns (Check memory c) {
        c.label = "WETH is the declared token and priced";
        address weth;
        try ILaunchReadableDiamond(diamond).getWethContract() returns (address w) {
            weth = w;
        } catch {
            c.detail = "getWethContract() unreadable";
            return c;
        }
        if (weth == address(0)) {
            c.checkable = true;
            c.detail = "no WETH configured (setWethContract): run the configure phase";
            return c;
        }
        if (declaredWeth == address(0)) {
            c.detail = "no WETH declared to compare the configured one against";
            return c;
        }
        c.checkable = true;
        if (weth != declaredWeth) {
            c.detail = "the configured WETH is not the declared one";
            return c;
        }
        if (!_answersEighteenDecimals(weth)) {
            c.detail = "the configured WETH is not a contract answering decimals() with 18";
            return c;
        }
        (bool ok, bytes memory ret) = diamond.staticcall(abi.encodeWithSignature("getAssetPriceStatus(address)", weth));
        if (!ok || ret.length != 96) {
            c.checkable = false;
            c.detail = "getAssetPriceStatus(weth) unreadable";
            return c;
        }
        uint256 status = abi.decode(ret, (uint256));
        if (status > 2) {
            c.checkable = false;
            c.detail = "getAssetPriceStatus(weth) returned an unknown status";
            return c;
        }
        c.met = status == 0;
        c.detail = status == 0
            ? "the declared WETH is configured, and the Diamond's oracle prices it from the ETH reference feed"
            : status == 1
                ? "the Diamond's oracle has no usable WETH price now (ETH feed unset, stale or not positive, or the sequencer down): run the configure phase, or wait for a fresh round"
                : "the Diamond's oracle distrusts the WETH price (the secondary oracles or the Pyth cross-check disagree)";
    }

    /// @dev A liquidation with no working swap adapter has nowhere to sell.
    ///      `addSwapAdapter` checks only for zero and duplicates, so a
    ///      registration is counted only when it is enabled, has code, and
    ///      answers `ISwapAdapter.adapterName()` with a non-empty string — an
    ///      EOA or an unrelated contract registered by mistake is not a route.
    function _swapRoute(address diamond) private view returns (Check memory c) {
        c.label = "swap route registered";
        try ILaunchReadableDiamond(diamond).getSwapAdapters() returns (address[] memory adapters) {
            c.checkable = true;
            for (uint256 i; i < adapters.length; ++i) {
                try ILaunchReadableDiamond(diamond).isSwapAdapterDisabled(adapters[i]) returns (bool disabled) {
                    if (!disabled && _answersAdapterName(adapters[i])) {
                        c.met = true;
                        break;
                    }
                } catch {
                    c.checkable = false;
                    c.detail = "isSwapAdapterDisabled() unreadable";
                    return c;
                }
            }
            c.detail = c.met
                ? "at least one enabled swap adapter answering adapterName()"
                : "no enabled swap adapter that is a contract answering adapterName(): run the swap-adapters phase";
        } catch {
            c.detail = "getSwapAdapters() unreadable";
        }
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
            registry.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("getPool(address)", r.token));
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
    function _noVpfi(Check memory c, Declared memory declared) private pure {
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
    function _vpfiPool(address diamond, VpfiRoute memory route, Declared memory declared)
        private
        view
        returns (Check memory c)
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
        (bool ok, bytes memory ret) = declared.tokenAdminRegistry.staticcall{gas: PROBE_GAS}(
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
        c.checkable = true;
        if (address(uint160(administrator)) != governance || pendingAdministrator != 0) {
            c.detail = "the registry's VPFI administrator is not the Diamond's owner, or a transfer of it is pending";
        } else if (poolOwner != governance) {
            c.detail = "the VPFI pool's owner is not the Diamond's owner";
        } else if (rateAdmin != declared.rateGovernor) {
            c.detail = "the VPFI pool's rate-limit admin is not the declared rate governor, so its limits could be changed outside the governor's bounds";
        } else if (govOwner != governance || govPending != address(0) || govPool != route.pool) {
            c.detail = "the rate governor is not owned by the Diamond's owner, has an ownership transfer pending, or administers another pool";
        } else {
            c.met = true;
            c.detail = "the TokenAdminRegistry routes VPFI through the declared pool, and the registry administrator, the pool owner and the rate governor's owner are all the Diamond's owner (a CCIP pool's pending owner is private and not read here)";
        }
    }

    /// @dev One `address` answer from `target`, or unreadable.
    function _readAddress(address target, bytes memory call) private view returns (bool, address) {
        (bool ok, bytes memory ret) = target.staticcall{gas: PROBE_GAS}(call);
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
    function _ccipLanes(VpfiRoute memory route, Declared memory declared) private view returns (Check memory c) {
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
        (bool ok, bytes memory ret) = route.pool.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("getSupportedChains()"));
        (bool wellFormed, uint256 count) = ok ? _dynamicLength(ret, true) : (false, 0);
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
        for (uint256 i; i < count; ++i) {
            for (uint256 dir; dir < 2; ++dir) {
                (bool readable, bool bounded) = _laneLimited(route.pool, uint64(selectors[i]), dir == 0);
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
            " declared lane(s), each reaching exactly its declared remote pool and token and rate-limited both ways within the governor's bounds"
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
    function _lanePeer(address pool, Lane memory lane) private view returns (bool readable, string memory detail) {
        string memory which = Strings.toString(lane.selector);
        if (lane.remotePool == address(0) || lane.remoteToken == address(0)) {
            return (false, string.concat("lane ", which, ": no remote pool or token declared (that chain's artifact records none) to compare its peer against"));
        }
        (bool tokenOk, bytes memory token) =
            pool.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("getRemoteToken(uint64)", lane.selector));
        (bool poolsOk, bytes memory pools) =
            pool.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("getRemotePools(uint64)", lane.selector));
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

    function _declares(Lane[] memory lanes, uint64 value) private pure returns (bool) {
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
        returns (bool readable, bool bounded)
    {
        (bool ok, bytes memory ret) = pool.staticcall{gas: PROBE_GAS}(
            abi.encodeWithSignature(
                inbound ? "getCurrentInboundRateLimiterState(uint64)" : "getCurrentOutboundRateLimiterState(uint64)",
                chainSelector
            )
        );
        if (!ok || ret.length != 160) return (false, false);
        (, , uint256 enabled, uint256 capacity, uint256 rate) =
            abi.decode(ret, (uint256, uint256, uint256, uint256, uint256));
        if (enabled > 1) return (false, false);
        readable = true;
        bounded = enabled == 1 && capacity >= VpfiPoolRateBounds.MIN_CAPACITY
            && capacity <= VpfiPoolRateBounds.MAX_CAPACITY
            && rate >= VpfiPoolRateBounds.MIN_RATE
            && rate <= VpfiPoolRateBounds.MAX_RATE;
    }

    /// @dev Whether `adapter` is a contract that answers `adapterName()`
    ///      with a well-formed, non-empty string.
    function _answersAdapterName(address adapter) private view returns (bool) {
        if (adapter.code.length == 0) return false;
        (bool ok, bytes memory ret) =
            adapter.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("adapterName()"));
        if (!ok) return false;
        (bool wellFormed, uint256 len) = _dynamicLength(ret, false);
        return wellFormed && len != 0;
    }

    /// @dev Whether `oracle` answers `isSanctioned(subject)` with exactly one
    ///      ABI word holding 0 or 1.
    function _answersIsSanctioned(address oracle, address subject) private view returns (bool) {
        (bool ok, bytes memory ret) =
            oracle.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("isSanctioned(address)", subject));
        if (!ok || ret.length != 32) return false;
        return abi.decode(ret, (uint256)) <= 1;
    }

    /// @dev Whether `token` is a contract answering `decimals()` with exactly
    ///      one ABI word holding 18, as every chain's bridged WETH9 does.
    function _answersEighteenDecimals(address token) private view returns (bool) {
        if (token.code.length == 0) return false;
        (bool ok, bytes memory ret) = token.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("decimals()"));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 18;
    }

    /// @dev Reads the length of a single ABI-encoded dynamic return value
    ///      (`string` / `bytes`, or a `T[]` of one-word elements when
    ///      `wordElements`)
    ///      without `abi.decode`, which would revert the whole read on
    ///      malformed data instead of reporting it. Well formed means the
    ///      head points at the standard offset and the returned bytes hold
    ///      every element the length claims.
    function _dynamicLength(bytes memory ret, bool wordElements) private pure returns (bool, uint256) {
        if (ret.length < 64) return (false, 0);
        (uint256 offset, uint256 length) = abi.decode(ret, (uint256, uint256));
        if (offset != 32) return (false, 0);
        uint256 room = ret.length - 64;
        if (length > (wordElements ? room / 32 : room)) return (false, 0);
        return (true, length);
    }
}
