// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @dev The Diamond reads the launch requirements need. Declared here rather
///      than imported from the facets so the readiness rule depends on the
///      Diamond's public surface only, never on a facet's implementation.
interface ILaunchReadableDiamond {
    function getTreasury() external view returns (address);
    function getSanctionsOracle() external view returns (address);
    function getEthNumeraireFeed() external view returns (address);
    function getSwapAdapters() external view returns (address[] memory);
    function isSwapAdapterDisabled(address adapter) external view returns (bool);
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
 *        - not checkable — the chain could not answer (no pool recorded, a
 *          read that reverted or returned a malformed answer). Never read
 *          as met: the gate and a production launch refuse it, a testnet
 *          launch reports it.
 */
library LibLaunchReadiness {
    /// @dev Gas each interface probe may spend (an adapter's `adapterName()`,
    ///      the oracle's `isSanctioned`, the feed's `latestRoundData`). A real
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

    /// @notice Reads every launch requirement off the live chain.
    /// @param diamond The Diamond to read.
    /// @param vpfiTokenPool The chain's CCIP VPFI pool, or zero when none is
    ///        recorded (reported as not checkable).
    function check(address diamond, address vpfiTokenPool) internal view returns (Check[] memory checks) {
        checks = new Check[](5);
        checks[0] = _treasury(diamond);
        checks[1] = _sanctions(diamond);
        checks[2] = _priceFeed(diamond);
        checks[3] = _swapRoute(diamond);
        checks[4] = _ccipLanes(vpfiTokenPool);
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

    /// @dev The ETH/numeraire feed is the anchor every price conversion in
    ///      the risk engine goes through; `ConfigureOracle` sets it first. It
    ///      must answer `latestRoundData()` with a positive price and a
    ///      non-zero update time. Freshness is the oracle layer's rule at
    ///      use time, not a launch requirement.
    function _priceFeed(address diamond) private view returns (Check memory c) {
        c.label = "price oracle wired";
        try ILaunchReadableDiamond(diamond).getEthNumeraireFeed() returns (address f) {
            c.checkable = true;
            if (f == address(0) || f.code.length == 0) {
                c.detail = "getEthNumeraireFeed() is unset or has no code: run the configure phase";
            } else if (!_answersPositivePrice(f)) {
                c.detail = "getEthNumeraireFeed() does not answer latestRoundData() with a positive price";
            } else {
                c.met = true;
                c.detail = "getEthNumeraireFeed() answers latestRoundData() with a positive price";
            }
        } catch {
            c.detail = "getEthNumeraireFeed() unreadable";
        }
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

    /// @dev The CCIP VPFI pool needs at least one lane, so the per-lane rate
    ///      limits the mainnet gate requires can exist.
    function _ccipLanes(address pool) private view returns (Check memory c) {
        c.label = "CCIP lanes wired";
        if (pool == address(0)) {
            c.detail = "no vpfiTokenPool recorded";
            return c;
        }
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSignature("getSupportedChains()"));
        (bool wellFormed, uint256 lanes) = ok ? _dynamicLength(ret, true) : (false, 0);
        if (!wellFormed) {
            c.detail = "getSupportedChains() unreadable on vpfiTokenPool";
            return c;
        }
        c.checkable = true;
        c.met = lanes != 0;
        c.detail = c.met ? "vpfiTokenPool has at least one lane" : "vpfiTokenPool has no lane: run the ccip-wire phase";
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

    /// @dev Whether `feed` answers Chainlink's `latestRoundData()` (five ABI
    ///      words) with a positive answer and a non-zero `updatedAt`. Read
    ///      as full words so an out-of-range field reads as malformed rather
    ///      than reverting the read.
    function _answersPositivePrice(address feed) private view returns (bool) {
        (bool ok, bytes memory ret) = feed.staticcall{gas: PROBE_GAS}(abi.encodeWithSignature("latestRoundData()"));
        if (!ok || ret.length != 160) return false;
        (, int256 answer,, uint256 updatedAt,) = abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
        return answer > 0 && updatedAt != 0;
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
