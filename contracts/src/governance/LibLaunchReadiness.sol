// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {LibLaunchCrossChainReadiness} from "./LibLaunchCrossChainReadiness.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @dev The Diamond reads the launch requirements need. Declared here rather
///      than imported from the facets so the readiness rule depends on the
///      Diamond's public surface only, never on a facet's implementation.
interface ILaunchReadableDiamond {
    function getTreasury() external view returns (address);
    function getSanctionsOracle() external view returns (address);
    function getWethContract() external view returns (address);
    function getSwapAdapters() external view returns (address[] memory);
    function getPaaAssets() external view returns (address[] memory);
    function getFeedRegistryLookup()
        external
        view
        returns (address registry, address padDenominator, address ethDenominator);
    function isSwapAdapterDisabled(address adapter) external view returns (bool);
    function isLiquidityQuoteUsable(address quote) external view returns (bool);
    // forge-lint: disable-next-line(mixed-case-function)
    function getVPFIToken() external view returns (address);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function owner() external view returns (address);
    function roleEpoch() external view returns (uint64);
    function getRewardRole() external view returns (uint8 role);
    function getCurrentLapseScheduleVersion() external view returns (uint32);
    function getLapseSchedule(uint32 version)
        external
        view
        returns (uint64 lapseWindowSeconds, uint64 dispatchCutoffGap);
    function getInteractionHalfPoolForDay(uint256 day) external view returns (uint256);
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
 *      Both get the list from {compose}; the two cross-chain entries are
 *      read by {LibLaunchCrossChainReadiness}, which the gate hosts in a
 *      companion contract to stay within EIP-170 (#2975).
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
        /// @dev The feed registry the artifact records (`feedRegistry`,
        ///      #2880): the chain's `VaipakamFeedRegistry`, whose owner and
        ///      veto the handover gate proved. The Diamond must price
        ///      through it and no other. Zero declares none.
        address feedRegistry;
        /// @dev The Diamond's VPFI is a burn/mint MIRROR (every chain but the
        ///      canonical one). A mirror token carries its own mint and burn
        ///      authority (`tokenPool()`), separate from the registry's
        ///      route, so the check also requires that slot to name the
        ///      routed pool and the token to be governed by the Diamond's
        ///      owner (Codex #2686 r12).
        bool mirrorToken;
        /// @dev The reward role the deployment intends for this chain
        ///      (#2920). The stored role is the configure step's output, so
        ///      reading it back alone cannot tell a Base Diamond whose reward
        ///      configure never ran from a chain that runs no rewards. The
        ///      zero value is {RewardRoleIntent.Undeclared}, never a role, so
        ///      a launch that forgets to declare is NOT CHECKED, not met.
        RewardRoleIntent rewardRole;
    }

    /// @notice The reward role a launch declares for its chain (#2920).
    /// @dev Kept separate from `LibVaipakam.RewardRole` on purpose: its zero
    ///      member is `Canonical`, so an undeclared field would read as a
    ///      declaration that the chain is Base. `None` declares a deployment
    ///      with no reward stack, whose Diamond stays `Unconfigured`; no
    ///      launch may intend `Detached`.
    enum RewardRoleIntent {
        Undeclared,
        Canonical,
        Mirror,
        None
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

    /// @notice How many calls `timelock` has executed
    ///         (`VaipakamTimelock.executedCalls`), as the launch binds it: a
    ///         launch proposed at one count executes only while no other
    ///         Timelock call has completed (Codex #2686 r12). `readable` is
    ///         false when the account does not answer with one word that
    ///         fits a uint64.
    function timelockCalls(address timelock) internal view returns (bool readable, uint64 calls) {
        (bool ok, bytes memory ret) =
            timelock.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("executedCalls()"));
        if (!ok || ret.length != 32 || uint256(bytes32(ret)) > type(uint64).max) return (false, 0);
        return (true, uint64(uint256(bytes32(ret))));
    }

    /// @notice Reads every launch requirement off the live chain.
    /// @param diamond The Diamond to read.
    /// @param declared What the chain must match (see {Declared}). The VPFI
    ///        pool is read FROM the registry, for the token the Diamond
    ///        itself records, and then compared with the declared one, so
    ///        no pool address is ever taken on trust.
    function check(address diamond, Declared memory declared) internal view returns (Check[] memory checks) {
        return compose(diamond, declared, LibLaunchCrossChainReadiness.checks(diamond, declared));
    }

