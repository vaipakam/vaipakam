// test/VaultFactoryFacetWithdrawGuardTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @title  VaultFactoryFacetWithdrawGuardTest
/// @notice #407 PR 4 (T-407-B, 2026-06-12) — focused tests for the
///         encumbrance-aware withdraw guard added to
///         `VaultFactoryFacet.vaultWithdrawERC20` (and the matching
///         ERC721 / ERC1155 selectors). The guard reads the unified
///         encumbrance aggregate (`s.encumbered[user][asset][tokenId]`)
///         and reverts any cross-facet withdraw whose `amount` would
///         dip into the active lien.
///
///         The lien lifecycle wiring (create at loan-init, release on
///         every loan-lifecycle terminal) is covered end-to-end by
///         PR 3's fixture sweep across {RepayFacet,PrecloseFacet,
///         RefinanceFacet,DefaultedFacet}Test. The point of this file
///         is to exercise the GUARD itself — both the revert branch
///         (lien > balance ⇒ amount blocked) and the partial-availability
///         branch (free balance = raw - lien).
///
/// @dev    Uses `TestMutatorFacet.setEncumberedRaw` to pin the
///         aggregate directly. That isolates the guard test from any
///         drift in the production lifecycle helpers — the production
///         lifecycle is verified by PR 3's tests; here we just want to
///         prove the chokepoint enforces what the aggregate says.
contract VaultFactoryFacetWithdrawGuardTest is SetupTest {
    function setUp() public {
        setupHelper();
    }

    // ─── ERC20 path ────────────────────────────────────────────────────

    /// @notice Negative path — direct cross-facet withdraw fails when
    ///         the requested amount exceeds the free balance (raw vault
    ///         balance minus the active encumbrance for the (user,
    ///         token, tokenId=0) tuple).
    function test_vaultWithdrawERC20_revertsWhenAmountExceedsFreeBalance() public {
        address proxy = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower
        );
        uint256 vaultBal = 10 ether;
        uint256 lien = 7 ether;
        uint256 free = vaultBal - lien;

        // Park the collateral inside the vault directly so the raw
        // balance is unambiguous (no real loan flow).
        ERC20Mock(mockCollateralERC20).mint(proxy, vaultBal);

        // Pin the lien aggregate via the test mutator — same shape
        // `LibEncumbrance.createCollateralLien` writes at
        // `LoanFacet.initiateLoan`.
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrower,
            mockCollateralERC20,
            0,
            lien
        );

        // Sanity — free balance view matches our math.
        assertEq(
            MetricsFacet(address(diamond)).getFreeBalance(
                borrower,
                mockCollateralERC20,
                0,
                vaultBal
            ),
            free,
            "MetricsFacet.getFreeBalance reports raw - encumbered"
        );

        // Any cross-facet call must come from address(this) — the
        // diamond — so pranking the diamond simulates a drifted
        // release-wire on a loan-lifecycle terminal facet.
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactoryFacet.WithdrawWouldUnderflowLien.selector,
                borrower,
                mockCollateralERC20,
                uint256(0),
                free + 1,
                free
            )
        );
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower,
            mockCollateralERC20,
            borrower,
            free + 1
        );
    }

    /// @notice Positive path — withdraw of exactly the free balance
    ///         passes through the guard and reaches the proxy.
    function test_vaultWithdrawERC20_allowsExactlyFreeBalance() public {
        address proxy = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower
        );
        uint256 vaultBal = 10 ether;
        uint256 lien = 3 ether;
        uint256 free = vaultBal - lien;

        ERC20Mock(mockCollateralERC20).mint(proxy, vaultBal);
        // Bump the protocol-tracked-vault-balance counter so the
        // post-withdraw `LibVaipakam.recordVaultWithdraw` decrement
        // doesn't underflow — this is how `vaultDepositERC20` would
        // tick it up in a real deposit flow.
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower,
            mockCollateralERC20,
            vaultBal
        );
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrower,
            mockCollateralERC20,
            0,
            lien
        );

        uint256 recipientBalBefore = ERC20Mock(mockCollateralERC20).balanceOf(borrower);

        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower,
            mockCollateralERC20,
            borrower,
            free
        );

        assertEq(
            ERC20Mock(mockCollateralERC20).balanceOf(borrower) - recipientBalBefore,
            free,
            "withdraw of exactly free balance lands at recipient"
        );
        assertEq(
            ERC20Mock(mockCollateralERC20).balanceOf(proxy),
            vaultBal - free,
            "vault retains only the encumbered remainder"
        );
    }

    /// @notice Boundary — withdraw of (free + 1) reverts with the
    ///         expected error payload.
    function test_vaultWithdrawERC20_revertsAtOnePastFree() public {
        address proxy = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower
        );
        ERC20Mock(mockCollateralERC20).mint(proxy, 100 ether);
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrower,
            mockCollateralERC20,
            0,
            40 ether
        );

        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactoryFacet.WithdrawWouldUnderflowLien.selector,
                borrower,
                mockCollateralERC20,
                uint256(0),
                60 ether + 1,
                60 ether
            )
        );
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower,
            mockCollateralERC20,
            borrower,
            60 ether + 1
        );
    }

    /// @notice Multi-lien accumulation — two independent liens on the
    ///         same (user, asset) sum into a single aggregate; the
    ///         guard caps the withdraw at raw - sum(liens).
    function test_vaultWithdrawERC20_aggregateAcrossMultipleLiens() public {
        address proxy = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower
        );
        ERC20Mock(mockCollateralERC20).mint(proxy, 50 ether);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower,
            mockCollateralERC20,
            50 ether
        );
        // The aggregate is what the guard reads — set it to the sum of
        // the two notional liens (5 + 20) directly.
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrower,
            mockCollateralERC20,
            0,
            25 ether
        );

        // Withdraw of 26 ether is over the 25-ether free cap (50 - 25).
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactoryFacet.WithdrawWouldUnderflowLien.selector,
                borrower,
                mockCollateralERC20,
                uint256(0),
                26 ether,
                25 ether
            )
        );
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower,
            mockCollateralERC20,
            borrower,
            26 ether
        );

        // After the operator-equivalent release of the first 5-ether
        // lien (simulated by dropping the aggregate to 20), the
        // borrower can pull 30 ether free.
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrower,
            mockCollateralERC20,
            0,
            20 ether
        );
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower,
            mockCollateralERC20,
            borrower,
            30 ether
        );
        assertEq(
            ERC20Mock(mockCollateralERC20).balanceOf(proxy),
            20 ether,
            "vault retains exactly the second-lien encumbrance"
        );
    }

    /// @notice Lien fully released ⇒ raw == free, withdraw of the
    ///         entire vault balance passes.
    function test_vaultWithdrawERC20_releasedLienAllowsFullDrain() public {
        address proxy = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            borrower
        );
        ERC20Mock(mockCollateralERC20).mint(proxy, 12 ether);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower,
            mockCollateralERC20,
            12 ether
        );
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrower,
            mockCollateralERC20,
            0,
            12 ether
        );

        // While lien is held, even 1 wei reverts.
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactoryFacet.WithdrawWouldUnderflowLien.selector,
                borrower,
                mockCollateralERC20,
                uint256(0),
                uint256(1),
                uint256(0)
            )
        );
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower,
            mockCollateralERC20,
            borrower,
            1
        );

        // Operator-equivalent release ⇒ aggregate back to 0.
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            borrower,
            mockCollateralERC20,
            0,
            0
        );

        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower,
            mockCollateralERC20,
            borrower,
            12 ether
        );
        assertEq(
            ERC20Mock(mockCollateralERC20).balanceOf(proxy),
            0,
            "vault drains to zero after lien release"
        );
    }

    /// @notice External-EOA call to `vaultWithdrawERC20` still reverts
    ///         with `OnlyDiamondInternal` — the guard is layered ON
    ///         TOP of the existing access gate, not a replacement.
    function test_vaultWithdrawERC20_externalCallStillRevertsOnlyDiamondInternal() public {
        // Lien state is irrelevant — the outer modifier should fire
        // before the guard.
        vm.prank(borrower);
        vm.expectRevert(VaultFactoryFacet.OnlyDiamondInternal.selector);
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            borrower,
            mockCollateralERC20,
            borrower,
            1 ether
        );
    }
}
