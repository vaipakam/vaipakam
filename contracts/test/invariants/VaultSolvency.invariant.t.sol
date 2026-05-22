// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {Handler} from "./Handler.sol";

/**
 * @title VaultSolvencyInvariant
 * @notice The protocol must always hold enough of each collateral asset to
 *         cover every Active loan's collateral commitment. If the sum of
 *         per-loan committed collateral (for loans still Active) ever
 *         exceeds the total of that asset sitting in the diamond + user
 *         vaults, something has drained custody — an audit-grade bug.
 *
 *         We scope to ERC-20 assets only (the handler only exercises those),
 *         and we only consider Active loans: Repaid/Defaulted/Settled loans
 *         have already released their collateral commitment through the
 *         claim or fallback flow, so they should not add to the required
 *         side of the inequality.
 */
contract VaultSolvencyInvariant is Test {
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
    ///         (diamond + per-user vaults). Sums per asset to survive
    ///         loans that commit collateral in different tokens.
    function invariant_VaultCoversActiveCollateral() public view {
        uint256 wethCommitted = _sumActiveCollateral(base.mockWETH());
        uint256 wethHeld = _vaultPerimeterBalance(base.mockWETH());
        assertGe(
            wethHeld,
            wethCommitted,
            "WETH held < committed: vault drained below collateral commitment"
        );

        // USDC is the principal asset but can also land back in vault as
        // repayment proceeds pending claim. The same inequality still holds.
        uint256 usdcCommitted = _sumActiveCollateral(base.mockUSDC());
        uint256 usdcHeld = _vaultPerimeterBalance(base.mockUSDC());
        assertGe(
            usdcHeld,
            usdcCommitted,
            "USDC held < committed: vault drained below collateral commitment"
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
    ///      vault we can enumerate (the three lenders + three borrowers).
    ///      Protocol custody is entirely inside this perimeter — any
    ///      shortfall here versus committed collateral is a bug.
    function _vaultPerimeterBalance(address asset) internal view returns (uint256 total) {
        ERC20Mock t = ERC20Mock(asset);
        total += t.balanceOf(address(base.diamond()));
        for (uint256 i = 0; i < 3; i++) {
            total += _vaultBalanceOf(base.lenderAt(i), asset, t);
            total += _vaultBalanceOf(base.borrowerAt(i), asset, t);
        }
    }

    function _vaultBalanceOf(address user, address /*asset*/, ERC20Mock t) internal view returns (uint256) {
        address vault = VaultFactoryFacet(address(base.diamond())).getUserVaultAddress(user);
        if (vault == address(0)) return 0;
        return t.balanceOf(vault);
    }
}
