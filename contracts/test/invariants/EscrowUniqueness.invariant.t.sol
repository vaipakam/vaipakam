// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {EscrowFactoryFacet} from "../../src/facets/EscrowFactoryFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title EscrowUniquenessInvariant
 * @notice Every onboarded user has exactly one per-user escrow proxy for
 *         the entire lifetime of the protocol. The EscrowFactoryFacet
 *         treats the user => escrow mapping as write-once; once a proxy
 *         is deployed via `getOrCreateUserEscrow`, subsequent lookups
 *         must return the same address and no code path is permitted to
 *         mint a second proxy for the same wallet.
 *
 *         A second escrow for the same user would silently split their
 *         custody pool: some assets in the old proxy, some in the new,
 *         and the diamond can only ever reference one of them at a time.
 *         That's a direct silent-drain path — assets in the "other"
 *         proxy become unreachable to the protocol's flow logic while
 *         still sitting in the custody perimeter.
 *
 *         Two properties are asserted, for all six fuzz actors:
 *           1. `getUserEscrowAddress(user)` is non-zero (onboarding
 *              ran during InvariantBase.deploy).
 *           2. Repeated calls to `getUserEscrowAddress(user)` return the
 *              identical address — i.e. no action in the fuzz sequence
 *              has swapped the bound proxy out from under the user.
 */
contract EscrowUniquenessInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    // Snapshot of each actor's escrow address captured immediately after
    // onboarding. Subsequent lookups must match exactly.
    mapping(address => address) internal initialEscrow;
    address[] internal actors;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);

        EscrowFactoryFacet f = EscrowFactoryFacet(address(base.diamond()));
        for (uint256 i = 0; i < 3; i++) {
            address lender = base.lenderAt(i);
            address borrower = base.borrowerAt(i);
            actors.push(lender);
            actors.push(borrower);
            initialEscrow[lender] = f.getUserEscrowAddress(lender);
            initialEscrow[borrower] = f.getUserEscrowAddress(borrower);
        }

        targetContract(address(handler));
    }

    function invariant_EscrowAddressStable() public view {
        EscrowFactoryFacet f = EscrowFactoryFacet(address(base.diamond()));
        for (uint256 i = 0; i < actors.length; i++) {
            address user = actors[i];
            address current = f.getUserEscrowAddress(user);
            assertTrue(current != address(0), "user escrow vanished");
            assertEq(
                current,
                initialEscrow[user],
                "user escrow address changed: second proxy deployed"
            );
        }
    }
}
