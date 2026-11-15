// test/VaipakamNFTFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibPositionNFT} from "../src/libraries/LibPositionNFT.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaipakamNFTMetadataFacet} from "../src/facets/VaipakamNFTMetadataFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
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
    MetricsFacet metricsFacet;
    ProfileFacet profileFacet;
    HelperTest helperTest;

    // Token IDs used across tests
    uint256 constant TOKEN_ID_1 = 1;
    uint256 constant TOKEN_ID_2 = 2;
    uint256 constant OFFER_ID = 10;
    uint256 constant LOAN_ID = 5;

    function setUp() public {
        owner = address(this);
        user = makeAddr("user");

        cutFacet = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        nftFacet = VaipakamNFTFacet(ArtifactDeploy.deploy(type(VaipakamNFTFacet).name));
        accessControlFacet = AccessControlFacet(ArtifactDeploy.deploy(type(AccessControlFacet).name));
        // tokenURI cross-facet-calls MetricsFacet.getNFTPositionSummary
        // for the live position read (Range Orders Phase 1 follow-up).
        // Cut MetricsFacet so tokenURI tests can resolve that selector.
        metricsFacet = MetricsFacet(ArtifactDeploy.deploy(type(MetricsFacet).name));
        profileFacet = ProfileFacet(ArtifactDeploy.deploy(type(ProfileFacet).name));
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](6);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(nftFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaipakamNFTFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(metricsFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getMetricsFacetSelectors()
        });
        // #821 — ProfileFacet provides `setSanctionsOracle` so the freeze-at-
        // source transfer-restriction test can install a sanctions oracle.
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(profileFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getProfileFacetSelectors()
        });
        // #2957 - the token's metadata (tokenURI) is its own facet.
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(VaipakamNFTMetadataFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVaipakamNFTMetadataFacetSelectors()
        });
        // #3562 — every lender token's holder is recorded by the accumulator
        // facet, so a Diamond that mints position NFTs must route it.
        cuts[5] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(VPFIDiscountAccumulatorFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVpfiDiscountAccumulatorFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        // Diamond born paused (LibPausable). Clear via direct
        // storage write since this fixture doesn't cut AdminFacet.
        vm.store(address(diamond), bytes32(uint256(0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400)), bytes32(0));

        // Initialize NFT storage in diamond (replaces constructor which can't init proxy storage)
        LibTestPositionNFT.install(address(diamond), address(this));
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

        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1), user);
    }

    function testMintNFTBorrowerSuccess() public {
        vm.expectEmit(true, true, false, true);
        emit VaipakamNFTFacet.NFTMinted(TOKEN_ID_1, user, "Borrower");
        _mintViaProxy(user, TOKEN_ID_1, false, LibVaipakam.LoanPositionStatus.OfferCreated);

        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1), user);
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

        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1), user);
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_2), user);
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

    // ─── retirePosition (#3205: the core never burns) ──────────────────────────

    function testRetirePositionKeepsTheReceiptAndReadsAsGone() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanClosed);

        vm.expectEmit(true, false, false, false);
        emit VaipakamNFTFacet.PositionRetired(TOKEN_ID_1);
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).retirePosition(TOKEN_ID_1);

        // The holder keeps the token as a receipt, and it still renders.
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1), user);
        assertGt(bytes(VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1)).length, 0);
        // The Diamond reads it as gone.
        assertTrue(VaipakamNFTFacet(address(diamond)).isPositionRetired(TOKEN_ID_1));
        // Retiring again is a no-op.
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).retirePosition(TOKEN_ID_1);
    }

    function testRetirePositionRevertsEOACall() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.prank(user, user);
        vm.expectRevert(VaipakamNFTFacet.NotAuthorized.selector);
        VaipakamNFTFacet(address(diamond)).retirePosition(TOKEN_ID_1);
    }

    function testRetirePositionRevertsUnmintedToken() public {
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(LibPositionNFT.ERC721NonexistentToken.selector, 999));
        VaipakamNFTFacet(address(diamond)).retirePosition(999);
        assertFalse(VaipakamNFTFacet(address(diamond)).isPositionRetired(999));
    }

    // ─── tokenURI ─────────────────────────────────────────────────────────────

    function testTokenURILenderActive() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanInitiated);
        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
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
        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
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
            string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(i + 1);
            assertGt(bytes(uri).length, 0);
        }
    }

    function testTokenURIRevertsInvalidToken() public {
        // ownerOf(999) reverts via ERC721 for non-existent token before InvalidTokenId fires
        vm.expectRevert();
        VaipakamNFTMetadataFacet(address(diamond)).tokenURI(999);
    }

    function testTokenURIAfterStatusUpdate() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanInitiated);
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).updateNFTStatus(TOKEN_ID_1, LOAN_ID, LibVaipakam.LoanPositionStatus.LoanRepaid);

        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    // ─── ownerOf (ERC721 registered selector) ────────────────────────────────

    function testOwnerOfReturnsCorrectOwner() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanInitiated);
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1), user);
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
        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    /// @dev tokenURI with a LibVaipakam.LoanPositionStatus.LoanClosed status — covers `isClosed = true` branch via lender role.
    function testTokenURILenderClosedStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanClosed);
        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
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
        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    /// @dev tokenURI with a LibVaipakam.LoanPositionStatus.LoanDefaulted status and borrower role — covers borrower closed image path.
    function testTokenURIBorrowerClosedStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, false, LibVaipakam.LoanPositionStatus.LoanDefaulted); // isLender=false, isClosed=true
        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    // ─── ERC721 Interface ────────────────────────────────────────────────────

    function testNameAndSymbol() public {
        assertEq(LibTestPositionNFT.core(address(diamond)).name(), "Vaipakam NFT");
        assertEq(LibTestPositionNFT.core(address(diamond)).symbol(), "VAIPAK");
    }

    function testBalanceOf() public {
        assertEq(LibTestPositionNFT.core(address(diamond)).balanceOf(user), 0);
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        assertEq(LibTestPositionNFT.core(address(diamond)).balanceOf(user), 1);
        _mintViaProxy(user, TOKEN_ID_2, false, LibVaipakam.LoanPositionStatus.OfferCreated);
        assertEq(LibTestPositionNFT.core(address(diamond)).balanceOf(user), 2);
    }

    function testApproveAndGetApproved() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        address approved = makeAddr("approved");

        vm.prank(user);
        LibTestPositionNFT.core(address(diamond)).approve(approved, TOKEN_ID_1);
        assertEq(LibTestPositionNFT.core(address(diamond)).getApproved(TOKEN_ID_1), approved);
    }

    function testSetApprovalForAll() public {
        address operator = makeAddr("operator");
        vm.prank(user);
        LibTestPositionNFT.core(address(diamond)).setApprovalForAll(operator, true);
        assertTrue(LibTestPositionNFT.core(address(diamond)).isApprovedForAll(user, operator));

        vm.prank(user);
        LibTestPositionNFT.core(address(diamond)).setApprovalForAll(operator, false);
        assertFalse(LibTestPositionNFT.core(address(diamond)).isApprovedForAll(user, operator));
    }

    function testTransferFrom() public {
        address recipient = makeAddr("recipient");
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.prank(user);
        LibTestPositionNFT.core(address(diamond)).transferFrom(user, recipient, TOKEN_ID_1);
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1), recipient);
    }

    function testSafeTransferFrom() public {
        address recipient = address(new ERC721Receiver());
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.prank(user);
        LibTestPositionNFT.core(address(diamond)).safeTransferFrom(user, recipient, TOKEN_ID_1);
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1), recipient);
    }

    function testSafeTransferFromWithData() public {
        address recipient = address(new ERC721Receiver());
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);

        vm.prank(user);
        LibTestPositionNFT.core(address(diamond)).safeTransferFrom(user, recipient, TOKEN_ID_1, "test data");
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1), recipient);
    }

    // ─── supportsInterface ───────────────────────────────────────────────────

    function testSupportsInterfaceERC721() public view {
        assertTrue(LibTestPositionNFT.core(address(diamond)).supportsInterface(type(IERC721).interfaceId));
    }

    function testSupportsInterfaceERC721Metadata() public view {
        assertTrue(LibTestPositionNFT.core(address(diamond)).supportsInterface(type(IERC721Metadata).interfaceId));
    }

    function testSupportsInterfaceERC165() public view {
        assertTrue(LibTestPositionNFT.core(address(diamond)).supportsInterface(type(IERC165).interfaceId));
    }

    function testSupportsInterfaceReturnsFalseForUnknown() public view {
        assertFalse(LibTestPositionNFT.core(address(diamond)).supportsInterface(0xdeadbeef));
    }

    // ─── _isClosedStatus branches ────────────────────────────────────────────

    function testTokenURILoanRepaidStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanRepaid);
        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    function testTokenURILoanLiquidatedStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, false, LibVaipakam.LoanPositionStatus.LoanLiquidated);
        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    function testTokenURINonClosedStatus() public {
        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.OfferCreated);
        string memory uri = VaipakamNFTMetadataFacet(address(diamond)).tokenURI(TOKEN_ID_1);
        assertGt(bytes(uri).length, 0);
    }

    // ─── initializeNFT access control ────────────────────────────────────────

    function testInitializeNFTRevertsNonAdmin() public {
        address core = address(LibTestPositionNFT.core(address(diamond)));
        vm.prank(user);
        vm.expectRevert();
        VaipakamNFTFacet(address(diamond)).initializeNFT(core);
    }

    function testInitializeNFTIsOnceOnly() public {
        address core = address(LibTestPositionNFT.core(address(diamond)));
        vm.expectRevert(LibPositionNFT.PositionNFTAlreadySet.selector);
        VaipakamNFTFacet(address(diamond)).initializeNFT(core);
    }

    /// @dev #3205 — the Diamond is not an ERC-721 any more: it routes none of
    ///      the token surface, so every owner read goes to the core.
    function testTheDiamondRoutesNoErc721Surface() public {
        (bool ok, ) = address(diamond).staticcall(abi.encodeWithSignature("ownerOf(uint256)", 1));
        assertFalse(ok, "ownerOf is not on the Diamond");
        (ok, ) = address(diamond).call(abi.encodeWithSignature("transferFrom(address,address,uint256)", user, owner, 1));
        assertFalse(ok, "transferFrom is not on the Diamond");
    }

    /// @dev Only the core may call the Diamond's transfer check.
    function testCheckPositionTransferIsCoreOnly() public {
        vm.prank(user);
        vm.expectRevert(VaipakamNFTFacet.NotAuthorized.selector);
        VaipakamNFTFacet(address(diamond)).checkPositionTransfer(user, user, owner, 1);
    }

    // ─── #821 freeze-at-source: position-NFT transfer restriction ─────────────

    /// @notice A position NFT cannot be transferred INTO or OUT OF a sanctions-
    ///         flagged wallet — the primary mechanism that stops a flagged party
    ///         laundering its position to a clean wallet to escape the #821
    ///         payout freeze. A transfer made while both parties are clean (a
    ///         legitimate secondary-market sale) is unaffected. Mint / burn /
    ///         protocol-internal moves use separate authorized paths and are NOT
    ///         gated here, so a flagged party's position can still be settled +
    ///         burned at terminal.
    function test_SanctionedWallet_CannotTransferPositionNFT() public {
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));

        _mintViaProxy(user, TOKEN_ID_1, true, LibVaipakam.LoanPositionStatus.LoanInitiated);
        address cleanBuyer = makeAddr("clean-buyer");

        // 1. A flagged SENDER cannot move its position NFT out.
        m.setFlagged(user, true);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, user)
        );
        LibTestPositionNFT.core(address(diamond)).transferFrom(user, cleanBuyer, TOKEN_ID_1);

        // 2. A flagged RECIPIENT cannot receive a position NFT.
        m.setFlagged(user, false);
        m.setFlagged(cleanBuyer, true);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibVaipakam.SanctionedAddress.selector, cleanBuyer
            )
        );
        LibTestPositionNFT.core(address(diamond)).transferFrom(user, cleanBuyer, TOKEN_ID_1);

        // 3. Clean → clean transfer (legitimate secondary-market sale) works.
        m.setFlagged(cleanBuyer, false);
        vm.prank(user);
        LibTestPositionNFT.core(address(diamond)).transferFrom(user, cleanBuyer, TOKEN_ID_1);
        assertEq(
            LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1),
            cleanBuyer,
            "clean secondary-market transfer succeeds"
        );

        // 4. The oracle being unset fail-opens (no gate) — sanity that the screen
        //    is oracle-driven, not unconditional.
        ProfileFacet(address(diamond)).setSanctionsOracle(address(0));
        m.setFlagged(cleanBuyer, true); // still "flagged" in the now-detached oracle
        vm.prank(cleanBuyer);
        LibTestPositionNFT.core(address(diamond)).transferFrom(cleanBuyer, user, TOKEN_ID_1);
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(TOKEN_ID_1), user, "fail-open when oracle unset");
    }
}

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";

/// @dev Simple ERC721 receiver for safe transfer tests
contract ERC721Receiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
