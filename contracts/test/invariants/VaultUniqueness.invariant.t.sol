// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title VaultUniquenessInvariant
 * @notice Every onboarded user has exactly one per-user vault proxy for
 *         the entire lifetime of the protocol. The VaultFactoryFacet
 *         treats the user => vault mapping as write-once; once a proxy
 *         is deployed via `getOrCreateUserVault`, subsequent lookups
 *         must return the same address and no code path is permitted to
 *         mint a second proxy for the same wallet.
 *
 *         A second vault for the same user would silently split their
 *         custody pool: some assets in the old proxy, some in the new,
 *         and the diamond can only ever reference one of them at a time.
 *         That's a direct silent-drain path — assets in the "other"
 *         proxy become unreachable to the protocol's flow logic while
 *         still sitting in the custody perimeter.
 *
 *         Two properties are asserted, for all six fuzz actors:
 *           1. `getUserVaultAddress(user)` is non-zero (onboarding
 *              ran during InvariantBase.deploy).
 *           2. Repeated calls to `getUserVaultAddress(user)` return the
 *              identical address — i.e. no action in the fuzz sequence
 *              has swapped the bound proxy out from under the user.
 */
contract VaultUniquenessInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    // Snapshot of each actor's vault address captured immediately after
    // onboarding. Subsequent lookups must match exactly.
    mapping(address => address) internal initialVault;
    address[] internal actors;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);

        VaultFactoryFacet f = VaultFactoryFacet(address(base.diamond()));
        for (uint256 i = 0; i < 3; i++) {
            address lender = base.lenderAt(i);
            address borrower = base.borrowerAt(i);
            actors.push(lender);
            actors.push(borrower);
            initialVault[lender] = f.getUserVaultAddress(lender);
            initialVault[borrower] = f.getUserVaultAddress(borrower);
        }

        targetContract(address(handler));
    }

    function invariant_VaultAddressStable() public view {
        VaultFactoryFacet f = VaultFactoryFacet(address(base.diamond()));
        for (uint256 i = 0; i < actors.length; i++) {
            address user = actors[i];
            address current = f.getUserVaultAddress(user);
            assertTrue(current != address(0), "user vault vanished");
            assertEq(
                current,
                initialVault[user],
                "user vault address changed: second proxy deployed"
            );
        }
    }
}
