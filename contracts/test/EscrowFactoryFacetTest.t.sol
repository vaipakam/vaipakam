// test/EscrowFactoryFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {VaipakamEscrowImplementation} from "../src/VaipakamEscrowImplementation.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HelperTest} from "./HelperTest.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC1155Mock} from "./mocks/ERC1155Mock.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title EscrowFactoryFacetTest
 * @notice Tests EscrowFactoryFacet: initialization, escrow creation, ERC20/ERC721/ERC1155
 *         deposits and withdrawals, upgrade, NFT rental helpers, and error cases.
 */
contract EscrowFactoryFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address user1;
    address user2;
    address mockERC20;
    address mockNFT721;

    DiamondCutFacet cutFacet;
    EscrowFactoryFacet escrowFacet;
    AdminFacet adminFacet;
    OfferFacet offerFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;
    VaipakamEscrowImplementation escrowImpl;

    function setUp() public {
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        mockERC20 = address(new ERC20Mock("Token", "TKN", 18));
        mockNFT721 = address(new MockRentableNFT721());

        ERC20Mock(mockERC20).mint(user1, 100000 ether);
        ERC20Mock(mockERC20).mint(user2, 100000 ether);
        MockRentableNFT721(mockNFT721).mint(user1, 1);
        MockRentableNFT721(mockNFT721).mint(user1, 2);

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        escrowFacet = new EscrowFactoryFacet();
        adminFacet = new AdminFacet();
        offerFacet = new OfferFacet();
        accessControlFacet = new AccessControlFacet();
        TestMutatorFacet testMutatorFacet = new TestMutatorFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](5);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(escrowFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getEscrowFactoryFacetSelectorsExtended()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(offerFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOfferFacetSelectors()
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
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();

        // Approvals
        vm.prank(user1);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(user2);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── initializeEscrowImplementation ──────────────────────────────────────

    function testInitializeCreatesImplementation() public view {
        address impl = EscrowFactoryFacet(address(diamond)).getVaipakamEscrowImplementationAddress();
        assertNotEq(impl, address(0));
    }

    function testInitializeRevertsIfAlreadyInitialized() public {
        vm.expectRevert(EscrowFactoryFacet.AlreadyInitialized.selector);
        EscrowFactoryFacet(address(diamond)).initializeEscrowImplementation();
    }

    function testInitializeRevertsNonOwner() public {
        // Deploy a fresh diamond (not yet initialized)
        AccessControlFacet acFacet = new AccessControlFacet();
        VaipakamDiamond d2 = new VaipakamDiamond(owner, address(cutFacet));
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(escrowFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getEscrowFactoryFacetSelectorsExtended()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(acFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(d2)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(d2)).initializeAccessControl();

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user1, LibAccessControl.ESCROW_ADMIN_ROLE));
        EscrowFactoryFacet(address(d2)).initializeEscrowImplementation();
    }

    // ─── getOrCreateUserEscrow ────────────────────────────────────────────────

    function testGetOrCreateEscrowCreatesNew() public {
        vm.expectEmit(true, false, false, false);
        emit EscrowFactoryFacet.UserEscrowCreated(user1, address(0)); // address unknown, just check event
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        assertNotEq(escrow, address(0));
    }

    function testGetOrCreateEscrowReturnsSameAddress() public {
        address escrow1 = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        address escrow2 = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        assertEq(escrow1, escrow2);
    }

    function testDifferentUsersGetDifferentEscrows() public {
        address escrow1 = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        address escrow2 = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user2);
        assertNotEq(escrow1, escrow2);
    }

    // ─── upgradeEscrowImplementation ─────────────────────────────────────────

    function testUpgradeImplementationSuccess() public {
        VaipakamEscrowImplementation newImpl = new VaipakamEscrowImplementation();
        address oldImpl = EscrowFactoryFacet(address(diamond)).getVaipakamEscrowImplementationAddress();

        // Expect the enriched 3-arg event — newVersion is the bumped
        // currentEscrowVersion after the upgrade lands. `checkData=true`
        // confirms the version value.
        vm.expectEmit(true, true, true, true);
        emit EscrowFactoryFacet.EscrowImplementationUpgraded(
            oldImpl,
            address(newImpl),
            1 // first upgrade → version bumps from 0 → 1
        );
        EscrowFactoryFacet(address(diamond)).upgradeEscrowImplementation(address(newImpl));

        assertEq(
            EscrowFactoryFacet(address(diamond)).getVaipakamEscrowImplementationAddress(),
            address(newImpl)
        );
    }

    function testUpgradeImplementationRevertsNonContract() public {
        vm.expectRevert(EscrowFactoryFacet.UpgradeFailed.selector);
        EscrowFactoryFacet(address(diamond)).upgradeEscrowImplementation(makeAddr("notAContract"));
    }

    function testUpgradeImplementationRevertsNonOwner() public {
        VaipakamEscrowImplementation newImpl = new VaipakamEscrowImplementation();
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user1, LibAccessControl.ESCROW_ADMIN_ROLE));
        EscrowFactoryFacet(address(diamond)).upgradeEscrowImplementation(address(newImpl));
    }

    // ─── escrowDepositERC20 / escrowWithdrawERC20 ─────────────────────────────

    function testEscrowWithdrawERC20() public {
        // T-051 — pre-fund the escrow via the chokepoint so the
        // protocolTrackedEscrowBalance counter is set before the
        // withdraw decrements it. `deal` would skip the counter
        // increment and the subsequent withdraw would underflow.
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC20(user1, mockERC20, 500 ether);

        uint256 user1Before = ERC20(mockERC20).balanceOf(user1);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowWithdrawERC20(user1, mockERC20, user1, 200 ether);
        assertEq(ERC20(mockERC20).balanceOf(user1) - user1Before, 200 ether);
        assertEq(ERC20(mockERC20).balanceOf(escrow), 300 ether);
        // Counter was 500 after the deposit, ticks down to 300 after
        // the 200 ether withdraw.
        assertEq(
            EscrowFactoryFacet(address(diamond))
                .getProtocolTrackedEscrowBalance(user1, mockERC20),
            300 ether
        );
    }

    function testEscrowWithdrawERC20ToThirdParty() public {
        // Pre-fund via the chokepoint (see testEscrowWithdrawERC20).
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC20(user1, mockERC20, 100 ether);

        uint256 user2Before = ERC20(mockERC20).balanceOf(user2);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowWithdrawERC20(user1, mockERC20, user2, 100 ether);
        assertEq(ERC20(mockERC20).balanceOf(user2) - user2Before, 100 ether);
        assertEq(ERC20(mockERC20).balanceOf(escrow), 0);
    }

    // ─── escrowDepositERC721 / escrowWithdrawERC721 ───────────────────────────

    function testEscrowDepositAndWithdrawERC721() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        // Transfer NFT directly to escrow (simulates deposit)
        vm.prank(user1);
        IERC721(mockNFT721).transferFrom(user1, escrow, 1);
        assertEq(IERC721(mockNFT721).ownerOf(1), escrow);

        // Withdraw NFT back to user1 via diamond facet
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowWithdrawERC721(user1, mockNFT721, 1, user1);
        assertEq(IERC721(mockNFT721).ownerOf(1), user1);
    }

    // ─── escrowSetNFTUser / escrowGetNFTUserOf / escrowGetNFTUserExpires ─────

    function testEscrowSetNFTUserAndQuery() public {
        // Create escrow for user1 (NFT owner/lender)
        EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        // Approve escrow as operator on the NFT
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        vm.prank(user1);
        IERC721(mockNFT721).setApprovalForAll(escrow, true);

        uint64 expires = uint64(block.timestamp + 30 days);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowSetNFTUser(user1, mockNFT721, 1, user2, expires);

        assertEq(EscrowFactoryFacet(address(diamond)).escrowGetNFTUserOf(user1, mockNFT721, 1), user2);
        assertEq(EscrowFactoryFacet(address(diamond)).escrowGetNFTUserExpires(user1, mockNFT721, 1), expires);
    }

    function testEscrowSetNFTUserRevertsNotDiamondInternal() public {
        vm.expectRevert(EscrowFactoryFacet.OnlyDiamondInternal.selector);
        EscrowFactoryFacet(address(diamond)).escrowSetNFTUser(
            makeAddr("noEscrowUser"),
            mockNFT721,
            1,
            user2,
            uint64(block.timestamp + 1 days)
        );
    }

    function testEscrowGetNFTUserOfReturnsZeroForNoEscrow() public {
        assertEq(
            EscrowFactoryFacet(address(diamond)).escrowGetNFTUserOf(makeAddr("x"), mockNFT721, 1),
            address(0)
        );
    }

    function testEscrowGetNFTUserExpiresReturnsZeroForNoEscrow() public {
        assertEq(
            EscrowFactoryFacet(address(diamond)).escrowGetNFTUserExpires(makeAddr("x"), mockNFT721, 1),
            0
        );
    }

    // ─── getOfferAmount / getVaipakamEscrowImplementationAddress ───────────────

    function testGetOfferAmountReturnsZeroForNonExistent() public view {
        assertEq(EscrowFactoryFacet(address(diamond)).getOfferAmount(999), 0);
    }

    function testGetVaipakamEscrowImplementationAddressNotZero() public view {
        assertNotEq(
            EscrowFactoryFacet(address(diamond)).getVaipakamEscrowImplementationAddress(),
            address(0)
        );
    }

    // ─── getDiamondAddress ───────────────────────────────────────────────────

    function testGetDiamondAddressReturnsStoredAddress() public {
        // diamondAddress is set during EscrowFactoryFacet initialization
        // After getOrCreateUserEscrow, the diamond address should be stored
        EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        // getDiamondAddress reads s.diamondAddress which is set in initializeEscrowImplementation
        address stored = EscrowFactoryFacet(address(diamond)).getDiamondAddress();
        // The diamond address is set to address(this) context; just verify the call works
        assertEq(stored, address(diamond));
    }

    // ─── escrowApproveNFT721 ─────────────────────────────────────────────────

    function testEscrowApproveNFT721() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        // Transfer NFT directly to escrow (escrow must own the token to approve it)
        vm.prank(user1);
        IERC721(mockNFT721).transferFrom(user1, escrow, 2);
        assertEq(IERC721(mockNFT721).ownerOf(2), escrow);

        // Approve diamond as operator from escrow's perspective
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowApproveNFT721(user1, mockNFT721, 2);
        // If no revert, the approval succeeded
    }

    // ─── escrowDepositERC20 ───────────────────────────────────────────────────

    function testEscrowDepositERC20() public {
        // T-051 — `escrowDepositERC20` is now the protocol-wide
        // chokepoint: it pulls from `user`'s wallet (using the
        // Diamond's allowance from `user`) into the user's escrow,
        // and ticks the protocolTrackedEscrowBalance counter. The
        // setUp helper has already approved Diamond for user1, so
        // user1 just needs to hold a non-zero balance.
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        uint256 escrowBefore = ERC20(mockERC20).balanceOf(escrow);
        uint256 trackedBefore = EscrowFactoryFacet(address(diamond))
            .getProtocolTrackedEscrowBalance(user1, mockERC20);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC20(user1, mockERC20, 50 ether);
        assertEq(ERC20(mockERC20).balanceOf(escrow) - escrowBefore, 50 ether);
        // Counter ticks up under user1.
        uint256 trackedAfter = EscrowFactoryFacet(address(diamond))
            .getProtocolTrackedEscrowBalance(user1, mockERC20);
        assertEq(trackedAfter - trackedBefore, 50 ether);
    }

    /// @dev Cross-payer chokepoint variant — borrower pays the lender.
    ///      Counter ticks up under the *user* (the escrow owner =
    ///      lender), even though the *payer* is the borrower.
    function testEscrowDepositERC20From() public {
        // user2 pays into user1's escrow.
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        uint256 escrowBefore = ERC20(mockERC20).balanceOf(escrow);
        uint256 user1TrackedBefore = EscrowFactoryFacet(address(diamond))
            .getProtocolTrackedEscrowBalance(user1, mockERC20);
        uint256 user2TrackedBefore = EscrowFactoryFacet(address(diamond))
            .getProtocolTrackedEscrowBalance(user2, mockERC20);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC20From(
            user2, // payer
            user1, // user (escrow owner)
            mockERC20,
            40 ether
        );
        assertEq(ERC20(mockERC20).balanceOf(escrow) - escrowBefore, 40 ether);
        // Counter ticks under user1 ONLY — user2 is the payer, not
        // the escrow owner.
        uint256 user1TrackedAfter = EscrowFactoryFacet(address(diamond))
            .getProtocolTrackedEscrowBalance(user1, mockERC20);
        uint256 user2TrackedAfter = EscrowFactoryFacet(address(diamond))
            .getProtocolTrackedEscrowBalance(user2, mockERC20);
        assertEq(user1TrackedAfter - user1TrackedBefore, 40 ether);
        assertEq(user2TrackedAfter, user2TrackedBefore);
    }

    /// @dev Counter-only sibling — used after Permit2 has already
    ///      moved funds. Verifies the counter ticks without re-issuing
    ///      a transfer.
    function testRecordEscrowDepositERC20() public {
        // Pre-condition: user1's escrow balance and tracked are
        // independently observed; the record-only call must update
        // tracked but NOT balanceOf.
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        uint256 escrowBefore = ERC20(mockERC20).balanceOf(escrow);
        uint256 trackedBefore = EscrowFactoryFacet(address(diamond))
            .getProtocolTrackedEscrowBalance(user1, mockERC20);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).recordEscrowDepositERC20(user1, mockERC20, 25 ether);
        // No token movement.
        assertEq(ERC20(mockERC20).balanceOf(escrow), escrowBefore);
        // Counter incremented.
        uint256 trackedAfter = EscrowFactoryFacet(address(diamond))
            .getProtocolTrackedEscrowBalance(user1, mockERC20);
        assertEq(trackedAfter - trackedBefore, 25 ether);
    }

    // ─── escrowDepositERC721 ─────────────────────────────────────────────────

    function testEscrowDepositERC721() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        // Transfer NFT to diamond, then approve proxy so proxy can call safeTransferFrom(diamond, proxy, id)
        vm.prank(user1);
        IERC721(mockNFT721).transferFrom(user1, address(diamond), 2);
        vm.prank(address(diamond));
        IERC721(mockNFT721).approve(escrow, 2);

        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC721(user1, mockNFT721, 2);
        assertEq(IERC721(mockNFT721).ownerOf(2), escrow);
    }

    // ─── escrowDepositERC1155 / escrowWithdrawERC1155 ────────────────────────

    function testEscrowDepositERC1155() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        ERC1155Mock mock1155 = new ERC1155Mock();

        // Force-mint tokens to diamond without triggering onERC1155Received hook.
        // Proxy needs setApprovalForAll from diamond because depositERC1155 calls
        // safeTransferFrom(diamond, proxy, ...) from the proxy's context.
        mock1155.forceMint(address(diamond), 1, 100);
        vm.prank(address(diamond));
        mock1155.setApprovalForAll(escrow, true);

        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC1155(user1, address(mock1155), 1, 50);
        assertEq(mock1155.balanceOf(escrow, 1), 50);
    }

    function testEscrowWithdrawERC1155() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        ERC1155Mock mock1155 = new ERC1155Mock();

        // Force-mint tokens directly to escrow proxy so it can withdraw —
        // `mint` would call safeTransferFrom whose receiver hook now
        // rejects non-Diamond operators (operator = mock1155 here).
        mock1155.forceMint(escrow, 1, 100);

        uint256 user2Before = mock1155.balanceOf(user2, 1);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowWithdrawERC1155(user1, address(mock1155), 1, 60, user2);
        assertEq(mock1155.balanceOf(user2, 1) - user2Before, 60);
        assertEq(mock1155.balanceOf(escrow, 1), 40);
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev Tests escrowWithdrawERC20 when the proxy call fails (ProxyCallFailed).
    function testEscrowWithdrawERC20RevertsOnProxyFailure() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        // escrow has 0 balance → withdrawERC20 inside proxy will fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(EscrowFactoryFacet.ProxyCallFailed.selector, "Withdraw ERC20 failed"));
        EscrowFactoryFacet(address(diamond)).escrowWithdrawERC20(user1, mockERC20, user2, 9999 ether);
    }

    /// @dev Tests escrowDepositERC721 failure branch (ProxyCallFailed).
    function testEscrowDepositERC721RevertsWhenFails() public {
        // Try to deposit NFT that we don't own (token 999 doesn't exist) → proxy call should fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(EscrowFactoryFacet.ProxyCallFailed.selector, "Deposit ERC721 failed"));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC721(user1, mockNFT721, 999);
    }

    /// @dev Tests escrowWithdrawERC721 failure branch (ProxyCallFailed).
    function testEscrowWithdrawERC721RevertsWhenFails() public {
        // Create escrow but don't put NFT inside → withdraw should fail
        EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(EscrowFactoryFacet.ProxyCallFailed.selector, "Withdraw ERC721 failed"));
        EscrowFactoryFacet(address(diamond)).escrowWithdrawERC721(user1, mockNFT721, 999, user1);
    }

    /// @dev Tests escrowWithdrawERC1155 failure branch (ProxyCallFailed).
    function testEscrowWithdrawERC1155RevertsWhenFails() public {
        ERC1155Mock mock1155 = new ERC1155Mock();
        EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        // Escrow has 0 balance → should fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(EscrowFactoryFacet.ProxyCallFailed.selector, "Withdraw ERC1155 failed"));
        EscrowFactoryFacet(address(diamond)).escrowWithdrawERC1155(user1, address(mock1155), 1, 100, user2);
    }

    /// @dev T-051 — escrowDepositERC20 reverts at the safeTransferFrom
    ///      layer when the funding user lacks balance / allowance.
    ///      Replaces the old "ProxyCallFailed" expectation since the
    ///      chokepoint now does the transfer inline (instead of
    ///      forwarding to the proxy's `depositERC20`).
    function testEscrowDepositERC20RevertsWhenUserHasNoBalance() public {
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
        EscrowFactoryFacet(address(diamond)).escrowDepositERC20(pauper, mockERC20, 999 ether);
    }

    /// @dev setUser MUST succeed for non-IERC4907 NFTs and record escrow-side
    ///      rental state — the escrow is the stable wrapper third-party
    ///      integrators query when the underlying NFT is not 4907-compliant.
    function testEscrowSetNFTUserSucceedsForNon4907() public {
        EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        uint64 expires = uint64(block.timestamp + 1 days);
        vm.prank(address(diamond));
        EscrowFactoryFacet(address(diamond)).escrowSetNFTUser(
            user1,
            mockERC20,
            1,
            user2,
            expires
        );
        assertEq(
            EscrowFactoryFacet(address(diamond)).escrowGetNFTUserOf(user1, mockERC20, 1),
            user2
        );
        assertEq(
            EscrowFactoryFacet(address(diamond)).escrowGetNFTUserExpires(user1, mockERC20, 1),
            expires
        );
    }

    /// @dev Tests escrowSetNFTUser failure when proxy call fails with empty returnData.
    ///      Covers `revert ProxyCallFailed("Set NFT user failed")` branch (returnData.length == 0).
    ///      Uses a mock proxy that returns empty data on call failure.
    function testEscrowSetNFTUserRevertsWithEmptyReturnData() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        // Override the proxy address in storage to a contract that always reverts with empty data.
        // Use vm.mockCallRevert to make the escrow's setUser call revert with empty bytes.
        vm.mockCallRevert(
            escrow,
            abi.encodeWithSelector(VaipakamEscrowImplementation.setUser.selector),
            "" // empty return data
        );
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(EscrowFactoryFacet.ProxyCallFailed.selector, "Set NFT user failed"));
        EscrowFactoryFacet(address(diamond)).escrowSetNFTUser(user1, mockNFT721, 1, user2, uint64(block.timestamp + 1 days));
        vm.clearMockedCalls();
    }

    /// @dev Tests escrowGetNFTUserOf returns 0 when proxy staticcall fails (proxy exists but call reverts).
    ///      Covers `if (!success) return address(0)` in escrowGetNFTUserOf.
    function testEscrowGetNFTUserOfReturnsZeroOnCallFailure() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        // Mock the userOf staticcall on the escrow to fail
        vm.mockCallRevert(
            escrow,
            abi.encodeWithSelector(VaipakamEscrowImplementation.userOf.selector),
            "fail"
        );
        address result = EscrowFactoryFacet(address(diamond)).escrowGetNFTUserOf(user1, mockNFT721, 1);
        assertEq(result, address(0));
        vm.clearMockedCalls();
    }

    /// @dev Tests escrowGetNFTUserExpires returns 0 when proxy staticcall fails.
    ///      Covers `if (!success) return 0` in escrowGetNFTUserExpires.
    function testEscrowGetNFTUserExpiresReturnsZeroOnCallFailure() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        // Mock the userExpires staticcall to fail
        vm.mockCallRevert(
            escrow,
            abi.encodeWithSelector(VaipakamEscrowImplementation.userExpires.selector),
            "fail"
        );
        uint64 result = EscrowFactoryFacet(address(diamond)).escrowGetNFTUserExpires(user1, mockNFT721, 1);
        assertEq(result, 0);
        vm.clearMockedCalls();
    }

    /// @dev Tests escrowDepositERC1155 failure branch (ProxyCallFailed "Deposit ERC1155 failed").
    ///      The escrow proxy doesn't hold or have approval for the ERC1155 tokens,
    ///      so the depositERC1155 call fails → ProxyCallFailed revert.
    function testEscrowDepositERC1155RevertsWhenFails() public {
        ERC1155Mock mock1155 = new ERC1155Mock();
        // Don't mint tokens to the escrow or give approval → deposit will fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(EscrowFactoryFacet.ProxyCallFailed.selector, "Deposit ERC1155 failed"));
        EscrowFactoryFacet(address(diamond)).escrowDepositERC1155(user1, address(mock1155), 1, 100);
    }

    /// @dev Tests escrowApproveNFT721 failure branch (ProxyCallFailed "Approve ERC721 failed").
    ///      The escrow proxy doesn't own the NFT tokenId, so approveERC721 fails.
    function testEscrowApproveNFT721RevertsWhenFails() public {
        // Use a token ID that the escrow doesn't own → approve will fail
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(EscrowFactoryFacet.ProxyCallFailed.selector, "Approve ERC721 failed"));
        EscrowFactoryFacet(address(diamond)).escrowApproveNFT721(user1, mockNFT721, 999);
    }

    // ─── Test A: EscrowUpgradeRequired ──────────────────────────────────────

    /// @dev User has existing escrow, mandatory upgrade set to higher version,
    ///      getOrCreateUserEscrow reverts EscrowUpgradeRequired.
    function testGetOrCreateUserEscrowRevertsEscrowUpgradeRequired() public {
        // Step 1: Create escrow for user1
        EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        // Step 2: Upgrade implementation to bump currentEscrowVersion
        VaipakamEscrowImplementation newImpl = new VaipakamEscrowImplementation();
        EscrowFactoryFacet(address(diamond)).upgradeEscrowImplementation(address(newImpl));

        // Step 3: Set mandatory upgrade to the new version (version 2, since init is 1 and we bumped once)
        // currentEscrowVersion is now 2; user1's escrow is still at version 1
        EscrowFactoryFacet(address(diamond)).setMandatoryEscrowUpgrade(2);

        // Step 4: Calling getOrCreateUserEscrow for user1 again should revert
        vm.expectRevert(EscrowFactoryFacet.EscrowUpgradeRequired.selector);
        EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
    }

    // ─── Test B: upgradeUserEscrow reverts NoEscrow ─────────────────────────

    /// @dev Call upgradeUserEscrow for a user with no escrow. Should revert NoEscrow.
    function testUpgradeUserEscrowRevertsNoEscrow() public {
        vm.expectRevert(EscrowFactoryFacet.NoEscrow.selector);
        EscrowFactoryFacet(address(diamond)).upgradeUserEscrow(makeAddr("noEscrowUser"));
    }

    // ─── Test C: upgradeUserEscrow reverts UpgradeFailed ────────────────────

    /// @dev Create escrow for user1, mock the proxy's upgradeToAndCall to revert,
    ///      then call upgradeUserEscrow(user1). Should revert UpgradeFailed.
    function testUpgradeUserEscrowRevertsUpgradeFailed() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        // Mock the proxy's upgradeToAndCall to revert with empty data
        vm.mockCallRevert(
            escrow,
            abi.encodeWithSelector(UUPSUpgradeable.upgradeToAndCall.selector),
            ""
        );

        vm.expectRevert(EscrowFactoryFacet.UpgradeFailed.selector);
        EscrowFactoryFacet(address(diamond)).upgradeUserEscrow(user1);
        vm.clearMockedCalls();
    }

    // ─── Additional branch coverage ─────────────────────────────────────────

    /// @dev Covers the compound condition in getOrCreateUserEscrow else branch:
    ///      mandatoryEscrowVersion > 0 BUT user version >= mandatoryEscrowVersion,
    ///      so it does NOT revert (inner condition is false).
    function testGetOrCreateUserEscrowPassesWhenUserVersionMeetsMandatory() public {
        // Step 1: Create escrow for user1 (user gets escrowVersion = currentEscrowVersion = 0)
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        // Step 2: Upgrade implementation to bump currentEscrowVersion to 1
        VaipakamEscrowImplementation newImpl = new VaipakamEscrowImplementation();
        EscrowFactoryFacet(address(diamond)).upgradeEscrowImplementation(address(newImpl));

        // Step 3: Set user1's escrow version to 2 (above mandatory) via
        // the layout-resilient TestMutatorFacet setter.
        TestMutatorFacet(address(diamond)).setEscrowVersionRaw(user1, 2);

        // Step 4: Set mandatory to 1 (user version 2 >= mandatory 1)
        EscrowFactoryFacet(address(diamond)).setMandatoryEscrowUpgrade(1);

        // Step 5: Calling getOrCreateUserEscrow should NOT revert
        address result = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        assertEq(result, escrow, "Should return existing escrow without reverting");
    }

    /// @dev Covers setMandatoryEscrowUpgrade revert for non-owner.
    function testSetMandatoryEscrowUpgradeRevertsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user1, LibAccessControl.ESCROW_ADMIN_ROLE));
        EscrowFactoryFacet(address(diamond)).setMandatoryEscrowUpgrade(1);
    }

    // ─── VaipakamEscrowImplementation: Direct proxy auth revert tests ────────
    // These call the escrow proxy directly from an unauthorized address (user2)
    // to exercise the FALSE branch of each `require(msg.sender == DIAMOND || ...)`

    /// @dev withdrawERC20 reverts when called by unauthorized address (not DIAMOND, not self).
    function testEscrowImplWithdrawERC20RevertsUnauthorized() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        deal(mockERC20, escrow, 100 ether);

        vm.prank(user2);
        vm.expectRevert(VaipakamEscrowImplementation.NotAuthorized.selector);
        VaipakamEscrowImplementation(escrow).withdrawERC20(mockERC20, user2, 50 ether);
    }

    /// @dev depositERC721 reverts when called by unauthorized address.
    function testEscrowImplDepositERC721RevertsUnauthorized() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamEscrowImplementation.NotAuthorized.selector);
        VaipakamEscrowImplementation(escrow).depositERC721(mockNFT721, 1);
    }

    /// @dev withdrawERC721 reverts when called by unauthorized address.
    function testEscrowImplWithdrawERC721RevertsUnauthorized() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamEscrowImplementation.NotAuthorized.selector);
        VaipakamEscrowImplementation(escrow).withdrawERC721(mockNFT721, 1, user2);
    }

    /// @dev depositERC1155 reverts when called by unauthorized address.
    function testEscrowImplDepositERC1155RevertsUnauthorized() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamEscrowImplementation.NotAuthorized.selector);
        VaipakamEscrowImplementation(escrow).depositERC1155(mockNFT721, 1, 10);
    }

    /// @dev withdrawERC1155 reverts when called by unauthorized address.
    function testEscrowImplWithdrawERC1155RevertsUnauthorized() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamEscrowImplementation.NotAuthorized.selector);
        VaipakamEscrowImplementation(escrow).withdrawERC1155(mockNFT721, 1, 10, user2);
    }

    /// @dev approveERC721 reverts when called by unauthorized address.
    function testEscrowImplApproveERC721RevertsUnauthorized() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamEscrowImplementation.NotAuthorized.selector);
        VaipakamEscrowImplementation(escrow).approveERC721(mockNFT721, 1);
    }

    /// @dev setUser reverts when called by unauthorized address.
    function testEscrowImplSetUserRevertsUnauthorized() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        vm.prank(user2);
        vm.expectRevert(VaipakamEscrowImplementation.NotAuthorized.selector);
        VaipakamEscrowImplementation(escrow).setUser(mockNFT721, 1, user2, uint64(block.timestamp + 1 days));
    }

    /// @dev getOfferAmountFromDiamond reverts when the Diamond staticcall fails.
    ///      Covers the `if (!success) revert DiamondCallFailed()` branch —
    ///      the custom-error rewrite of the old `require(success, ...)`.
    function testEscrowImplGetOfferAmountRevertsOnDiamondCallFailure() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        // Mock the Diamond's getOfferAmount to revert
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(EscrowFactoryFacet.getOfferAmount.selector),
            "mock revert"
        );

        vm.expectRevert(VaipakamEscrowImplementation.DiamondCallFailed.selector);
        VaipakamEscrowImplementation(escrow).getOfferAmountFromDiamond(999);
        vm.clearMockedCalls();
    }

    /// @dev onERC1155BatchReceived returns correct selector (covers the batch receive hook).
    ///      Receiver hooks now reject operators that aren't the Diamond / self;
    ///      pass `operator = diamond` to exercise the success branch.
    function testEscrowImplOnERC1155BatchReceived() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10;
        amounts[1] = 20;

        bytes4 result = VaipakamEscrowImplementation(escrow).onERC1155BatchReceived(
            address(diamond), address(0), ids, amounts, ""
        );
        assertEq(result, IERC1155Receiver.onERC1155BatchReceived.selector);
    }

    // ─── Receiver hook authorization ─────────────────────────────────────────
    //
    // Direct user-initiated `safeTransferFrom` to the escrow proxy must
    // revert. Legitimate Diamond-mediated deposits set `operator == DIAMOND`
    // (the facet code runs in the Diamond's context, so the NFT contract
    // sees the Diamond as msg.sender of the transfer call). Anything else
    // arrives without protocol accounting and would be unrecoverable, so
    // we revert at the receiver hook itself.

    function testOnERC721ReceivedRevertsForNonDiamondOperator() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        vm.expectRevert(VaipakamEscrowImplementation.UnauthorizedNFTSender.selector);
        VaipakamEscrowImplementation(escrow).onERC721Received(user2, user1, 1, "");
    }

    function testOnERC721ReceivedAcceptsDiamondOperator() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        bytes4 result = VaipakamEscrowImplementation(escrow).onERC721Received(
            address(diamond), user1, 1, ""
        );
        assertEq(result, IERC721Receiver.onERC721Received.selector);
    }

    function testOnERC721ReceivedAcceptsSelfOperator() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        bytes4 result = VaipakamEscrowImplementation(escrow).onERC721Received(
            escrow, user1, 1, ""
        );
        assertEq(result, IERC721Receiver.onERC721Received.selector);
    }

    function testOnERC1155ReceivedRevertsForNonDiamondOperator() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        vm.expectRevert(VaipakamEscrowImplementation.UnauthorizedNFTSender.selector);
        VaipakamEscrowImplementation(escrow).onERC1155Received(user2, user1, 1, 5, "");
    }

    function testOnERC1155BatchReceivedRevertsForNonDiamondOperator() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 5;
        vm.expectRevert(VaipakamEscrowImplementation.UnauthorizedNFTSender.selector);
        VaipakamEscrowImplementation(escrow).onERC1155BatchReceived(user2, user1, ids, amounts, "");
    }

    /// @dev End-to-end: a third party calls `safeTransferFrom` directly on
    ///      the NFT contract, targeting the user's escrow proxy. The transfer
    ///      should atomically revert because the receiver hook fires with
    ///      `operator = third-party != DIAMOND`.
    function testDirectUserSafeTransferToEscrowReverts() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        // user1 owns tokenId 1 from setUp (mint(user1, 1)).
        vm.prank(user1);
        vm.expectRevert(VaipakamEscrowImplementation.UnauthorizedNFTSender.selector);
        IERC721(mockNFT721).safeTransferFrom(user1, escrow, 1);
    }

    /// @dev supportsInterface returns true for IERC721Receiver and IERC1155Receiver.
    function testEscrowImplSupportsInterface() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        assertTrue(VaipakamEscrowImplementation(escrow).supportsInterface(type(IERC721Receiver).interfaceId));
        assertTrue(VaipakamEscrowImplementation(escrow).supportsInterface(type(IERC1155Receiver).interfaceId));
        // ERC165 itself
        assertTrue(VaipakamEscrowImplementation(escrow).supportsInterface(0x01ffc9a7));
        // Random interface should return false
        assertFalse(VaipakamEscrowImplementation(escrow).supportsInterface(0xdeadbeef));
    }

    /// @dev _authorizeUpgrade reverts when called by non-owner.
    ///      Since _authorizeUpgrade is internal via onlyOwner, we test via upgradeToAndCall.
    function testEscrowImplUpgradeRevertsNonOwner() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        VaipakamEscrowImplementation newImpl = new VaipakamEscrowImplementation();

        vm.prank(user2);
        vm.expectRevert();
        UUPSUpgradeable(escrow).upgradeToAndCall(address(newImpl), "");
    }

    /// @dev depositERC20 (onlyOwner) reverts when called by unauthorized address.
    function testEscrowImplDepositERC20RevertsUnauthorized() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        vm.prank(user2);
        vm.expectRevert();
        VaipakamEscrowImplementation(escrow).depositERC20(mockERC20, 50 ether);
    }

    /// @dev getOfferAmountFromDiamond succeeds when diamond has the function.
    function testEscrowImplGetOfferAmountSuccess() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        // The diamond has getOfferAmount wired. Offer 999 doesn't exist, returns 0.
        uint256 amount = VaipakamEscrowImplementation(escrow).getOfferAmountFromDiamond(999);
        assertEq(amount, 0);
    }

    /// @dev setUser on a non-ERC4907 contract MUST still record escrow-side
    ///      rental state so integrators can query the wrapper uniformly.
    function testEscrowImplSetUserNon4907RecordsState() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        uint64 expires = uint64(block.timestamp + 1 days);

        vm.prank(address(diamond));
        VaipakamEscrowImplementation(escrow).setUser(mockERC20, 1, user2, expires);

        assertEq(VaipakamEscrowImplementation(escrow).userOf(mockERC20, 1), user2);
        assertEq(VaipakamEscrowImplementation(escrow).userExpires(mockERC20, 1), expires);
    }

    /// @dev userOf returns address(0) when NFT contract doesn't support ERC4907.
    function testEscrowImplUserOfReturnsZeroOnFailure() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        // mockERC20 doesn't have userOf → catch returns address(0)
        address result = VaipakamEscrowImplementation(escrow).userOf(mockERC20, 1);
        assertEq(result, address(0));
    }

    /// @dev userExpires returns 0 when NFT contract doesn't support ERC4907.
    function testEscrowImplUserExpiresReturnsZeroOnFailure() public {
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);

        // mockERC20 doesn't have userExpires → catch returns 0
        uint64 result = VaipakamEscrowImplementation(escrow).userExpires(mockERC20, 1);
        assertEq(result, 0);
    }

    // ─── Non-Mandatory Escrow Upgrade Tests ─────────────────────────────────

    /// @dev Tests that upgrading the implementation without setting mandatory upgrade
    ///      does NOT block getOrCreateUserEscrow for existing users.
    function testNonMandatoryUpgradeDoesNotBlock() public {
        // Step 1: Create escrow for user1
        address escrow = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        assertTrue(escrow != address(0), "Escrow should be created");

        // Step 2: Upgrade the implementation (bumps currentEscrowVersion)
        VaipakamEscrowImplementation newImpl = new VaipakamEscrowImplementation();
        EscrowFactoryFacet(address(diamond)).upgradeEscrowImplementation(address(newImpl));

        // Step 3: Do NOT call setMandatoryEscrowUpgrade

        // Step 4: Call getOrCreateUserEscrow(user1) → should succeed (not blocked)
        address result = EscrowFactoryFacet(address(diamond)).getOrCreateUserEscrow(user1);
        assertEq(result, escrow, "Should return existing escrow without reverting");
    }
}
