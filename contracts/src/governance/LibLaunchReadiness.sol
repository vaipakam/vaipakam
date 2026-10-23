// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {VpfiPoolRateBounds} from "../crosschain/VpfiPoolRateBounds.sol";

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
 *      A check is one of three things, and none is ever read as another:
 *        - met;
 *        - NOT met — the chain was read and the requirement is missing;
 *        - not checkable — the chain could not answer (no CCIP registry
 *          given, a read that reverted or returned a malformed answer). Never read
 *          as met: the gate and a production launch refuse it, a testnet
 *          launch reports it.
 */
library LibLaunchReadiness {
    /// @dev Gas each interface probe of a third-party contract may spend (an
    ///      adapter's `adapterName()`, the oracle's `isSanctioned`, the CCIP
    ///      registry's `getPool` and the pool's lanes). A real
    ///      implementation answers well inside it; the bound keeps one
    ///      misbehaving registration from consuming the whole execution.
    uint256 internal constant PROBE_GAS = 200_000;

    /// @dev The most lanes the CCIP check reads. Every lane costs two probes,
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

    /// @notice Reads every launch requirement off the live chain.
    /// @param diamond The Diamond to read.
    /// @param tokenAdminRegistry The chain's CCIP `TokenAdminRegistry`, or
    ///        zero when none is known (the lane check is then not checkable).
    ///        The VPFI pool is read FROM it, for the token the Diamond itself
    ///        records, so no pool address is ever taken on trust.
    function check(address diamond, address tokenAdminRegistry) internal view returns (Check[] memory checks) {
        checks = new Check[](5);
        checks[0] = _treasury(diamond);
        checks[1] = _sanctions(diamond);
        checks[2] = _priceFeed(diamond);
        checks[3] = _swapRoute(diamond);
        checks[4] = _ccipLanes(diamond, tokenAdminRegistry);
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
    function _priceFeed(address diamond) private view returns (Check memory c) {
        c.label = "price oracle wired";
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
        (bool ok, bytes memory ret) = diamond.staticcall(abi.encodeWithSignature("getAssetPriceStatus(address)", weth));
        if (!ok || ret.length != 96) {
            c.detail = "getAssetPriceStatus(weth) unreadable";
            return c;
        }
        uint256 status = abi.decode(ret, (uint256));
        if (status > 2) {
            c.detail = "getAssetPriceStatus(weth) returned an unknown status";
            return c;
        }
        c.checkable = true;
        c.met = status == 0;
        c.detail = status == 0
            ? "the Diamond's oracle prices WETH from the ETH reference feed"
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

    /// @dev The VPFI pool CCIP actually routes through needs at least one
    ///      lane, and EVERY lane must carry the rate limits the mainnet gate
    ///      requires: inbound and outbound enabled, with capacity and refill
    ///      rate inside the `VpfiPoolRateGovernor` bounds. A lane whose
    ///      limiter is disabled moves tokens with no cap at all (CCIP skips
    ///      a disabled bucket), which is the state a wiring run leaves when
    ///      the lane landed and its limits did not (Codex #2686 r6). The
    ///      pool is the one the `TokenAdminRegistry` maps the Diamond's own
    ///      VPFI token to: a stale or look-alike pool address from an
    ///      artifact can never stand in for it.
    function _ccipLanes(address diamond, address registry) private view returns (Check memory c) {
        c.label = "CCIP lanes wired and rate-limited";
        if (registry == address(0)) {
            c.detail = "no CCIP TokenAdminRegistry given (CCIP_TOKEN_ADMIN_REGISTRY), so the VPFI pool is unknown";
            return c;
        }
        address token;
        try ILaunchReadableDiamond(diamond).getVPFIToken() returns (address t) {
            token = t;
        } catch {
            c.detail = "getVPFIToken() unreadable";
            return c;
        }
        if (token == address(0)) {
            c.checkable = true;
            c.detail = "the Diamond records no VPFI token: run the configure phase";
            return c;
        }
        (bool ok, bytes memory ret) = registry.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("getPool(address)", token));
        if (!ok || ret.length != 32 || uint256(bytes32(ret)) >> 160 != 0) {
            c.detail = "getPool(vpfiToken) unreadable on the TokenAdminRegistry";
            return c;
        }
        address pool = address(uint160(uint256(bytes32(ret))));
        if (pool == address(0)) {
            c.checkable = true;
            c.detail = "the TokenAdminRegistry maps no pool to the Diamond's VPFI token: run the ccip-wire phase";
            return c;
        }
        (ok, ret) = pool.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("getSupportedChains()"));
        (bool wellFormed, uint256 lanes) = ok ? _dynamicLength(ret, true) : (false, 0);
        if (!wellFormed) {
            c.detail = "getSupportedChains() unreadable on the registry's VPFI pool";
            return c;
        }
        if (lanes == 0) {
            c.checkable = true;
            c.detail = "the registry's VPFI pool has no lane: run the ccip-wire phase";
            return c;
        }
        if (lanes > MAX_LANES) {
            c.detail = "the registry's VPFI pool has more lanes than the check reads";
            return c;
        }
        // Decoded as full words, which cannot revert once the shape above is
        // checked; each word is then range-checked as a chain selector.
        uint256[] memory selectors = abi.decode(ret, (uint256[]));
        for (uint256 i; i < lanes; ++i) {
            uint256 word = selectors[i];
            if (word > type(uint64).max) {
                c.detail = "getSupportedChains() returned a value that is no chain selector";
                return c;
            }
            for (uint256 dir; dir < 2; ++dir) {
                (bool readable, bool bounded) = _laneLimited(pool, uint64(word), dir == 0);
                if (!readable) {
                    c.detail = "a lane's rate-limiter state is unreadable on the registry's VPFI pool";
                    return c;
                }
                if (!bounded) {
                    c.checkable = true;
                    c.detail = dir == 0
                        ? "a lane's INBOUND rate limit is disabled or outside the governor's bounds: run the ccip-wire phase's rate limits"
                        : "a lane's OUTBOUND rate limit is disabled or outside the governor's bounds: run the ccip-wire phase's rate limits";
                    return c;
                }
            }
        }
        c.checkable = true;
        c.met = true;
        c.detail = "every lane of the registry's VPFI pool is rate-limited both ways within the governor's bounds";
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
