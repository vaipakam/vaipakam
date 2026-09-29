// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibSwapToRepaySizing} from "../src/libraries/LibSwapToRepaySizing.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Stands in for the Diamond: {LibSwapToRepaySizing} reads prices through
///      `OracleFacet(address(this)).getAssetPrice`, so the harness answers that
///      selector itself. The slippage cap is the library default (300 bps),
///      since the harness's protocol config is unset.
contract SizingHarness {
    mapping(address => uint256) internal price;
    mapping(address => uint8) internal feedDec;

    function setPrice(address asset, uint256 p, uint8 d) external {
        price[asset] = p;
        feedDec[asset] = d;
    }

    function getAssetPrice(address asset) external view returns (uint256, uint8) {
        return (price[asset], feedDec[asset]);
    }

    function size(address col, address prin, uint256 required, uint256 maxIn)
        external
        view
        returns (bool covers, uint256 sell, uint256 floor)
    {
        return LibSwapToRepaySizing.sizeSale(col, prin, required, maxIn);
    }
}

/**
 * @title LibSwapToRepaySizingTest
 * @notice The shared full-close sizing rule (#2317, #2322) returns EXACTLY the
 *         least covering amount — including where both tokens are coarse, the
 *         case an approximate-then-step-up sizing got badly wrong (Codex #2341
 *         r5).
 */
contract LibSwapToRepaySizingTest is Test {
    SizingHarness internal h;

    function setUp() public {
        h = new SizingHarness();
    }

    /// @dev Codex #2341 r5's example: 0-decimal collateral at $0.02, 0-decimal
    ///      principal at $1, one principal unit required, a bound of 149. At
    ///      the 3% cap, 100 units and 149 units have the same floor of 1
    ///      (⌊2 × 0.97⌋ = 1), and 99 units do not (⌊1 × 0.97⌋ = 0). The sale is
    ///      100, not the whole bound.
    function test_CoarseBothSides_SellsTheExactLeastNotTheBound() public {
        ERC20Mock col = new ERC20Mock("C0", "C0", 0);
        ERC20Mock prin = new ERC20Mock("P0", "P0", 0);
        h.setPrice(address(col), 2e6, 8); // $0.02
        h.setPrice(address(prin), 1e8, 8); // $1
        (bool covers, uint256 sell, uint256 floor) = h.size(address(col), address(prin), 1, 149);
        assertTrue(covers, "the bound covers one unit");
        assertEq(sell, 100, "exactly 100 units, not the 149 bound");
        assertEq(floor, 1, "their floor is the one unit required");
        (, uint256 below, ) = h.size(address(col), address(prin), 1, 99);
        assertEq(below, 0, "99 units cannot cover it");
    }

    /// @dev A bound below the least covering amount refuses rather than
    ///      selling a short lot.
    function test_BoundBelowTheLeast_Refuses() public {
        ERC20Mock col = new ERC20Mock("C0", "C0", 0);
        ERC20Mock prin = new ERC20Mock("P0", "P0", 0);
        h.setPrice(address(col), 2e6, 8);
        h.setPrice(address(prin), 1e8, 8);
        (bool covers, uint256 sell, uint256 floor) = h.size(address(col), address(prin), 1, 99);
        assertFalse(covers, "no lot within the bound covers the debt");
        assertEq(sell + floor, 0, "and nothing is sized");
    }

    /// @dev A zero price on either side cannot be valued: refuse.
    function test_ZeroPrice_Refuses() public {
        ERC20Mock col = new ERC20Mock("C", "C", 18);
        ERC20Mock prin = new ERC20Mock("P", "P", 18);
        h.setPrice(address(col), 0, 8);
        h.setPrice(address(prin), 1e8, 8);
        (bool covers, , ) = h.size(address(col), address(prin), 1e18, 1e30);
        assertFalse(covers, "zero collateral price");
        h.setPrice(address(col), 1e8, 8);
        h.setPrice(address(prin), 0, 8);
        (covers, , ) = h.size(address(col), address(prin), 1e18, 1e30);
        assertFalse(covers, "zero principal price");
    }

    /// @dev The exactness property on arbitrary coarse and fine decimals:
    ///      the sale covers at the independent floor, and one unit less does
    ///      not. The floor is restated here from the spec formula, not read
    ///      from the library.
    function testFuzz_ExactlyTheLeast(
        uint8 colDec,
        uint8 prinDec,
        uint256 colPrice,
        uint256 prinPrice,
        uint256 required,
        uint256 maxIn
    ) public {
        colDec = uint8(bound(colDec, 0, 18));
        prinDec = uint8(bound(prinDec, 0, 18));
        colPrice = bound(colPrice, 1, 1e14);
        prinPrice = bound(prinPrice, 1, 1e14);
        required = bound(required, 1, 1e24);
        maxIn = bound(maxIn, 1, 1e30);
        ERC20Mock col = new ERC20Mock("C", "C", colDec);
        ERC20Mock prin = new ERC20Mock("P", "P", prinDec);
        h.setPrice(address(col), colPrice, 8);
        h.setPrice(address(prin), prinPrice, 8);

        (bool covers, uint256 sell, uint256 floor) = h.size(address(col), address(prin), required, maxIn);
        if (!covers) {
            assertLt(_floor(maxIn, colPrice, colDec, prinPrice, prinDec), required, "refused only when the bound cannot cover");
            return;
        }
        assertLe(sell, maxIn, "within the bound");
        assertEq(floor, _floor(sell, colPrice, colDec, prinPrice, prinDec), "reports the floor of the sale");
        assertGe(floor, required, "covers");
        if (sell > 0) {
            assertLt(_floor(sell - 1, colPrice, colDec, prinPrice, prinDec), required, "one unit less does not");
        }
    }

    /// @dev `expectedSwapOutput` then the 3% default cap, restated.
    function _floor(uint256 x, uint256 cp, uint8 cd, uint256 pp, uint8 pd) internal pure returns (uint256) {
        uint256 expected = (x * cp * (10 ** uint256(pd)) * 1e8) / (pp * (10 ** uint256(cd)) * 1e8);
        return (expected * 9_700) / 10_000;
    }
}
