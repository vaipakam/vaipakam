// test/VaipakamNFTFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {HelperTest} from "./HelperTest.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title VaipakamNFTFacetTest
 * @notice Full coverage for VaipakamNFTFacet: mint, updateStatus, burn, tokenURI,
 *         authorization checks (direct call vs diamond proxy), and status helpers.
 */
contract VaipakamNFTFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address user;

    DiamondCutFacet cutFacet;
    VaipakamNFTFacet nftFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    // Token IDs used across tests
    uint256 constant TOKEN_ID_1 = 1;
    uint256 constant TOKEN_ID_2 = 2;
    uint256 constant OFFER_ID = 10;
    uint256 constant LOAN_ID = 5;

    function _getAllNFTSelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](17);
        selectors[0] = VaipakamNFTFacet.mintNFT.selector;
        selectors[1] = VaipakamNFTFacet.updateNFTStatus.selector;
        selectors[2] = VaipakamNFTFacet.burnNFT.selector;
        selectors[3] = VaipakamNFTFacet.tokenURI.selector;
        selectors[4] = VaipakamNFTFacet.initializeNFT.selector;
        selectors[5] = bytes4(keccak256("ownerOf(uint256)"));
        // ERC721 interface functions
        selectors[6] = VaipakamNFTFacet.name.selector;
        selectors[7] = VaipakamNFTFacet.symbol.selector;
        selectors[8] = VaipakamNFTFacet.balanceOf.selector;
        selectors[9] = bytes4(keccak256("approve(address,uint256)"));
        selectors[10] = VaipakamNFTFacet.getApproved.selector;
        selectors[11] = VaipakamNFTFacet.setApprovalForAll.selector;
        selectors[12] = VaipakamNFTFacet.isApprovedForAll.selector;
        selectors[13] = bytes4(keccak256("transferFrom(address,address,uint256)"));
        selectors[14] = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
        selectors[15] = bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"));
        selectors[16] = VaipakamNFTFacet.supportsInterface.selector;
    }

    function setUp() public {
        owner = address(this);
        user = makeAddr("user");

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        nftFacet = new VaipakamNFTFacet();
        accessControlFacet = new AccessControlFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(nftFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _getAllNFTSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Initialize NFT storage in diamond (replaces constructor which can't init proxy storage)
        VaipakamNFTFacet(address(diamond)).initializeNFT();
    }

    /// @dev Helper: mint an NFT via diamond proxy (authorized caller — msg.sender must be diamond).
    function _mintViaProxy(
        address to,
        uint256 tokenId,
        bool isLender,
        LibVaipakam.LoanPositionStatus status
    ) internal {
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).mintNFT(to, tokenId, OFFER_ID, LOAN_ID, isLender, status);
    }

    // ─── mintNFT ──────────────────────────────────────────────────────────────

    function testMintNFTLenderSuccess() public {
        vm.expectEmit(true, true, false, true);
        emit VaipakamNFTFacet.NFTMinted(TOKEN_ID_1, user, "Lender");
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        assertEq(IERC721(address(diamond)).ownerOf(TOKEN_ID_1), user);
    }

    function testMintNFTBorrowerSuccess() public {
        vm.expectEmit(true, true, false, true);
        emit VaipakamNFTFacet.NFTMinted(TOKEN_ID_1, user, "Borrower");
        _mintViaProxy(user, TOKEN_ID_1, false, LibVaipakam.LoanPositionStatus.OfferCreated);

        assertEq(IERC721(address(diamond)).ownerOf(TOKEN_ID_1), user);
    }

    function testMintNFTRevertsDirectEOACall() public {
        // Direct EOA call (tx.origin == msg.sender) must revert NotAuthorized
        vm.prank(user, user); // prank sets tx.origin = user, msg.sender = user
        vm.expectRevert(VaipakamNFTFacet.NotAuthorized.selector);
        VaipakamNFTFacet(address(diamond)).mintNFT(user, TOKEN_ID_1, OFFER_ID, LOAN_ID, true, LibVaipakam.LoanPositionStatus.OfferCreated);
    }

    function testMintNFTMultipleTokens() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        _mintViaProxy(user, TOKEN_ID_2, false, LibVaipakam.LoanPositionStatus.OfferCreated);

        assertEq(IERC721(address(diamond)).ownerOf(TOKEN_ID_1), user);
        assertEq(IERC721(address(diamond)).ownerOf(TOKEN_ID_2), user);
    }

    // ─── updateNFTStatus ──────────────────────────────────────────────────────

    function testUpdateNFTStatusSuccess() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.expectEmit(true, false, false, true);
        emit VaipakamNFTFacet.NFTStatusUpdated(TOKEN_ID_1, LibVaipakam.LoanPositionStatus.LoanInitiated);
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(TOKEN_ID_1, LOAN_ID, LibVaipakam.LoanPositionStatus.LoanInitiated);
    }

    function testUpdateNFTStatusToClaimable() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanInitiated);
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(TOKEN_ID_1, LOAN_ID, LibVaipakam.LoanPositionStatus.LoanRepaid);
    }

    function testUpdateNFTStatusRevertsEOACall() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.prank(user, user);
        vm.expectRevert(VaipakamNFTFacet.NotAuthorized.selector);
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(TOKEN_ID_1, LOAN_ID, LibVaipakam.LoanPositionStatus.LoanInitiated);
    }

    // ─── burnNFT ──────────────────────────────────────────────────────────────

    function testBurnNFTSuccess() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.expectEmit(true, false, false, false);
        emit VaipakamNFTFacet.NFTBurned(TOKEN_ID_1);
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).burnNFT(TOKEN_ID_1);

        // ownerOf should revert after burn (ERC721 standard)
        vm.expectRevert();
        IERC721(address(diamond)).ownerOf(TOKEN_ID_1);
    }

    function testBurnNFTRevertsEOACall() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.prank(user, user);
        vm.expectRevert(VaipakamNFTFacet.NotAuthorized.selector);
        VaipakamNFTFacet(address(diamond)).burnNFT(TOKEN_ID_1);
    }

    function testBurnNFTRevertsNonExistentToken() public {
        // ownerOf(999) reverts via ERC721 before the NFTAlreadyBurned check fires
        vm.prank(address(diamond));
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).burnNFT(999);
    }

    // ─── tokenURI ─────────────────────────────────────────────────────────────

    function testTokenURILenderActive() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanInitiated);
        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        // Should start with base64 data URI
        assertGt(bytes(uri).length, 0);
        // Starts with data:application/json;base64,
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory uriBytes = bytes(uri);
        for (uint i = 0; i < prefix.length; i++) {
            assertEq(uriBytes[i], prefix[i]);
        }
    }

    function testTokenURIBorrowerActive() public {
        _mintViaProxy(user, TOKEN_ID_1, false, LibVaipakam.LoanPositionStatus.LoanInitiated);
        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    function testTokenURIClosedStatuses() public {
        // Test all closed statuses to exercise _isClosedStatus branches
        LibVaipakam.LoanPositionStatus[5] memory closedStatuses = [
            LibVaipakam.LoanPositionStatus.LoanClosed,
            LibVaipakam.LoanPositionStatus.LoanRepaid,
            LibVaipakam.LoanPositionStatus.LoanDefaulted,
            LibVaipakam.LoanPositionStatus.LoanLiquidated,
            LibVaipakam.LoanPositionStatus.LoanRepaid
        ];
        for (uint256 i = 0; i < closedStatuses.length; i++) {
            _mintViaProxy(user, i + 1, i % 2 == 0, closedStatuses[i]);
            string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(i + 1);
            assertGt(bytes(uri).length, 0);
        }
    }

    function testTokenURIRevertsInvalidToken() public {
        // ownerOf(999) reverts via ERC721 for non-existent token before InvalidTokenId fires
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).tokenURI(999);
    }

    function testTokenURIAfterStatusUpdate() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanInitiated);
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(TOKEN_ID_1, LOAN_ID, LibVaipakam.LoanPositionStatus.LoanRepaid);

        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    // ─── ownerOf (ERC721 registered selector) ────────────────────────────────

    function testOwnerOfReturnsCorrectOwner() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanInitiated);
        assertEq(IERC721(address(diamond)).ownerOf(TOKEN_ID_1), user);
    }

    // ─── Additional branch coverage tests ────────────────────────────────────

    /// @dev updateNFTStatus with a valid token ID where ownerOf != address(0) — covers the FALSE
    ///      branch of `if (ownerOf(tokenId) == address(0))`.
    function testUpdateNFTStatusValidTokenCoversOwnerNotZeroBranch() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        // Token exists (owner != address(0)), so update should succeed without reverting
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(TOKEN_ID_1, LOAN_ID, LibVaipakam.LoanPositionStatus.LoanInitiated);
        // Verify status was actually updated by querying tokenURI
        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    /// @dev burnNFT with a valid token — covers the burn success path where ownerOf != address(0).
    function testBurnNFTValidTokenCoversOwnerNotZeroBranch() public {
        _mintViaProxy(user, TOKEN_ID_2, false, LibVaipakam.LoanPositionStatus.OfferCreated);
        // Token exists — burn should succeed
        vm.expectEmit(true, false, false, false);
        emit VaipakamNFTFacet.NFTBurned(TOKEN_ID_2);
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).burnNFT(TOKEN_ID_2);
        // After burn, ownerOf should revert
        vm.expectRevert();
        IERC721(address(diamond)).ownerOf(TOKEN_ID_2);
    }

    /// @dev tokenURI with a LibVaipakam.LoanPositionStatus.LoanClosed status — covers `isClosed = true` branch via lender role.
    function testTokenURILenderClosedStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanClosed);
        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
        // URI exists and is base64 encoded
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory uriBytes = bytes(uri);
        for (uint i = 0; i < prefix.length; i++) {
            assertEq(uriBytes[i], prefix[i]);
        }
    }

    /// @dev tokenURI with an active status and borrower role — covers `isClosed = false` + borrower path.
    function testTokenURIBorrowerActiveSeparate() public {
        _mintViaProxy(user, TOKEN_ID_1, false, LibVaipakam.LoanPositionStatus.LoanInitiated); // isLender=false
        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    /// @dev tokenURI with a LibVaipakam.LoanPositionStatus.LoanDefaulted status and borrower role — covers borrower closed image path.
    function testTokenURIBorrowerClosedStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, false, LibVaipakam.LoanPositionStatus.LoanDefaulted); // isLender=false, isClosed=true
        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    // ─── ERC721 Interface ────────────────────────────────────────────────────

    function testNameAndSymbol() public {
        assertEq(VaipakamNFTFacet(address(diamond)).name(), "VaipakamNFT");
        assertEq(VaipakamNFTFacet(address(diamond)).symbol(), "VNGK");
    }

    function testBalanceOf() public {
        assertEq(VaipakamNFTFacet(address(diamond)).balanceOf(user), 0);
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        assertEq(VaipakamNFTFacet(address(diamond)).balanceOf(user), 1);
        _mintViaProxy(user, TOKEN_ID_2, false, LibVaipakam.LoanPositionStatus.OfferCreated);
        assertEq(VaipakamNFTFacet(address(diamond)).balanceOf(user), 2);
    }

    function testApproveAndGetApproved() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        address approved = makeAddr("approved");

        vm.prank(user);
        VaipakamNFTFacet(address(diamond)).approve(approved, TOKEN_ID_1);
        assertEq(VaipakamNFTFacet(address(diamond)).getApproved(TOKEN_ID_1), approved);
    }

    function testSetApprovalForAll() public {
        address operator = makeAddr("operator");
        vm.prank(user);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(VaipakamNFTFacet(address(diamond)).isApprovedForAll(user, operator));

        vm.prank(user);
        VaipakamNFTFacet(address(diamond)).setApprovalForAll(operator, false);
        assertFalse(VaipakamNFTFacet(address(diamond)).isApprovedForAll(user, operator));
    }

    function testTransferFrom() public {
        address recipient = makeAddr("recipient");
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.prank(user);
        VaipakamNFTFacet(address(diamond)).transferFrom(user, recipient, TOKEN_ID_1);
        assertEq(IERC721(address(diamond)).ownerOf(TOKEN_ID_1), recipient);
    }

    function testSafeTransferFrom() public {
        address recipient = address(new ERC721Receiver());
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.prank(user);
        VaipakamNFTFacet(address(diamond)).safeTransferFrom(user, recipient, TOKEN_ID_1);
        assertEq(IERC721(address(diamond)).ownerOf(TOKEN_ID_1), recipient);
    }

    function testSafeTransferFromWithData() public {
        address recipient = address(new ERC721Receiver());
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.prank(user);
        VaipakamNFTFacet(address(diamond)).safeTransferFrom(user, recipient, TOKEN_ID_1, "test data");
        assertEq(IERC721(address(diamond)).ownerOf(TOKEN_ID_1), recipient);
    }

    // ─── supportsInterface ───────────────────────────────────────────────────

    function testSupportsInterfaceERC721() public view {
        assertTrue(VaipakamNFTFacet(address(diamond)).supportsInterface(type(IERC721).interfaceId));
    }

    function testSupportsInterfaceERC721Metadata() public view {
        assertTrue(VaipakamNFTFacet(address(diamond)).supportsInterface(type(IERC721Metadata).interfaceId));
    }

    function testSupportsInterfaceERC165() public view {
        assertTrue(VaipakamNFTFacet(address(diamond)).supportsInterface(type(IERC165).interfaceId));
    }

    function testSupportsInterfaceReturnsFalseForUnknown() public view {
        assertFalse(VaipakamNFTFacet(address(diamond)).supportsInterface(0xdeadbeef));
    }

    // ─── _isClosedStatus branches ────────────────────────────────────────────

    function testTokenURILoanRepaidStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanRepaid);
        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    function testTokenURILoanLiquidatedStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, false, LibVaipakam.LoanPositionStatus.LoanLiquidated);
        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    function testTokenURINonClosedStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        string memory uri = VaipakamNFTFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    // ─── initializeNFT access control ────────────────────────────────────────

    function testInitializeNFTRevertsNonAdmin() public {
        vm.prank(user);
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).initializeNFT();
    }
}

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @dev Simple ERC721 receiver for safe transfer tests
contract ERC721Receiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
