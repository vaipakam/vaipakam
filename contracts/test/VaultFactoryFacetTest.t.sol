// test/VaultFactoryFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC1155Mock} from "./mocks/ERC1155Mock.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title VaultFactoryFacetTest
 * @notice Tests VaultFactoryFacet: initialization, vault creation, ERC20/ERC721/ERC1155
 *         deposits and withdrawals, upgrade, NFT rental helpers, and error cases.
 */
contract VaultFactoryFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address user1;
    address user2;
    address mockERC20;
    address mockNft721;

    DiamondCutFacet cutFacet;
    VaultFactoryFacet vaultFacet;
    AdminFacet adminFacet;
    OfferCreateFacet offerCreateFacet;
    OfferAcceptFacet offerAcceptFacet;
    OfferCancelFacet offerCancelFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;
    VaipakamVaultImplementation vaultImpl;

    function setUp() public {
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        mockERC20 = address(new ERC20Mock("Token", "TKN", 18));
        mockNft721 = address(new MockRentableNFT721());

        ERC20Mock(mockERC20).mint(user1, 100000 ether);
        ERC20Mock(mockERC20).mint(user2, 100000 ether);
        MockRentableNFT721(mockNft721).mint(user1, 1);
        MockRentableNFT721(mockNft721).mint(user1, 2);

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        vaultFacet = new VaultFactoryFacet();
        adminFacet = new AdminFacet();
        offerCreateFacet = new OfferCreateFacet();
        offerAcceptFacet = new OfferAcceptFacet();
        offerCancelFacet = new OfferCancelFacet();
        accessControlFacet = new AccessControlFacet();
        TestMutatorFacet testMutatorFacet = new TestMutatorFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](7);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(vaultFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaultFactoryFacetSelectorsExtended()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(offerCreateFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferCreateFacetSelectors()
        });
        cuts[6] = IDiamondCut.FacetCut({
            facetAddress: address(offerAcceptFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferAcceptFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(testMutatorFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getTestMutatorFacetSelectors()
        });
        cuts[5] = IDiamondCut.FacetCut({facetAddress: address(offerCancelFacet), action: IDiamondCut.FacetCutAction.Add, functionSelectors: helperTest.getOfferCancelFacetSelectors()});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();

        // Approvals
        vm.prank(user1);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(user2);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── initializeVaultImplementation ──────────────────────────────────────

    function testInitializeCreatesImplementation() public view {
        address impl = VaultFactoryFacet(address(diamond)).getVaipakamVaultImplementationAddress();
        assertNotEq(impl, address(0));
    }

    function testInitializeRevertsIfAlreadyInitialized() public {
        vm.expectRevert(VaultFactoryFacet.AlreadyInitialized.selector);
        VaultFactoryFacet(address(diamond)).initializeVaultImplementation();
    }

    function testInitializeRevertsNonOwner() public {
        // Deploy a fresh diamond (not yet initialized)
        AccessControlFacet acFacet = new AccessControlFacet();
        VaipakamDiamond d2 = new VaipakamDiamond(owner, address(cutFacet));
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(vaultFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaultFactoryFacetSelectorsExtended()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(acFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(d2)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(d2)).initializeAccessControl();

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user1, LibAccessControl.VAULT_ADMIN_ROLE));
        VaultFactoryFacet(address(d2)).initializeVaultImplementation();
    }

    // ─── getOrCreateUserVault ────────────────────────────────────────────────

    function testGetOrCreateVaultCreatesNew() public {
        vm.expectEmit(true, false, false, false);
        emit VaultFactoryFacet.UserVaultCreated(user1, address(0)); // address unknown, just check event
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        assertNotEq(vault, address(0));
    }

    function testGetOrCreateVaultReturnsSameAddress() public {
        address vault1 = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        address vault2 = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        assertEq(vault1, vault2);
    }

    function testDifferentUsersGetDifferentVaults() public {
        address vault1 = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        address vault2 = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user2);
        assertNotEq(vault1, vault2);
    }

    // ─── upgradeVaultImplementation ─────────────────────────────────────────

    function testUpgradeImplementationSuccess() public {
        VaipakamVaultImplementation newImpl = new VaipakamVaultImplementation();
        address oldImpl = VaultFactoryFacet(address(diamond)).getVaipakamVaultImplementationAddress();

        // Expect the enriched 3-arg event — newVersion is the bumped
        // currentVaultVersion after the upgrade lands. `checkData=true`
        // confirms the version value.
        vm.expectEmit(true, true, true, true);
        emit VaultFactoryFacet.VaultImplementationUpgraded(
            oldImpl,
            address(newImpl),
            1 // first upgrade → version bumps from 0 → 1
        );
        VaultFactoryFacet(address(diamond)).upgradeVaultImplementation(address(newImpl));

        assertEq(
            VaultFactoryFacet(address(diamond)).getVaipakamVaultImplementationAddress(),
            address(newImpl)
        );
    }

    function testUpgradeImplementationRevertsNonContract() public {
        vm.expectRevert(VaultFactoryFacet.UpgradeFailed.selector);
        VaultFactoryFacet(address(diamond)).upgradeVaultImplementation(makeAddr("notAContract"));
    }

    function testUpgradeImplementationRevertsNonOwner() public {
        VaipakamVaultImplementation newImpl = new VaipakamVaultImplementation();
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user1, LibAccessControl.VAULT_ADMIN_ROLE));
        VaultFactoryFacet(address(diamond)).upgradeVaultImplementation(address(newImpl));
    }

    // ─── vaultDepositERC20 / vaultWithdrawERC20 ─────────────────────────────

    function testVaultWithdrawERC20() public {
        // T-051 — pre-fund the vault via the chokepoint so the
        // protocolTrackedVaultBalance counter is set before the
        // withdraw decrements it. `deal` would skip the counter
        // increment and the subsequent withdraw would underflow.
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC20(user1, mockERC20, 500 ether);

        uint256 user1Before = ERC20(mockERC20).balanceOf(user1);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(user1, mockERC20, user1, 200 ether);
        assertEq(ERC20(mockERC20).balanceOf(user1) - user1Before, 200 ether);
        assertEq(ERC20(mockERC20).balanceOf(vault), 300 ether);
        // Counter was 500 after the deposit, ticks down to 300 after
        // the 200 ether withdraw.
        assertEq(
            VaultFactoryFacet(address(diamond))
                .getProtocolTrackedVaultBalance(user1, mockERC20),
            300 ether
        );
    }

    function testVaultWithdrawERC20ToThirdParty() public {
        // Pre-fund via the chokepoint (see testVaultWithdrawERC20).
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC20(user1, mockERC20, 100 ether);

        uint256 user2Before = ERC20(mockERC20).balanceOf(user2);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(user1, mockERC20, user2, 100 ether);
        assertEq(ERC20(mockERC20).balanceOf(user2) - user2Before, 100 ether);
        assertEq(ERC20(mockERC20).balanceOf(vault), 0);
    }

    // ─── vaultDepositERC721 / vaultWithdrawERC721 ───────────────────────────

    function testVaultDepositAndWithdrawERC721() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        // Transfer NFT directly to vault (simulates deposit)
        vm.prank(user1);
        IERC721(mockNft721).transferFrom(user1, vault, 1);
        assertEq(IERC721(mockNft721).ownerOf(1), vault);

        // Withdraw NFT back to user1 via diamond facet
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC721(user1, mockNft721, 1, user1);
        assertEq(IERC721(mockNft721).ownerOf(1), user1);
    }

    // ─── vaultSetNFTUser / vaultGetNFTUserOf / vaultGetNFTUserExpires ─────

    function testVaultSetNFTUserAndQuery() public {
        // Create vault for user1 (NFT owner/lender)
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        // Approve vault as operator on the NFT
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        vm.prank(user1);
        IERC721(mockNft721).setApprovalForAll(vault, true);

        uint64 expires = uint64(block.timestamp + 30 days);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultSetNFTUser(user1, mockNft721, 1, user2, expires);

        assertEq(VaultFactoryFacet(address(diamond)).vaultGetNFTUserOf(user1, mockNft721, 1), user2);
        assertEq(VaultFactoryFacet(address(diamond)).vaultGetNFTUserExpires(user1, mockNft721, 1), expires);
    }

    function testVaultSetNFTUserRevertsNotDiamondInternal() public {
        vm.expectRevert(VaultFactoryFacet.OnlyDiamondInternal.selector);
        VaultFactoryFacet(address(diamond)).vaultSetNFTUser(
            makeAddr("noVaultUser"),
            mockNft721,
            1,
            user2,
            uint64(block.timestamp + 1 days)
        );
    }

    function testVaultGetNFTUserOfReturnsZeroForNoVault() public {
        assertEq(
            VaultFactoryFacet(address(diamond)).vaultGetNFTUserOf(makeAddr("x"), mockNft721, 1),
            address(0)
        );
    }

    function testVaultGetNFTUserExpiresReturnsZeroForNoVault() public {
        assertEq(
            VaultFactoryFacet(address(diamond)).vaultGetNFTUserExpires(makeAddr("x"), mockNft721, 1),
            0
        );
    }

    // ─── getOfferAmount / getVaipakamVaultImplementationAddress ───────────────

    function testGetOfferAmountReturnsZeroForNonExistent() public view {
        assertEq(VaultFactoryFacet(address(diamond)).getOfferAmount(999), 0);
    }

    function testGetVaipakamVaultImplementationAddressNotZero() public view {
        assertNotEq(
            VaultFactoryFacet(address(diamond)).getVaipakamVaultImplementationAddress(),
            address(0)
        );
    }

    // ─── getDiamondAddress ───────────────────────────────────────────────────

    function testGetDiamondAddressReturnsStoredAddress() public {
        // diamondAddress is set during VaultFactoryFacet initialization
        // After getOrCreateUserVault, the diamond address should be stored
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        // getDiamondAddress reads s.diamondAddress which is set in initializeVaultImplementation
        address stored = VaultFactoryFacet(address(diamond)).getDiamondAddress();
        // The diamond address is set to address(this) context; just verify the call works
        assertEq(stored, address(diamond));
    }

    // ─── vaultApproveNFT721 ─────────────────────────────────────────────────

    function testVaultApproveNFT721() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        // Transfer NFT directly to vault (vault must own the token to approve it)
        vm.prank(user1);
        IERC721(mockNft721).transferFrom(user1, vault, 2);
        assertEq(IERC721(mockNft721).ownerOf(2), vault);

        // Approve diamond as operator from vault's perspective
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultApproveNFT721(user1, mockNft721, 2);
        // If no revert, the approval succeeded
    }

    // ─── vaultDepositERC20 ───────────────────────────────────────────────────

    function testVaultDepositERC20() public {
        // T-051 — `vaultDepositERC20` is now the protocol-wide
        // chokepoint: it pulls from `user`'s wallet (using the
        // Diamond's allowance from `user`) into the user's vault,
        // and ticks the protocolTrackedVaultBalance counter. The
        // setUp helper has already approved Diamond for user1, so
        // user1 just needs to hold a non-zero balance.
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        uint256 vaultBefore = ERC20(mockERC20).balanceOf(vault);
        uint256 trackedBefore = VaultFactoryFacet(address(diamond))
            .getProtocolTrackedVaultBalance(user1, mockERC20);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC20(user1, mockERC20, 50 ether);
        assertEq(ERC20(mockERC20).balanceOf(vault) - vaultBefore, 50 ether);
        // Counter ticks up under user1.
        uint256 trackedAfter = VaultFactoryFacet(address(diamond))
            .getProtocolTrackedVaultBalance(user1, mockERC20);
        assertEq(trackedAfter - trackedBefore, 50 ether);
    }

    /// @dev Cross-payer chokepoint variant — borrower pays the lender.
    ///      Counter ticks up under the *user* (the vault owner =
    ///      lender), even though the *payer* is the borrower.
    function testVaultDepositERC20From() public {
        // user2 pays into user1's vault.
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        uint256 vaultBefore = ERC20(mockERC20).balanceOf(vault);
        uint256 user1TrackedBefore = VaultFactoryFacet(address(diamond))
            .getProtocolTrackedVaultBalance(user1, mockERC20);
        uint256 user2TrackedBefore = VaultFactoryFacet(address(diamond))
            .getProtocolTrackedVaultBalance(user2, mockERC20);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC20From(
            user2, // payer
            user1, // user (vault owner)
            mockERC20,
            40 ether
        );
        assertEq(ERC20(mockERC20).balanceOf(vault) - vaultBefore, 40 ether);
        // Counter ticks under user1 ONLY — user2 is the payer, not
        // the vault owner.
        uint256 user1TrackedAfter = VaultFactoryFacet(address(diamond))
            .getProtocolTrackedVaultBalance(user1, mockERC20);
        uint256 user2TrackedAfter = VaultFactoryFacet(address(diamond))
            .getProtocolTrackedVaultBalance(user2, mockERC20);
        assertEq(user1TrackedAfter - user1TrackedBefore, 40 ether);
        assertEq(user2TrackedAfter, user2TrackedBefore);
    }

    /// @dev Counter-only sibling — used after Permit2 has already
    ///      moved funds. Verifies the counter ticks without re-issuing
    ///      a transfer.
    function testRecordVaultDepositERC20() public {
        // Pre-condition: user1's vault balance and tracked are
        // independently observed; the record-only call must update
        // tracked but NOT balanceOf.
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        uint256 vaultBefore = ERC20(mockERC20).balanceOf(vault);
        uint256 trackedBefore = VaultFactoryFacet(address(diamond))
            .getProtocolTrackedVaultBalance(user1, mockERC20);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(user1, mockERC20, 25 ether);
        // No token movement.
        assertEq(ERC20(mockERC20).balanceOf(vault), vaultBefore);
        // Counter incremented.
        uint256 trackedAfter = VaultFactoryFacet(address(diamond))
            .getProtocolTrackedVaultBalance(user1, mockERC20);
        assertEq(trackedAfter - trackedBefore, 25 ether);
    }

    // ─── vaultDepositERC721 ─────────────────────────────────────────────────

    function testVaultDepositERC721() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        // Transfer NFT to diamond, then approve proxy so proxy can call safeTransferFrom(diamond, proxy, id)
        vm.prank(user1);
        IERC721(mockNft721).transferFrom(user1, address(diamond), 2);
        vm.prank(address(diamond));
        IERC721(mockNft721).approve(vault, 2);

        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC721(user1, mockNft721, 2);
        assertEq(IERC721(mockNft721).ownerOf(2), vault);
    }

    // ─── vaultDepositERC1155 / vaultWithdrawERC1155 ────────────────────────

    function testVaultDepositERC1155() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        ERC1155Mock mock1155 = new ERC1155Mock();

        // Force-mint tokens to diamond without triggering onERC1155Received hook.
        // Proxy needs setApprovalForAll from diamond because depositERC1155 calls
        // safeTransferFrom(diamond, proxy, ...) from the proxy's context.
        mock1155.forceMint(address(diamond), 1, 100);
        vm.prank(address(diamond));
        mock1155.setApprovalForAll(vault, true);

        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultDepositERC1155(user1, address(mock1155), 1, 50);
        assertEq(mock1155.balanceOf(vault, 1), 50);
    }

    function testVaultWithdrawERC1155() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        ERC1155Mock mock1155 = new ERC1155Mock();

        // Force-mint tokens directly to vault proxy so it can withdraw —
        // `mint` would call safeTransferFrom whose receiver hook now
        // rejects non-Diamond operators (operator = mock1155 here).
        mock1155.forceMint(vault, 1, 100);

        uint256 user2Before = mock1155.balanceOf(user2, 1);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC1155(user1, address(mock1155), 1, 60, user2);
        assertEq(mock1155.balanceOf(user2, 1) - user2Before, 60);
        assertEq(mock1155.balanceOf(vault, 1), 40);
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Tests vaultWithdrawERC20 when the proxy call fails (ProxyCallFailed).
    function testVaultWithdrawERC20RevertsOnProxyFailure() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        // vault has 0 balance → withdrawERC20 inside proxy will fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultFactoryFacet.ProxyCallFailed.selector, "Withdraw ERC20 failed"));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(user1, mockERC20, user2, 9999 ether);
    }

    /// @dev Tests vaultDepositERC721 failure branch (ProxyCallFailed).
    function testVaultDepositERC721RevertsWhenFails() public {
        // Try to deposit NFT that we don't own (token 999 doesn't exist) → proxy call should fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultFactoryFacet.ProxyCallFailed.selector, "Deposit ERC721 failed"));
        VaultFactoryFacet(address(diamond)).vaultDepositERC721(user1, mockNft721, 999);
    }

    /// @dev Tests vaultWithdrawERC721 failure branch (ProxyCallFailed).
    function testVaultWithdrawERC721RevertsWhenFails() public {
        // Create vault but don't put NFT inside → withdraw should fail
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultFactoryFacet.ProxyCallFailed.selector, "Withdraw ERC721 failed"));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC721(user1, mockNft721, 999, user1);
    }

    /// @dev Tests vaultWithdrawERC1155 failure branch (ProxyCallFailed).
    function testVaultWithdrawERC1155RevertsWhenFails() public {
        ERC1155Mock mock1155 = new ERC1155Mock();
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        // Vault has 0 balance → should fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultFactoryFacet.ProxyCallFailed.selector, "Withdraw ERC1155 failed"));
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC1155(user1, address(mock1155), 1, 100, user2);
    }

    /// @dev T-051 — vaultDepositERC20 reverts at the safeTransferFrom
    ///      layer when the funding user lacks balance / allowance.
    ///      Replaces the old "ProxyCallFailed" expectation since the
    ///      chokepoint now does the transfer inline (instead of
    ///      forwarding to the proxy's `depositERC20`).
    function testVaultDepositERC20RevertsWhenUserHasNoBalance() public {
        // Pick a fresh address with zero balance + zero allowance to
        // the diamond. user1 / user2 already have minted balances and
        // setUp granted maxUint256 allowance, so they're unsuitable
        // for this revert path.
        address pauper = makeAddr("pauper");
        vm.prank(address(diamond));
        // SafeERC20 wraps the underlying ERC20InsufficientAllowance /
        // ERC20InsufficientBalance into a generic SafeERC20FailedOperation
        // — we just assert *some* revert happens.
        vm.expectRevert();
        VaultFactoryFacet(address(diamond)).vaultDepositERC20(pauper, mockERC20, 999 ether);
    }

    /// @dev setUser MUST succeed for non-IERC4907 NFTs and record vault-side
    ///      rental state — the vault is the stable wrapper third-party
    ///      integrators query when the underlying NFT is not 4907-compliant.
    function testVaultSetNFTUserSucceedsForNon4907() public {
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        uint64 expires = uint64(block.timestamp + 1 days);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).vaultSetNFTUser(
            user1,
            mockERC20,
            1,
            user2,
            expires
        );
        assertEq(
            VaultFactoryFacet(address(diamond)).vaultGetNFTUserOf(user1, mockERC20, 1),
            user2
        );
        assertEq(
            VaultFactoryFacet(address(diamond)).vaultGetNFTUserExpires(user1, mockERC20, 1),
            expires
        );
    }

    /// @dev Tests vaultSetNFTUser failure when proxy call fails with empty returnData.
    ///      Covers `revert ProxyCallFailed("Set NFT user failed")` branch (returnData.length == 0).
    ///      Uses a mock proxy that returns empty data on call failure.
    function testVaultSetNFTUserRevertsWithEmptyReturnData() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        // Override the proxy address in storage to a contract that always reverts with empty data.
        // Use vm.mockCallRevert to make the vault's setUser call revert with empty bytes.
        vm.mockCallRevert(
            vault,
            abi.encodeWithSelector(VaipakamVaultImplementation.setUser.selector),
            "" // empty return data
        );
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultFactoryFacet.ProxyCallFailed.selector, "Set NFT user failed"));
        VaultFactoryFacet(address(diamond)).vaultSetNFTUser(user1, mockNft721, 1, user2, uint64(block.timestamp + 1 days));
        vm.clearMockedCalls();
    }

    /// @dev Tests vaultGetNFTUserOf returns 0 when proxy staticcall fails (proxy exists but call reverts).
    ///      Covers `if (!success) return address(0)` in vaultGetNFTUserOf.
    function testVaultGetNFTUserOfReturnsZeroOnCallFailure() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        // Mock the userOf staticcall on the vault to fail
        vm.mockCallRevert(
            vault,
            abi.encodeWithSelector(VaipakamVaultImplementation.userOf.selector),
            "fail"
        );
        address result = VaultFactoryFacet(address(diamond)).vaultGetNFTUserOf(user1, mockNft721, 1);
        assertEq(result, address(0));
        vm.clearMockedCalls();
    }

    /// @dev Tests vaultGetNFTUserExpires returns 0 when proxy staticcall fails.
    ///      Covers `if (!success) return 0` in vaultGetNFTUserExpires.
    function testVaultGetNFTUserExpiresReturnsZeroOnCallFailure() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        // Mock the userExpires staticcall to fail
        vm.mockCallRevert(
            vault,
            abi.encodeWithSelector(VaipakamVaultImplementation.userExpires.selector),
            "fail"
        );
        uint64 result = VaultFactoryFacet(address(diamond)).vaultGetNFTUserExpires(user1, mockNft721, 1);
        assertEq(result, 0);
        vm.clearMockedCalls();
    }

    /// @dev Tests vaultDepositERC1155 failure branch (ProxyCallFailed "Deposit ERC1155 failed").
    ///      The vault proxy doesn't hold or have approval for the ERC1155 tokens,
    ///      so the depositERC1155 call fails → ProxyCallFailed revert.
    function testVaultDepositERC1155RevertsWhenFails() public {
        ERC1155Mock mock1155 = new ERC1155Mock();
        // Don't mint tokens to the vault or give approval → deposit will fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultFactoryFacet.ProxyCallFailed.selector, "Deposit ERC1155 failed"));
        VaultFactoryFacet(address(diamond)).vaultDepositERC1155(user1, address(mock1155), 1, 100);
    }

    /// @dev Tests vaultApproveNFT721 failure branch (ProxyCallFailed "Approve ERC721 failed").
    ///      The vault proxy doesn't own the NFT tokenId, so approveERC721 fails.
    function testVaultApproveNFT721RevertsWhenFails() public {
        // Use a token ID that the vault doesn't own → approve will fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(VaultFactoryFacet.ProxyCallFailed.selector, "Approve ERC721 failed"));
        VaultFactoryFacet(address(diamond)).vaultApproveNFT721(user1, mockNft721, 999);
    }

    // ─── Test A: VaultUpgradeRequired ──────────────────────────────────────

    /// @dev User has existing vault, mandatory upgrade set to higher version,
    ///      getOrCreateUserVault reverts VaultUpgradeRequired.
    function testGetOrCreateUserVaultRevertsVaultUpgradeRequired() public {
        // Step 1: Create vault for user1
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        // Step 2: Upgrade implementation to bump currentVaultVersion
        VaipakamVaultImplementation newImpl = new VaipakamVaultImplementation();
        VaultFactoryFacet(address(diamond)).upgradeVaultImplementation(address(newImpl));

        // Step 3: Set mandatory upgrade to the new version (version 2, since init is 1 and we bumped once)
        // currentVaultVersion is now 2; user1's vault is still at version 1
        VaultFactoryFacet(address(diamond)).setMandatoryVaultUpgrade(2);

        // Step 4: Calling getOrCreateUserVault for user1 again should revert
        vm.expectRevert(VaultFactoryFacet.VaultUpgradeRequired.selector);
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
    }

    // ─── Test B: upgradeUserVault reverts NoVault ─────────────────────────

    /// @dev Call upgradeUserVault for a user with no vault. Should revert NoVault.
    function testUpgradeUserVaultRevertsNoVault() public {
        vm.expectRevert(VaultFactoryFacet.NoVault.selector);
        VaultFactoryFacet(address(diamond)).upgradeUserVault(makeAddr("noVaultUser"));
    }

    // ─── Test C: upgradeUserVault reverts UpgradeFailed ────────────────────

    /// @dev Create vault for user1, mock the proxy's upgradeToAndCall to revert,
    ///      then call upgradeUserVault(user1). Should revert UpgradeFailed.
    function testUpgradeUserVaultRevertsUpgradeFailed() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        // Mock the proxy's upgradeToAndCall to revert with empty data
        vm.mockCallRevert(
            vault,
            abi.encodeWithSelector(UUPSUpgradeable.upgradeToAndCall.selector),
            ""
        );

        vm.expectRevert(VaultFactoryFacet.UpgradeFailed.selector);
        VaultFactoryFacet(address(diamond)).upgradeUserVault(user1);
        vm.clearMockedCalls();
    }

    // ─── Additional branch coverage ─────────────────────────────────────────

    /// @dev Covers the compound condition in getOrCreateUserVault else branch:
    ///      mandatoryVaultVersion > 0 BUT user version >= mandatoryVaultVersion,
    ///      so it does NOT revert (inner condition is false).
    function testGetOrCreateUserVaultPassesWhenUserVersionMeetsMandatory() public {
        // Step 1: Create vault for user1 (user gets vaultVersion = currentVaultVersion = 0)
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        // Step 2: Upgrade implementation to bump currentVaultVersion to 1
        VaipakamVaultImplementation newImpl = new VaipakamVaultImplementation();
        VaultFactoryFacet(address(diamond)).upgradeVaultImplementation(address(newImpl));

        // Step 3: Set user1's vault version to 2 (above mandatory) via
        // the layout-resilient TestMutatorFacet setter.
        TestMutatorFacet(address(diamond)).setVaultVersionRaw(user1, 2);

        // Step 4: Set mandatory to 1 (user version 2 >= mandatory 1)
        VaultFactoryFacet(address(diamond)).setMandatoryVaultUpgrade(1);

        // Step 5: Calling getOrCreateUserVault should NOT revert
        address result = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        assertEq(result, vault, "Should return existing vault without reverting");
    }

    /// @dev Covers setMandatoryVaultUpgrade revert for non-owner.
    function testSetMandatoryVaultUpgradeRevertsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user1, LibAccessControl.VAULT_ADMIN_ROLE));
        VaultFactoryFacet(address(diamond)).setMandatoryVaultUpgrade(1);
    }

    // ─── VaipakamVaultImplementation: Direct proxy auth revert tests ────────
    // These call the vault proxy directly from an unauthorized address (user2)
    // to exercise the FALSE branch of each `require(msg.sender == DIAMOND || ...)`

    /// @dev withdrawERC20 reverts when called by unauthorized address (not DIAMOND, not self).
    function testVaultImplWithdrawERC20RevertsUnauthorized() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        deal(mockERC20, vault, 100 ether);

        vm.prank(user2);
        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        VaipakamVaultImplementation(vault).withdrawERC20(mockERC20, user2, 50 ether);
    }

    /// @dev depositERC721 reverts when called by unauthorized address.
    function testVaultImplDepositERC721RevertsUnauthorized() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        VaipakamVaultImplementation(vault).depositERC721(mockNft721, 1);
    }

    /// @dev withdrawERC721 reverts when called by unauthorized address.
    function testVaultImplWithdrawERC721RevertsUnauthorized() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        VaipakamVaultImplementation(vault).withdrawERC721(mockNft721, 1, user2);
    }

    /// @dev depositERC1155 reverts when called by unauthorized address.
    function testVaultImplDepositERC1155RevertsUnauthorized() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        VaipakamVaultImplementation(vault).depositERC1155(mockNft721, 1, 10);
    }

    /// @dev withdrawERC1155 reverts when called by unauthorized address.
    function testVaultImplWithdrawERC1155RevertsUnauthorized() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        VaipakamVaultImplementation(vault).withdrawERC1155(mockNft721, 1, 10, user2);
    }

    /// @dev approveERC721 reverts when called by unauthorized address.
    function testVaultImplApproveERC721RevertsUnauthorized() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        VaipakamVaultImplementation(vault).approveERC721(mockNft721, 1);
    }

    /// @dev setUser reverts when called by unauthorized address.
    function testVaultImplSetUserRevertsUnauthorized() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamVaultImplementation.NotAuthorized.selector);
        VaipakamVaultImplementation(vault).setUser(mockNft721, 1, user2, uint64(block.timestamp + 1 days));
    }

    /// @dev getOfferAmountFromDiamond reverts when the Diamond staticcall fails.
    ///      Covers the `if (!success) revert DiamondCallFailed()` branch —
    ///      the custom-error rewrite of the old `require(success, ...)`.
    function testVaultImplGetOfferAmountRevertsOnDiamondCallFailure() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        // Mock the Diamond's getOfferAmount to revert
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.getOfferAmount.selector),
            "mock revert"
        );

        vm.expectRevert(VaipakamVaultImplementation.DiamondCallFailed.selector);
        VaipakamVaultImplementation(vault).getOfferAmountFromDiamond(999);
        vm.clearMockedCalls();
    }

    /// @dev onERC1155BatchReceived returns correct selector (covers the batch receive hook).
    ///      Receiver hooks now reject operators that aren't the Diamond / self;
    ///      pass `operator = diamond` to exercise the success branch.
    function testVaultImplOnERC1155BatchReceived() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10;
        amounts[1] = 20;

        bytes4 result = VaipakamVaultImplementation(vault).onERC1155BatchReceived(
            address(diamond), address(0), ids, amounts, ""
        );
        assertEq(result, IERC1155Receiver.onERC1155BatchReceived.selector);
    }

    // ─── Receiver hook authorization ─────────────────────────────────────────
    //
    // Direct user-initiated `safeTransferFrom` to the vault proxy must
    // revert. Legitimate Diamond-mediated deposits set `operator == DIAMOND`
    // (the facet code runs in the Diamond's context, so the NFT contract
    // sees the Diamond as msg.sender of the transfer call). Anything else
    // arrives without protocol accounting and would be unrecoverable, so
    // we revert at the receiver hook itself.

    function testOnERC721ReceivedRevertsForNonDiamondOperator() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        vm.expectRevert(VaipakamVaultImplementation.UnauthorizedNFTSender.selector);
        VaipakamVaultImplementation(vault).onERC721Received(user2, user1, 1, "");
    }

    function testOnERC721ReceivedAcceptsDiamondOperator() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        bytes4 result = VaipakamVaultImplementation(vault).onERC721Received(
            address(diamond), user1, 1, ""
        );
        assertEq(result, IERC721Receiver.onERC721Received.selector);
    }

    function testOnERC721ReceivedAcceptsSelfOperator() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        bytes4 result = VaipakamVaultImplementation(vault).onERC721Received(
            vault, user1, 1, ""
        );
        assertEq(result, IERC721Receiver.onERC721Received.selector);
    }

    function testOnERC1155ReceivedRevertsForNonDiamondOperator() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        vm.expectRevert(VaipakamVaultImplementation.UnauthorizedNFTSender.selector);
        VaipakamVaultImplementation(vault).onERC1155Received(user2, user1, 1, 5, "");
    }

    function testOnERC1155BatchReceivedRevertsForNonDiamondOperator() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 5;
        vm.expectRevert(VaipakamVaultImplementation.UnauthorizedNFTSender.selector);
        VaipakamVaultImplementation(vault).onERC1155BatchReceived(user2, user1, ids, amounts, "");
    }

    /// @dev End-to-end: a third party calls `safeTransferFrom` directly on
    ///      the NFT contract, targeting the user's vault proxy. The transfer
    ///      should atomically revert because the receiver hook fires with
    ///      `operator = third-party != DIAMOND`.
    function testDirectUserSafeTransferToVaultReverts() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        // user1 owns tokenId 1 from setUp (mint(user1, 1)).
        vm.prank(user1);
        vm.expectRevert(VaipakamVaultImplementation.UnauthorizedNFTSender.selector);
        IERC721(mockNft721).safeTransferFrom(user1, vault, 1);
    }

    /// @dev supportsInterface returns true for IERC721Receiver and IERC1155Receiver.
    function testVaultImplSupportsInterface() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        assertTrue(VaipakamVaultImplementation(vault).supportsInterface(type(IERC721Receiver).interfaceId));
        assertTrue(VaipakamVaultImplementation(vault).supportsInterface(type(IERC1155Receiver).interfaceId));
        // ERC165 itself
        assertTrue(VaipakamVaultImplementation(vault).supportsInterface(0x01ffc9a7));
        // Random interface should return false
        assertFalse(VaipakamVaultImplementation(vault).supportsInterface(0xdeadbeef));
    }

    /// @dev _authorizeUpgrade reverts when called by non-owner.
    ///      Since _authorizeUpgrade is internal via onlyOwner, we test via upgradeToAndCall.
    function testVaultImplUpgradeRevertsNonOwner() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        VaipakamVaultImplementation newImpl = new VaipakamVaultImplementation();

        vm.prank(user2);
        vm.expectRevert();
        UUPSUpgradeable(vault).upgradeToAndCall(address(newImpl), "");
    }

    /// @dev depositERC20 (onlyOwner) reverts when called by unauthorized address.
    function testVaultImplDepositERC20RevertsUnauthorized() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        vm.prank(user2);
        vm.expectRevert();
        VaipakamVaultImplementation(vault).depositERC20(mockERC20, 50 ether);
    }

    /// @dev getOfferAmountFromDiamond succeeds when diamond has the function.
    function testVaultImplGetOfferAmountSuccess() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        // The diamond has getOfferAmount wired. Offer 999 doesn't exist, returns 0.
        uint256 amount = VaipakamVaultImplementation(vault).getOfferAmountFromDiamond(999);
        assertEq(amount, 0);
    }

    /// @dev setUser on a non-ERC4907 contract MUST still record vault-side
    ///      rental state so integrators can query the wrapper uniformly.
    function testVaultImplSetUserNon4907RecordsState() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        uint64 expires = uint64(block.timestamp + 1 days);

        vm.prank(address(diamond));
        VaipakamVaultImplementation(vault).setUser(mockERC20, 1, user2, expires);

        assertEq(VaipakamVaultImplementation(vault).userOf(mockERC20, 1), user2);
        assertEq(VaipakamVaultImplementation(vault).userExpires(mockERC20, 1), expires);
    }

    /// @dev userOf returns address(0) when NFT contract doesn't support ERC4907.
    function testVaultImplUserOfReturnsZeroOnFailure() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        // mockERC20 doesn't have userOf → catch returns address(0)
        address result = VaipakamVaultImplementation(vault).userOf(mockERC20, 1);
        assertEq(result, address(0));
    }

    /// @dev userExpires returns 0 when NFT contract doesn't support ERC4907.
    function testVaultImplUserExpiresReturnsZeroOnFailure() public {
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);

        // mockERC20 doesn't have userExpires → catch returns 0
        uint64 result = VaipakamVaultImplementation(vault).userExpires(mockERC20, 1);
        assertEq(result, 0);
    }

    // ─── Non-Mandatory Vault Upgrade Tests ─────────────────────────────────

    /// @dev Tests that upgrading the implementation without setting mandatory upgrade
    ///      does NOT block getOrCreateUserVault for existing users.
    function testNonMandatoryUpgradeDoesNotBlock() public {
        // Step 1: Create vault for user1
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        assertTrue(vault != address(0), "Vault should be created");

        // Step 2: Upgrade the implementation (bumps currentVaultVersion)
        VaipakamVaultImplementation newImpl = new VaipakamVaultImplementation();
        VaultFactoryFacet(address(diamond)).upgradeVaultImplementation(address(newImpl));

        // Step 3: Do NOT call setMandatoryVaultUpgrade

        // Step 4: Call getOrCreateUserVault(user1) → should succeed (not blocked)
        address result = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user1);
        assertEq(result, vault, "Should return existing vault without reverting");
    }
}
