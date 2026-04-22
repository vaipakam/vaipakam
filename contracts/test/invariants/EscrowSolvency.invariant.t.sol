// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {EscrowFactoryFacet} from "../../src/facets/EscrowFactoryFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {Handler} from "./Handler.sol";

/**
 * @title EscrowSolvencyInvariant
 * @notice The protocol must always hold enough of each collateral asset to
 *         cover every Active loan's collateral commitment. If the sum of
 *         per-loan committed collateral (for loans still Active) ever
 *         exceeds the total of that asset sitting in the diamond + user
 *         escrows, something has drained custody — an audit-grade bug.
 *
 *         We scope to ERC-20 assets only (the handler only exercises those),
 *         and we only consider Active loans: Repaid/Defaulted/Settled loans
 *         have already released their collateral commitment through the
 *         claim or fallback flow, so they should not add to the required
 *         side of the inequality.
 */
contract EscrowSolvencyInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    /// @notice For every Active loan, the collateral it committed must still
    ///         be held somewhere within the protocol's custody perimeter
    ///         (diamond + per-user escrows). Sums per asset to survive
    ///         loans that commit collateral in different tokens.
    function invariant_EscrowCoversActiveCollateral() public view {
        uint256 wethCommitted = _sumActiveCollateral(base.mockWETH());
        uint256 wethHeld = _escrowPerimeterBalance(base.mockWETH());
        assertGe(
            wethHeld,
            wethCommitted,
            "WETH held < committed: escrow drained below collateral commitment"
        );

        // USDC is the principal asset but can also land back in escrow as
        // repayment proceeds pending claim. The same inequality still holds.
        uint256 usdcCommitted = _sumActiveCollateral(base.mockUSDC());
        uint256 usdcHeld = _escrowPerimeterBalance(base.mockUSDC());
        assertGe(
            usdcHeld,
            usdcCommitted,
            "USDC held < committed: escrow drained below collateral commitment"
        );
    }

    /// @dev Walk every loan the handler has ever opened, include only those
    ///      still Active, add the collateral they committed (only when the
    ///      collateralAsset matches the asset in question).
    function _sumActiveCollateral(address asset) internal view returns (uint256 total) {
        uint256 n = handler.loanIdsLength();
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = LoanFacet(address(base.diamond())).getLoanDetails(loanId);
            if (L.status != LibVaipakam.LoanStatus.Active) continue;
            if (L.collateralAsset != asset) continue;
            total += L.collateralAmount;
        }
    }

    /// @dev Sum `asset` balance across the diamond itself and every user
    ///      escrow we can enumerate (the three lenders + three borrowers).
    ///      Protocol custody is entirely inside this perimeter — any
    ///      shortfall here versus committed collateral is a bug.
    function _escrowPerimeterBalance(address asset) internal view returns (uint256 total) {
        ERC20Mock t = ERC20Mock(asset);
        total += t.balanceOf(address(base.diamond()));
        for (uint256 i = 0; i < 3; i++) {
            total += _escrowBalanceOf(base.lenderAt(i), asset, t);
            total += _escrowBalanceOf(base.borrowerAt(i), asset, t);
        }
    }

    function _escrowBalanceOf(address user, address /*asset*/, ERC20Mock t) internal view returns (uint256) {
        address escrow = EscrowFactoryFacet(address(base.diamond())).getUserEscrowAddress(user);
        if (escrow == address(0)) return 0;
        return t.balanceOf(escrow);
    }
}
