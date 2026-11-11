// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultBeacon} from "../src/VaultBeacon.sol";
import {VaultOutflowTypes} from "../src/vault/VaultOutflowTypes.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

/**
 * @title  VaultCreate2Test
 * @notice #3393 — every vault is created by the Diamond with CREATE2, salted
 *         by its owner wallet, so its address is a function of that creation
 *         owner alone. A vault tells a genuine vault from a look-alike by that
 *         address: a BeaconProxy anyone else deploys, running the same code and
 *         recording any owner it likes, is not genuine.
 */
contract VaultCreate2Test is SetupTest {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        setupHelper();
    }

    function _vaultOf(address who) internal returns (address) {
        return VaultFactoryFacet(address(diamond)).getOrCreateUserVault(who);
    }

    function test_theVaultSitsAtTheAddressItsCreationOwnerDerives() public {
        address v = _vaultOf(alice);
        VaipakamVaultImplementation vault = VaipakamVaultImplementation(v);
        assertEq(vault.vaultCreationOwner(), alice, "the creation owner is recorded");
        assertEq(vault.vaultOwner(), alice, "and is the first owner record");
        assertEq(vault.vaultAddressOf(alice), v, "the address is the creation owner's derivation");
        address bobs = _vaultOf(bob);
        assertEq(vault.vaultAddressOf(bob), bobs, "any vault derives any other vault's address");
    }

    function test_theFactoryCannotCreateASecondVaultForOneOwner() public {
        address v = _vaultOf(alice);
        assertEq(_vaultOf(alice), v, "the same vault comes back");
    }

    /// @notice A look-alike: the same BeaconProxy code under the same beacon,
    ///         initialized by whoever deployed it with a forged owner record.
    ///         It passes a code-hash test but sits at no owner's derived
    ///         address, so a holder payout to it is refused at the vault.
    function test_aLookAlikeVaultIsNotGenuine() public {
        address v = _vaultOf(alice);
        address beacon = VaultFactoryFacet(address(diamond)).getVaultBeacon();
        address forged = address(new BeaconProxy(beacon, ""));
        VaipakamVaultImplementation(forged).initialize(address(diamond), bob);
        assertEq(forged.codehash, v.codehash, "fixture: same code as a genuine vault");
        assertTrue(VaipakamVaultImplementation(v).vaultAddressOf(bob) != forged, "not bob's derived address");

        VaultOutflowTypes.Outflow memory o;
        o.class_ = VaultOutflowTypes.OutflowClass.ClaimCustody;
        o.kind = VaultOutflowTypes.AssetKind.ERC20;
        o.asset = address(mockERC20);
        o.amount = 1;
        o.to = forged;
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamVaultImplementation.OutflowDestinationRefused.selector,
                VaultOutflowTypes.OutflowClass.ClaimCustody,
                forged
            )
        );
        VaipakamVaultImplementation(v).transferOut(o);
    }

    function test_theBeaconPublishesTheProxyInitCodeHash() public view {
        VaultBeacon beacon = VaultBeacon(VaultFactoryFacet(address(diamond)).getVaultBeacon());
        assertEq(
            beacon.PROXY_INIT_CODE_HASH(),
            keccak256(abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(address(beacon), bytes(""))))
        );
    }
}
