// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MockSwapAdapter} from "../../test/mocks/MockSwapAdapter.sol";

/// @dev The Diamond views the reprice script and this report read, declared
///      narrowly so neither compiles OracleFacet or AdminFacet to call them.
///      `checkLiquidity` returns `LibVaipakam.LiquidityStatus`, which the ABI
///      encodes as a uint8: 0 = Liquid, 1 = Illiquid.
interface IRepriceDiamondViews {
    function getAssetPrice(address asset) external view returns (uint256 price, uint8 decimals);
    function checkLiquidity(address asset) external view returns (uint8);
    function getSwapAdapters() external view returns (address[] memory);
    function isSwapAdapterDisabled(address adapter) external view returns (bool);
}

/**
 * @title RepriceVenueReport
 * @notice Reports, without changing anything, every way the testnet mock swap
 *         venue would settle a liquidation differently from the oracle
 *         (#2314). {RepriceTestnetMock} prints it after a reprice.
 *
 * @dev    A separate contract on purpose. The report reads state the reprice
 *         neither writes nor controls, so it must never be what stops a run:
 *         the script deploys this in simulation and calls it behind ONE
 *         `try`, and any read that fails in here — a venue that is not a
 *         `MockSwapAdapter`, a token with no `decimals()` — becomes a single
 *         stated "report unavailable" outcome, not an aborted run. A script
 *         contract cannot call itself through `this` (Forge refuses
 *         `address(this)` in scripts), so the boundary has to be a contract.
 *
 *         `MockSwapAdapter.execute` pays `base * outputMultiplierBps / 10000`,
 *         where `base` is `inputAmount * priceIn / priceOut`, or `inputAmount`
 *         (a 1:1 base) when either leg has no price — the multiplier applies
 *         in both cases. It reverts when `shouldRevert` is set or
 *         `restrictedTo` names another caller, and it works on raw amounts,
 *         so it assumes every leg has the same decimals. That is the complete
 *         set this reads. An empty result means none of it deviates; it does
 *         not mean a liquidation will succeed — the venue's output float is
 *         not knowable here, and the script says so.
 */
contract RepriceVenueReport {
    /// @dev `MockSwapAdapter.tokenUsdPrice8` is 8-decimal by definition.
    uint8 internal constant VENUE_PRICE_DECIMALS = 8;

    /// @param diamond The Diamond whose oracle the venue is compared against.
    /// @param venue   The registered `MockSwapAdapter`.
    /// @param asset   The repriced asset — the leg every liquidation pairs with.
    /// @param assets  The faucet assets the venue is expected to price.
    /// @return deviations One plain-English line per deviation, empty if none.
    function report(address diamond, address venue, address asset, address[] calldata assets)
        external
        view
        returns (string[] memory deviations)
    {
        MockSwapAdapter v = MockSwapAdapter(venue);
        string[] memory buf = new string[](3 + 2 * assets.length);
        uint256 n;
        if (v.shouldRevert()) {
            buf[n++] = "venue shouldRevert is on: every liquidation through it reverts";
        }
        uint256 bps = v.outputMultiplierBps();
        if (bps != 10_000) {
            buf[n++] = string.concat(
                "venue outputMultiplierBps is ", Strings.toString(bps), ", not 10000: it pays that fraction of the fair amount"
            );
        }
        address gate = v.restrictedTo();
        if (gate == address(0)) {
            // Not a pricing deviation but an operational one: the adapter is
            // funded, so an open execute is a public pot (anyone can approve
            // a junk input token and drain the output float). The deploy
            // gates it to the Diamond for exactly that reason.
            buf[n++] = "venue execute is open to any caller: anyone can drain its output float (the deploy gates it to the Diamond)";
        } else if (gate != diamond) {
            buf[n++] = string.concat(
                "venue execute is restricted to ",
                Strings.toChecksumHexString(gate),
                ", not the Diamond: liquidations through it revert"
            );
        }
        (bool assetKnown, uint8 assetDecimals) = tryDecimals(asset);
        for (uint256 i; i < assets.length; ++i) {
            // `execute` works on raw amounts and assumes equal decimals, so a
            // leg at different decimals mis-pays by a power of ten whatever
            // its USD price says. (The repriced asset's own decimals are
            // checked by the script's preflight; if they were unreadable,
            // every leg reads as unknown here.)
            (bool known, uint8 d) = tryDecimals(assets[i]);
            if (!known || !assetKnown) {
                buf[n++] = string.concat(
                    "token ",
                    Strings.toChecksumHexString(known ? asset : assets[i]),
                    " reports no decimals: its venue settlement is not substantiated"
                );
            } else if (d != assetDecimals) {
                buf[n++] = string.concat(
                    "venue settles ",
                    Strings.toChecksumHexString(assets[i]),
                    " (",
                    Strings.toString(uint256(d)),
                    " decimals) against the repriced asset (",
                    Strings.toString(uint256(assetDecimals)),
                    ") on raw amounts: the payout is off by a power of ten"
                );
            }
            string memory dev = _priceDeviation(diamond, v, assets[i]);
            if (bytes(dev).length != 0) buf[n++] = dev;
        }
        deviations = new string[](n);
        for (uint256 i; i < n; ++i) {
            deviations[i] = buf[i];
        }
    }

    /// @notice A token's decimals, or `known == false` when they cannot be
    ///         read: no code, a reverting call, or malformed return data.
    /// @dev    A high-level `try IERC20Metadata(t).decimals()` does NOT catch
    ///         a code-less address or a short return — those revert in the
    ///         caller, outside the `catch`. So this is a low-level
    ///         `staticcall` with a length check, the pattern
    ///         `OracleFacet._tryTokenDecimals` uses. Unlike that helper, it
    ///         does not default to 18: the report exists to state an unknown,
    ///         not to paper over one.
    function tryDecimals(address token) public view returns (bool known, uint8 d) {
        if (token.code.length == 0) return (false, 0);
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(IERC20Metadata.decimals.selector));
        if (!ok || data.length < 32) return (false, 0);
        uint256 raw = abi.decode(data, (uint256));
        if (raw > type(uint8).max) return (false, 0);
        return (true, uint8(raw));
    }

    function _priceDeviation(address diamond, MockSwapAdapter v, address asset) internal view returns (string memory) {
        uint256 venue8 = v.tokenUsdPrice8(asset);
        if (venue8 == 0) {
            return string.concat(
                "venue has no price for ",
                Strings.toChecksumHexString(asset),
                ": a liquidation pairing it pays a 1:1 base, then outputMultiplierBps"
            );
        }
        try IRepriceDiamondViews(diamond).getAssetPrice(asset) returns (uint256 p, uint8 d) {
            if (d > 18 || p * 10 ** (18 - d) != venue8 * 10 ** (18 - VENUE_PRICE_DECIMALS)) {
                return string.concat(
                    "venue pays ",
                    Strings.toChecksumHexString(asset),
                    " at e8 ",
                    Strings.toString(venue8),
                    " but the oracle reads ",
                    Strings.toString(p),
                    " at ",
                    Strings.toString(uint256(d)),
                    " decimals"
                );
            }
            return "";
        } catch {
            return string.concat(
                "oracle has no price for ", Strings.toChecksumHexString(asset), ": its venue price is not compared"
            );
        }
    }
}