    /// @notice The ONE list: the Diamond's own requirements read here, with
    ///         the two cross-chain ones ({LibLaunchCrossChainReadiness})
    ///         placed in their slots.
    /// @dev {check} passes the cross-chain pair read in-line; {LaunchGate}
    ///      passes the pair its companion contract read, because one
    ///      contract carrying all ten checks exceeds EIP-170 (#2975). Either
    ///      way the list, its order and every other entry come from here.
    /// @param crossChain The VPFI pool check, then the CCIP lanes check, as
    ///        {LibLaunchCrossChainReadiness.checks} returns them.
    function compose(address diamond, Declared memory declared, Check[2] memory crossChain)
        internal
        view
        returns (Check[] memory checks)
    {
        checks = new Check[](10);
        checks[0] = _treasury(diamond);
        checks[1] = _sanctions(diamond);
        checks[2] = _priceFeed(diamond, declared.weth);
        checks[3] = _swapRoute(diamond);
        checks[4] = crossChain[0];
        checks[5] = crossChain[1];
        checks[6] = _wethQuoteRoute(diamond);
        checks[7] = _feedRegistry(diamond, declared.feedRegistry);
        checks[8] = _lapseSchedule(diamond);
        checks[9] = _rewardRole(diamond, declared.rewardRole);
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

    /// @dev #2909 — on the canonical reward chain every day freezes the lapse
    ///      schedule in force when it finalizes, and keeps it. Version 0
    ///      means "never lapses, no dispatch cutoff": a zeroed day nobody
    ///      compensates would stay open for good, holding the claim cursor
    ///      behind it, and Base would enforce no cutoff on manual
    ///      compensation. A schedule set after launch cannot reach the days
    ///      already finalized, so it is a launch requirement, not a tuning
    ///      step. Only Base sets one (it rides the kind-10 broadcast to
    ///      every mirror), so on any other role the requirement does not
    ///      apply, and the detail names the role it found.
    function _lapseSchedule(address diamond) private view returns (Check memory c) {
        c.label = "zeroed-day lapse schedule in force";
        uint8 role;
        try ILaunchReadableDiamond(diamond).getRewardRole() returns (uint8 r) {
            role = r;
        } catch {
            c.detail = "getRewardRole() unreadable";
            return c;
        }
        if (role != 0) {
            c.checkable = true;
            c.met = true;
            c.detail = string.concat(
                "does not apply: the reward role is ",
                _roleName(role),
                ", and only the canonical reward chain sets a lapse schedule"
            );
            return c;
        }
        try ILaunchReadableDiamond(diamond).getCurrentLapseScheduleVersion() returns (uint32 v) {
            if (v == 0) {
                c.checkable = true;
                c.detail = "no lapse schedule is set: every day finalized now would never lapse and carry no dispatch cutoff";
                return c;
            }
            try ILaunchReadableDiamond(diamond).getLapseSchedule(v) returns (uint64 window, uint64 gap) {
                c.checkable = true;
                c.met = true;
                c.detail = string.concat(
                    "version ",
                    Strings.toString(v),
                    ": days lapse ",
                    Strings.toString(window),
                    "s after finalizing, compensation dispatch closes ",
                    Strings.toString(gap),
                    "s before"
                );
            } catch {
                c.detail = "getLapseSchedule(version) unreadable";
            }
        } catch {
            c.detail = "getCurrentLapseScheduleVersion() unreadable";
        }
    }

    /// @dev #2920 — the reward role is the configure step's output, so it is
    ///      compared with the role the launch DECLARES for the chain, never
    ///      with itself. Read alone, a Base Diamond whose reward configure
    ///      did not run, or stopped partway, reads `Unconfigured` and every
    ///      reward check downstream of it (the lapse schedule above among
    ///      them) says it does not apply, which is true of the stored role
    ///      and hides that the role is wrong for the chain. `Detached` is
    ///      never an intended state, so it is NOT MET under every
    ///      declaration.
    function _rewardRole(address diamond, RewardRoleIntent intent) private view returns (Check memory c) {
        c.label = "the reward role is the one the launch declares";
        uint8 role;
        try ILaunchReadableDiamond(diamond).getRewardRole() returns (uint8 r) {
            role = r;
        } catch {
            c.detail = "getRewardRole() unreadable";
            return c;
        }
        if (role > 3) {
            c.detail = "getRewardRole() returned an unknown role";
            return c;
        }
        if (intent == RewardRoleIntent.Undeclared) {
            c.detail = string.concat(
                "no reward role declared to compare the Diamond's (", _roleName(role), ") against"
            );
            return c;
        }
        // The stored role each declaration expects: Canonical 0, Mirror 1,
        // and a deployment with no reward stack stays Unconfigured (2).
        uint8 expected = intent == RewardRoleIntent.Canonical ? 0 : intent == RewardRoleIntent.Mirror ? 1 : 2;
        c.checkable = true;
        c.met = role == expected;
        if (c.met) {
            c.detail = intent == RewardRoleIntent.Canonical
                ? "the Diamond is the canonical reward chain, as declared"
                : intent == RewardRoleIntent.Mirror
                    ? "the Diamond is a reward mirror, as declared"
                    : "the Diamond runs no rewards (Unconfigured), as declared for a deployment with no reward messenger";
            return c;
        }
        c.detail = intent == RewardRoleIntent.None
            ? string.concat(
                "the reward role is ",
                _roleName(role),
                ", but the launch declares no reward stack (the deployment records no reward messenger)"
            )
            : string.concat(
                "the reward role is ",
                _roleName(role),
                ", but the launch declares ",
                intent == RewardRoleIntent.Canonical ? "Canonical" : "Mirror",
                ": run the reward configure step (ConfigureRewardReporter)"
            );
    }

    /// @dev `LibVaipakam.RewardRole` by number, as `getRewardRole` returns
    ///      it: 0 Canonical, 1 Mirror, 2 Unconfigured, 3 Detached.
    function _roleName(uint8 role) private pure returns (string memory) {
        return role == 0
            ? "Canonical"
            : role == 1 ? "Mirror" : role == 2 ? "Unconfigured" : role == 3 ? "Detached" : "unknown";
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

    /// @dev #2747 — WETH has a liquidity-tier route only through a quote
    ///      asset other than itself that the Diamond can price: the tier
    ///      search never quotes an asset against itself, the empty list of a
    ///      Diamond whose configure phase has not set one resolves to WETH
    ///      alone, and the search skips a quote it cannot price before it
    ///      looks at any pool. With no such quote, WETH resolves to tier 0
    ///      whatever its market depth, which stamps the most conservative
    ///      liquidation threshold on every WETH-collateral loan, refuses it
    ///      the discounted liquidation and, once depth-tiered LTV is on,
    ///      refuses every new WETH-collateral loan.
    ///
    ///      The check reads the list the tier search uses and asks the
    ///      Diamond, through `isLiquidityQuoteUsable`, the same quote-leg
    ///      question the search asks (Codex #2890 r1), rather than keeping a
    ///      copy of its rule: a listed quote with no price feed (a peg
    ///      reference set by `setStableTokenFeed` prices nothing) is not a
    ///      route. The answer is read live, so a quote whose round is stale
    ///      or distrusted at that moment is NOT MET until it recovers. Whether
    ///      the quote's pools are deep enough for a higher tier is a market
    ///      measurement made per loan, not a launch requirement, and the
    ///      detail says so.
    function _wethQuoteRoute(address diamond) private view returns (Check memory c) {
        c.label = "WETH has a liquidity-tier quote route";
        address weth;
        try ILaunchReadableDiamond(diamond).getWethContract() returns (address w) {
            weth = w;
        } catch {
            c.detail = "getWethContract() unreadable";
            return c;
        }
        address[] memory quotes;
        try ILaunchReadableDiamond(diamond).getPaaAssets() returns (address[] memory q) {
            quotes = q;
        } catch {
            c.detail = "getPaaAssets() unreadable";
            return c;
        }
        bool listed;
        for (uint256 i; i < quotes.length; ++i) {
            if (quotes[i] == address(0) || quotes[i] == weth) continue;
            listed = true;
            try ILaunchReadableDiamond(diamond).isLiquidityQuoteUsable(quotes[i]) returns (bool usable) {
                if (usable) {
                    c.checkable = true;
                    c.met = true;
                    c.detail = "the quote-asset list names an asset besides WETH that the Diamond prices, so WETH can be tiered (its tier still depends on that pool's depth)";
                    return c;
                }
            } catch {
                c.detail = "isLiquidityQuoteUsable() unreadable";
                return c;
            }
        }
        c.checkable = true;
        c.detail = listed
            ? "the quote-asset list names assets besides WETH, but the Diamond prices none of them now (no feed for it in the feed registry, a stale or distrusted round, or unreadable decimals), and the tier search skips a quote it cannot price, so WETH would resolve to liquidity tier 0: wire the quote's price feed in the configure phase"
            : "the quote-asset list names no asset besides WETH, so WETH would resolve to liquidity tier 0: run the configure phase with a stable quote (<CHAIN>_PAA_QUOTE_ASSETS)";
    }

    /// @dev #2880 — every asset but WETH is priced through the chain's feed
    ///      registry, so a Diamond pointed at no registry, or at one other
    ///      than the chain's own, prices WETH alone or prices through feeds
    ///      nobody reviewed. The registry must be the declared one and must
    ///      have a quote registered under each key the oracle asks it under
    ///      (the primary key and the ETH key of the asset/ETH fallback), or
    ///      every lookup under that key misses. How many feeds it holds is
    ///      reported, not required: WETH prices without it, and the feed
    ///      service fills it under the registry's own delay.
    function _feedRegistry(address diamond, address declaredRegistry) private view returns (Check memory c) {
        c.label = "the declared feed registry keys every price lookup";
        address registry;
        address padKey;
        address ethKey;
        try ILaunchReadableDiamond(diamond).getFeedRegistryLookup() returns (address r, address p, address e) {
            (registry, padKey, ethKey) = (r, p, e);
        } catch {
            c.detail = "getFeedRegistryLookup() unreadable";
            return c;
        }
        if (registry == address(0)) {
            c.checkable = true;
            c.detail = "no feed registry configured (setChainlinkRegistry), so only WETH is priced: run the configure phase";
            return c;
        }
        if (declaredRegistry == address(0)) {
            c.detail = "no feed registry declared to compare the configured one against";
            return c;
        }
        c.checkable = true;
        if (registry != declaredRegistry) {
            c.detail = "the configured feed registry is not the declared one";
            return c;
        }
        if (!_quoteRegistered(registry, padKey)) {
            c.detail = "the registry files no quote under the oracle's primary key (the predominant or numeraire denominator), so every primary lookup misses";
            return c;
        }
        if (!_quoteRegistered(registry, ethKey)) {
            c.detail = "the registry files no quote under the oracle's ETH key, so every asset/ETH lookup misses";
            return c;
        }
        c.met = true;
        (bool ok, bytes memory ret) = registry.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("entryCount()"));
        c.detail = ok && ret.length == 32
            ? string.concat(
                "the Diamond prices through the declared registry, which files a quote under both keys and holds ",
                Strings.toString(abi.decode(ret, (uint256))),
                " feed(s)"
            )
            : "the Diamond prices through the declared registry, which files a quote under both keys (its feed count is unreadable)";
    }

    /// @dev Whether `registry` answers `quoteSymbol(quote)` with a
    ///      well-formed, non-empty string. A zero key is never registered.
    function _quoteRegistered(address registry, address quote) private view returns (bool) {
        if (quote == address(0) || registry.code.length == 0) return false;
        (bool ok, bytes memory ret) =
            registry.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("quoteSymbol(address)", quote));
        if (!ok) return false;
        (bool wellFormed, uint256 len) = dynamicLength(ret, false);
        return wellFormed && len != 0;
    }

    /// @dev Whether `adapter` is a contract that answers `adapterName()`
    ///      with a well-formed, non-empty string.
    function _answersAdapterName(address adapter) private view returns (bool) {
        if (adapter.code.length == 0) return false;
        (bool ok, bytes memory ret) =
            adapter.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("adapterName()"));
        if (!ok) return false;
        (bool wellFormed, uint256 len) = dynamicLength(ret, false);
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
    function dynamicLength(bytes memory ret, bool wordElements) internal pure returns (bool, uint256) {
        if (ret.length < 64) return (false, 0);
        (uint256 offset, uint256 length) = abi.decode(ret, (uint256, uint256));
        if (offset != 32) return (false, 0);
        uint256 room = ret.length - 64;
        if (length > (wordElements ? room / 32 : room)) return (false, 0);
        return (true, length);
    }
}
