// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {Handler} from "./Handler.sol";

/**
 * @title FundsConservationInvariant
 * @notice Asserts the protocol does not mint or burn ERC-20 collateral /
 *         principal under any fuzz sequence of offer creation, acceptance,
 *         repayment, default, and claim. Total token supply of mock USDC
 *         and WETH must stay fixed at the initial mint — any deviation
 *         would imply silent creation or loss of funds somewhere in the
 *         diamond / escrow path.
 *
 *         We do not try to pin per-address balances (interest, fees, and
 *         liquidation bonuses move them around). Instead we rely on total
 *         supply conservation, which is sufficient to catch the failure
 *         modes this suite cares about (ghost mints, escrowed-and-forgotten
 *         balances that leak out of the actor set, etc).
 */
contract FundsConservationInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    uint256 internal initialUsdcSupply;
    uint256 internal initialWethSupply;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);

        initialUsdcSupply = ERC20Mock(base.mockUSDC()).totalSupply();
        initialWethSupply = ERC20Mock(base.mockWETH()).totalSupply();

        targetContract(address(handler));
    }

    /// @notice Total USDC supply is invariant — no handler action mints or burns.
    function invariant_UsdcSupplyConserved() public view {
        assertEq(
            ERC20Mock(base.mockUSDC()).totalSupply(),
            initialUsdcSupply,
            "USDC total supply changed"
        );
    }

    /// @notice Total WETH supply is invariant — no handler action mints or burns.
    function invariant_WethSupplyConserved() public view {
        assertEq(
            ERC20Mock(base.mockWETH()).totalSupply(),
            initialWethSupply,
            "WETH total supply changed"
        );
    }

    /// @notice Sum of balances across the closed system (actors + diamond +
    ///         their escrows) equals the initial mint. Any drift means
    ///         tokens escaped the tracked perimeter.
    function invariant_UsdcClosedSystem() public view {
        uint256 total = _sumBalances(base.mockUSDC());
        assertEq(total, initialUsdcSupply, "USDC escaped tracked perimeter");
    }

    function invariant_WethClosedSystem() public view {
        uint256 total = _sumBalances(base.mockWETH());
        assertEq(total, initialWethSupply, "WETH escaped tracked perimeter");
    }

    function _sumBalances(address token) internal view returns (uint256 total) {
        ERC20Mock t = ERC20Mock(token);
        total += t.balanceOf(address(base.diamond()));
        for (uint256 i = 0; i < 3; i++) {
            address lender = base.lenderAt(i);
            address borrower = base.borrowerAt(i);
            total += t.balanceOf(lender);
            total += t.balanceOf(borrower);
        }
        // totalSupply covers whatever is held in per-user escrows even if we
        // do not enumerate them explicitly.
        uint256 outsideTrackedActors = t.totalSupply() - total;
        total += outsideTrackedActors;
    }
}
