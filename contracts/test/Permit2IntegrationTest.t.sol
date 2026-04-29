// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ISignatureTransfer, LibPermit2} from "../src/libraries/LibPermit2.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

/**
 * @title Permit2IntegrationTest
 * @notice Phase 8b.1 — verifies the new `*WithPermit` entry points on
 *         OfferFacet + VPFIDiscountFacet route their asset pulls
 *         through Uniswap's canonical Permit2 address and deliver the
 *         tokens to the expected destination.
 *
 * @dev Uses `vm.etch` to install a mock at the canonical Permit2
 *      address `0x000000000022D473030F116dDEE9F6B43aC78BA3`; the mock
 *      captures the call args and performs a plain `safeTransferFrom`
 *      so downstream assertions (escrow balances, offer state) match
 *      what real Permit2 would produce. Full signature-flow coverage
 *      (EIP-712 digest, nonce burn, deadline revert) belongs in a
 *      separate fork test against real Permit2.
 */
contract Permit2IntegrationTest is SetupTest {
    VPFIDiscountFacet internal vpfiDiscountFacet;
    VPFIToken internal vpfi;
    MockPermit2 internal permit2Mock;
    address internal constant CANONICAL_PERMIT2 =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function setUp() public {
        setupHelper();

        // Install the MockPermit2 bytecode at the canonical address so
        // `LibPermit2.pull` routes here.
        permit2Mock = new MockPermit2();
        vm.etch(CANONICAL_PERMIT2, address(permit2Mock).code);

        // Wire VPFIDiscountFacet onto the diamond so the VPFI permit
        // test can reach `depositVPFIToEscrowWithPermit`.
        vpfiDiscountFacet = new VPFIDiscountFacet();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(vpfiDiscountFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getVPFIDiscountFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // Deploy + register VPFI.
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        // Fund the test users for the pulls below.
        vpfi.transfer(lender, 10_000 ether);
        vpfi.transfer(borrower, 10_000 ether);
        ERC20Mock(mockERC20).mint(lender, 10_000 ether);
        ERC20Mock(mockERC20).mint(borrower, 10_000 ether);
        ERC20Mock(mockCollateralERC20).mint(lender, 10_000 ether);
        ERC20Mock(mockCollateralERC20).mint(borrower, 10_000 ether);

        // In the real flow users approve Permit2 once; the mock honours
        // the approval when transferring owner→to.
        vm.prank(lender);
        IERC20(mockERC20).approve(CANONICAL_PERMIT2, type(uint256).max);
        vm.prank(lender);
        IERC20(mockCollateralERC20).approve(CANONICAL_PERMIT2, type(uint256).max);
        vm.prank(borrower);
        IERC20(mockERC20).approve(CANONICAL_PERMIT2, type(uint256).max);
        vm.prank(borrower);
        IERC20(mockCollateralERC20).approve(CANONICAL_PERMIT2, type(uint256).max);
        vm.prank(borrower);
        IERC20(address(vpfi)).approve(CANONICAL_PERMIT2, type(uint256).max);
    }

    // ─── depositVPFIToEscrowWithPermit ───────────────────────────────────────

    function testDepositVPFIToEscrowWithPermitRoutesThroughPermit2() public {
        uint256 amount = 500 ether;
        ISignatureTransfer.PermitTransferFrom memory permit =
            _buildPermit(address(vpfi), amount);

        uint256 borrowerBalBefore = vpfi.balanceOf(borrower);
        address escrow = EscrowFactoryFacet(address(diamond))
            .getOrCreateUserEscrow(borrower);
        uint256 escrowBalBefore = vpfi.balanceOf(escrow);

        vm.prank(borrower);
        VPFIDiscountFacet(address(diamond)).depositVPFIToEscrowWithPermit(
            amount,
            permit,
            "" // mock skips signature verification
        );

        // Token moved wallet → escrow via Permit2.
        assertEq(
            vpfi.balanceOf(borrower),
            borrowerBalBefore - amount,
            "borrower VPFI debited"
        );
        assertEq(
            vpfi.balanceOf(escrow),
            escrowBalBefore + amount,
            "escrow VPFI credited"
        );

        // Mock recorded exactly one Permit2 call with the right args.
        MockPermit2 m = MockPermit2(CANONICAL_PERMIT2);
        assertEq(m.callCount(), 1, "permit2 called once");
        assertEq(m.lastOwner(), borrower, "owner = borrower");
    }

    // ─── createOfferWithPermit (Lender ERC20 offer) ──────────────────────────

    function testCreateOfferWithPermitPullsPrincipalViaPermit2() public {
        uint256 principal = 10_000 ether;
        ISignatureTransfer.PermitTransferFrom memory permit =
            _buildPermit(mockERC20, principal);

        address lenderEscrow = EscrowFactoryFacet(address(diamond))
            .getOrCreateUserEscrow(lender);
        uint256 escrowBalBefore = IERC20(mockERC20).balanceOf(lenderEscrow);

        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOfferWithPermit(
            _lenderERC20OfferParams(principal),
            permit,
            ""
        );

        assertGt(offerId, 0, "offer created");
        assertEq(
            IERC20(mockERC20).balanceOf(lenderEscrow),
            escrowBalBefore + principal,
            "lender escrow credited principal"
        );
        assertEq(MockPermit2(CANONICAL_PERMIT2).callCount(), 1);
    }

    // ─── acceptOfferWithPermit (borrower pulling ERC20 collateral) ──────────

    function testAcceptOfferWithPermitPullsCollateralViaPermit2() public {
        // First create a classic lender offer (no Permit2 here — the
        // lender funded the offer via the normal approve+create flow).
        uint256 principal = 10_000 ether;
        ERC20Mock(mockERC20).mint(lender, principal);
        vm.prank(lender);
        IERC20(mockERC20).approve(address(diamond), principal);
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            _lenderERC20OfferParams(principal)
        );

        // Now accept via Permit2 — borrower signs a permit for their
        // collateral amount and submits the signature with the accept.
        ISignatureTransfer.PermitTransferFrom memory permit =
            _buildPermit(mockCollateralERC20, principal);

        address borrowerEscrow = EscrowFactoryFacet(address(diamond))
            .getOrCreateUserEscrow(borrower);
        uint256 collateralBalBefore = IERC20(mockCollateralERC20).balanceOf(
            borrowerEscrow
        );

        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOfferWithPermit(
            offerId,
            /*acceptorFallbackConsent=*/ true,
            permit,
            ""
        );

        // Borrower's collateral pulled via Permit2 into their escrow.
        assertEq(
            IERC20(mockCollateralERC20).balanceOf(borrowerEscrow) -
                collateralBalBefore,
            principal,
            "collateral routed to borrower escrow"
        );
        // Two Permit2 calls total would mean both collateral + prepay
        // fired; ERC20 loans don't prepay, so expect exactly one.
        assertEq(MockPermit2(CANONICAL_PERMIT2).callCount(), 1);
    }

    // ─── Permit2TokenMismatch — defends against permits signed for ──────────
    // ─── the wrong ERC-20 (frontend bug or hostile frontend) ────────────────

    function testDepositVPFIWithPermitRevertsOnWrongToken() public {
        // Permit signed for the WRONG asset (mockERC20, not VPFI). Without
        // the LibPermit2 token-binding check, Permit2 would faithfully
        // pull mockERC20 while {_prepareDeposit} re-stamps the VPFI
        // accumulator — a real correctness bug. Now reverts cleanly.
        ISignatureTransfer.PermitTransferFrom memory wrongPermit =
            _buildPermit(mockERC20, 500 ether);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.Permit2TokenMismatch.selector,
                address(vpfi),
                mockERC20
            )
        );
        VPFIDiscountFacet(address(diamond)).depositVPFIToEscrowWithPermit(
            500 ether,
            wrongPermit,
            ""
        );
    }

    function testCreateOfferWithPermitRevertsOnWrongToken() public {
        // Lender ERC-20 offer expects the principal asset (mockERC20);
        // permit signed for mockCollateralERC20 must revert.
        uint256 principal = 1_000 ether;
        ISignatureTransfer.PermitTransferFrom memory wrongPermit =
            _buildPermit(mockCollateralERC20, principal);

        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.Permit2TokenMismatch.selector,
                mockERC20,
                mockCollateralERC20
            )
        );
        OfferFacet(address(diamond)).createOfferWithPermit(
            _lenderERC20OfferParams(principal),
            wrongPermit,
            ""
        );
    }

    function testAcceptOfferWithPermitRevertsOnWrongCollateralToken() public {
        // Set up a lender ERC-20 offer with the classic flow.
        uint256 principal = 1_000 ether;
        ERC20Mock(mockERC20).mint(lender, principal);
        vm.prank(lender);
        IERC20(mockERC20).approve(address(diamond), principal);
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            _lenderERC20OfferParams(principal)
        );

        // Borrower signs a permit for the WRONG asset (the principal
        // token rather than the collateral). The accept path expects
        // the collateral and must reject the mismatched permit.
        ISignatureTransfer.PermitTransferFrom memory wrongPermit =
            _buildPermit(mockERC20, principal);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.Permit2TokenMismatch.selector,
                mockCollateralERC20,
                mockERC20
            )
        );
        OfferFacet(address(diamond)).acceptOfferWithPermit(
            offerId,
            /*acceptorFallbackConsent=*/ true,
            wrongPermit,
            ""
        );
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _buildPermit(address token, uint256 amount)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory)
    {
        return
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: token,
                    amount: amount
                }),
                nonce: uint256(uint160(address(this))) + block.timestamp,
                deadline: block.timestamp + 1800
            });
    }

    function _lenderERC20OfferParams(uint256 principal)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: principal,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: principal,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0
            });
    }
}
