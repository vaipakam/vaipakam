// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {NumeraireConfigFacet} from "../../src/facets/NumeraireConfigFacet.sol";

/**
 * @title LaunchReadiness
 * @notice The ONE statement of what a Diamond must have before it may be
 *         unpaused for the first time (#945, #946).
 *
 * @dev A Diamond is born paused and `DeployDiamond` leaves it paused. The
 *      value-configuring work happens in later deploy phases, so unpausing
 *      at the end of the contracts phase opened `createOffer` /
 *      `acceptOffer` to the public while no price feed was wired, no
 *      sanctions screen was set and no liquidation route existed. Every
 *      first unpause now goes through `Launch.s.sol`, which reads this list
 *      off the live chain; the deploy scripts' verify phases report the same
 *      list, so a phase that says "ready" and the launch that acts on it can
 *      never disagree.
 *
 *      A check is one of three things, and none is ever read as another:
 *        - met;
 *        - NOT met — the chain was read and the requirement is missing;
 *        - not checkable — the chain could not answer (a contract missing
 *          from the artifact, a read that reverted). Never read as met: a
 *          production launch refuses it, a testnet launch reports it.
 */
library LaunchReadiness {
    /// @notice One readiness requirement and what the chain said about it.
    struct Check {
        string label;
        /// @dev The chain answered (the read succeeded).
        bool checkable;
        /// @dev The requirement holds. Only meaningful when `checkable`.
        bool met;
        string detail;
    }

    /// @notice Reads every launch requirement off the live chain.
    /// @param diamond The Diamond to read.
    /// @param vpfiTokenPool The chain's CCIP VPFI pool from the artifact, or
    ///        zero when the artifact records none (reported as not checkable).
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
        try AdminFacet(diamond).getTreasury() returns (address t) {
            c.checkable = true;
            c.met = t != address(0);
            c.detail = c.met ? "getTreasury() is set" : "getTreasury() is the zero address";
        } catch {
            c.detail = "getTreasury() unreadable";
        }
    }

    /// @dev Until a sanctions oracle is set, every wallet reads as not
    ///      sanctioned (#946). Required on every chain the retail product
    ///      runs on, and a contract, not a placeholder address.
    function _sanctions(address diamond) private view returns (Check memory c) {
        c.label = "sanctions oracle set";
        try ProfileFacet(diamond).getSanctionsOracle() returns (address o) {
            c.checkable = true;
            if (o == address(0)) {
                c.detail = "getSanctionsOracle() is the zero address: every wallet would read as unsanctioned";
            } else if (o.code.length == 0) {
                c.detail = "getSanctionsOracle() names an address with no code";
            } else {
                c.met = true;
                c.detail = "getSanctionsOracle() names a contract";
            }
        } catch {
            c.detail = "getSanctionsOracle() unreadable";
        }
    }

    /// @dev The ETH/numeraire feed is the anchor every price conversion in
    ///      the risk engine goes through; `ConfigureOracle` sets it first.
    function _priceFeed(address diamond) private view returns (Check memory c) {
        c.label = "price oracle wired";
        try NumeraireConfigFacet(diamond).getEthNumeraireFeed() returns (address f) {
            c.checkable = true;
            c.met = f != address(0) && f.code.length != 0;
            c.detail = c.met
                ? "getEthNumeraireFeed() names a contract"
                : "getEthNumeraireFeed() is unset or has no code: run the configure phase";
        } catch {
            c.detail = "getEthNumeraireFeed() unreadable";
        }
    }

    /// @dev A liquidation with no enabled swap adapter has nowhere to sell.
    function _swapRoute(address diamond) private view returns (Check memory c) {
        c.label = "swap route registered";
        try AdminFacet(diamond).getSwapAdapters() returns (address[] memory adapters) {
            c.checkable = true;
            for (uint256 i; i < adapters.length; ++i) {
                try AdminFacet(diamond).isSwapAdapterDisabled(adapters[i]) returns (bool disabled) {
                    if (!disabled) {
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
                ? "at least one enabled swap adapter"
                : "no enabled swap adapter: run the swap-adapters phase";
        } catch {
            c.detail = "getSwapAdapters() unreadable";
        }
    }

    /// @dev The CCIP VPFI pool needs at least one lane, so the per-lane rate
    ///      limits the mainnet gate requires can exist.
    function _ccipLanes(address pool) private view returns (Check memory c) {
        c.label = "CCIP lanes wired";
        if (pool == address(0)) {
            c.detail = "the artifact records no vpfiTokenPool";
            return c;
        }
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSignature("getSupportedChains()"));
        if (!ok || ret.length < 64) {
            c.detail = "getSupportedChains() unreadable on vpfiTokenPool";
            return c;
        }
        uint64[] memory lanes = abi.decode(ret, (uint64[]));
        c.checkable = true;
        c.met = lanes.length != 0;
        c.detail = c.met ? "vpfiTokenPool has at least one lane" : "vpfiTokenPool has no lane: run the ccip-wire phase";
    }
}
