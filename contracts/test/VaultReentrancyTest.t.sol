// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibReentrancyGuard} from "../src/libraries/LibReentrancyGuard.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {VaultOutflowFacet} from "../src/facets/VaultOutflowFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VaultOutflowTypes, OutflowReason} from "../src/vault/VaultOutflowTypes.sol";

/// @dev An owner wallet that is a contract and, when its vault pays it an
///      NFT, tries to re-enter the Diamond from the receiver hook.
contract ReenteringOwner is IERC721Receiver {
    address internal immutable DIAMOND;
    address internal immutable NFT;
    bool internal armed;

    constructor(address diamond, address nft) {
        DIAMOND = diamond;
        NFT = nft;
    }

    function arm() external {
        armed = true;
    }

    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false;
            // Put the token straight back through the Diamond: a guarded entry.
            VaultDepositoryFacet(DIAMOND).depositToVault(uint8(LibVaipakam.AssetType.ERC721), NFT, tokenId, 1);
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

/**
 * @title  VaultReentrancyTest
 * @notice #3432 — the vault carries no reentrancy guard of its own. Every move
 *         out of a vault passes the Diamond's one host, and the host runs only
 *         inside a guarded action, so a receiver hook or a grant's spender that
 *         re-enters the Diamond is refused there.
 *         - An NFT payout whose receiver hook re-enters a guarded entry reverts
 *           whole, and the token stays in the vault.
 *         - Every host entry (outflows, grant, grant close) refuses to run with
 *           neither the guard nor a fill lock held.
 *         - The vault trusts only the Diamond: not itself, and it has no owner
 *           record left to call.
 */
contract VaultReentrancyTest is SetupTest {
    MockRentableNFT721 internal nft;
    ERC20Mock internal token;
    ReenteringOwner internal hookOwner;
    address internal alice = makeAddr("alice");

    function setUp() public {
        setupHelper();
        nft = new MockRentableNFT721();
        token = new ERC20Mock("Guard", "GRD", 18);
        hookOwner = new ReenteringOwner(address(diamond), address(nft));
        nft.mint(address(hookOwner), 7);
        hookOwner.call(address(nft), abi.encodeCall(nft.setApprovalForAll, (address(diamond), true)));
        hookOwner.call(
            address(diamond),
            abi.encodeCall(VaultDepositoryFacet.depositToVault, (uint8(LibVaipakam.AssetType.ERC721), address(nft), 7, 1))
        );
        token.mint(alice, 10 ether);
        vm.startPrank(alice);
        token.approve(address(diamond), 10 ether);
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC20), address(token), 0, 10 ether);
        vm.stopPrank();
    }

    function _vault(address who) internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
    }

    /// @notice The NFT payout hands control to the owner's hook, which
    ///         re-enters a guarded Diamond entry: the whole withdrawal reverts
    ///         and the token stays in the vault.
    function test_anNftPayoutHookThatReentersTheDiamondIsRefused() public {
        address v = _vault(address(hookOwner));
        assertEq(nft.ownerOf(7), v, "deposited");
        hookOwner.arm();
        vm.expectRevert(LibReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        hookOwner.call(
            address(diamond),
            abi.encodeCall(
                VaultDepositoryFacet.withdrawFromVault,
                (address(hookOwner), uint8(LibVaipakam.AssetType.ERC721), address(nft), 7, 1, address(hookOwner))
            )
        );
        assertEq(nft.ownerOf(7), v, "the token never left");
    }

    /// @notice Without the re-entry the same withdrawal pays the hook's owner.
    function test_theSameNftPayoutWithoutReentryPays() public {
        hookOwner.call(
            address(diamond),
            abi.encodeCall(
                VaultDepositoryFacet.withdrawFromVault,
                (address(hookOwner), uint8(LibVaipakam.AssetType.ERC721), address(nft), 7, 1, address(hookOwner))
            )
        );
        assertEq(nft.ownerOf(7), address(hookOwner), "paid");
    }

    /// @notice Every outflow entry of the host refuses to run outside a
    ///         guarded action, even when the Diamond itself calls it.
    function test_everyOutflowEntryRefusesOutsideAGuardedAction() public {
        VaultOutflowFacet host = VaultOutflowFacet(address(diamond));
        VaultOutflowTypes.Outflow memory o;
        o.kind = VaultOutflowTypes.AssetKind.ERC20;
        o.asset = address(token);
        o.amount = 1 ether;
        o.to = alice;
        o.class_ = VaultOutflowTypes.OutflowClass.Owner;

        vm.expectRevert(VaultOutflowFacet.VaultMoveOutsideGuard.selector);
        vm.prank(address(diamond));
        host.vaultOutflow(alice, o);

        vm.expectRevert(VaultOutflowFacet.VaultMoveOutsideGuard.selector);
        vm.prank(address(diamond));
        host.vaultOutflowArgs(alice, 0, address(token), 0, 1 ether, alice, uint8(o.class_), 0, 0, OutflowReason.WITHDRAW);

        vm.expectRevert(VaultOutflowFacet.VaultMoveOutsideGuard.selector);
        vm.prank(address(diamond));
        host.vaultOutflowToOwner(alice, 0, address(token), 0, 1 ether, OutflowReason.WITHDRAW);

        vm.expectRevert(VaultOutflowFacet.VaultMoveOutsideGuard.selector);
        vm.prank(address(diamond));
        host.vaultOutflowToDiamondERC20(alice, address(token), 1 ether, 0, OutflowReason.WITHDRAW);

        assertEq(token.balanceOf(_vault(alice)), 10 ether, "nothing moved");
    }

    /// @notice The grant and its close refuse to run outside a guarded action.
    function test_theGrantEntriesRefuseOutsideAGuardedAction() public {
        VaultOutflowFacet host = VaultOutflowFacet(address(diamond));
        VaultOutflowTypes.Grant memory g = VaultOutflowTypes.Grant({
            kind: VaultOutflowTypes.AssetKind.ERC20,
            asset: address(token),
            tokenId: 0,
            amount: 1 ether,
            spender: makeAddr("spender"),
            class_: VaultOutflowTypes.GrantClass.OrderTaker,
            ref: 1
        });
        vm.expectRevert(VaultOutflowFacet.VaultMoveOutsideGuard.selector);
        vm.prank(address(diamond));
        host.vaultGrant(alice, g);

        vm.expectRevert(VaultOutflowFacet.VaultMoveOutsideGuard.selector);
        vm.prank(address(diamond));
        host.vaultCloseGrant(alice);
    }

    /// @notice The vault trusts only the Diamond: a call from the vault to
    ///         itself is refused like any stranger's.
    function test_theVaultDoesNotTrustItself() public {
        address v = _vault(alice);
        VaultOutflowTypes.Outflow memory o;
        o.kind = VaultOutflowTypes.AssetKind.ERC20;
        o.asset = address(token);
        o.amount = 1 ether;
        o.to = alice;
        o.class_ = VaultOutflowTypes.OutflowClass.Owner;
        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        vm.prank(v);
        VaipakamVaultImplementation(v).transferOut(o);

        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        vm.prank(v);
        VaipakamVaultImplementation(v).depositERC20(address(token), 1 ether);
    }

    /// @notice The vault has no owner record: the Ownable entries are gone.
    function test_theVaultHasNoOwnableSurface() public {
        address v = _vault(alice);
        (bool ok,) = v.staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "owner() is gone");
        vm.prank(address(diamond));
        (ok,) = v.call(abi.encodeWithSignature("renounceOwnership()"));
        assertFalse(ok, "renounceOwnership() is gone");
        vm.prank(address(diamond));
        (ok,) = v.call(abi.encodeWithSignature("transferOwnership(address)", alice));
        assertFalse(ok, "transferOwnership() is gone");
    }
}
