// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";

/// @title VPFITokenFacetTest
/// @notice Exercises the Phase 2 VPFITokenFacet — registration and the
///         transparency view surface — through the Diamond proxy.
contract VPFITokenFacetTest is SetupTest {
    VPFIToken internal token;
    address internal constant TOKEN_OWNER = address(0xA11CE);
    address internal constant INITIAL_RECIPIENT = address(0xCAFE);
    address internal constant INITIAL_MINTER = address(0xBEEF);

    event VPFITokenSet(address indexed previousToken, address indexed newToken);

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (TOKEN_OWNER, INITIAL_RECIPIENT, INITIAL_MINTER)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        token = VPFIToken(address(proxy));
    }

    function _facet() internal view returns (VPFITokenFacet) {
        return VPFITokenFacet(address(diamond));
    }

    function _enableCanonical() internal {
        _facet().setCanonicalVPFIChain(true);
    }

    // ─── setVPFIToken access control ─────────────────────────────────────────

    function testSetVPFITokenRequiresAdminRole() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        _facet().setVPFIToken(address(token));
    }

    function testSetVPFITokenRevertsOnZero() public {
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        _facet().setVPFIToken(address(0));
    }

    function testSetVPFITokenEmitsAndUpdates() public {
        vm.expectEmit(true, true, false, false, address(diamond));
        emit VPFITokenSet(address(0), address(token));
        _facet().setVPFIToken(address(token));
        assertEq(_facet().getVPFIToken(), address(token));
    }

    function testSetVPFITokenRotationEmitsPreviousAddress() public {
        _facet().setVPFIToken(address(token));

        VPFIToken impl2 = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (TOKEN_OWNER, INITIAL_RECIPIENT, INITIAL_MINTER)
        );
        ERC1967Proxy proxy2 = new ERC1967Proxy(address(impl2), initData);

        vm.expectEmit(true, true, false, false, address(diamond));
        emit VPFITokenSet(address(token), address(proxy2));
        _facet().setVPFIToken(address(proxy2));
        assertEq(_facet().getVPFIToken(), address(proxy2));
    }

    // ─── Views before registration ───────────────────────────────────────────

    function testViewsReturnZeroWhenUnregistered() public view {
        assertEq(_facet().getVPFIToken(), address(0));
        assertEq(_facet().getVPFITotalSupply(), 0);
        assertEq(_facet().getVPFICap(), 0);
        assertEq(_facet().getVPFICapHeadroom(), 0);
        assertEq(_facet().getVPFIMinter(), address(0));
        assertEq(_facet().getVPFIBalanceOf(INITIAL_RECIPIENT), 0);
    }

    // ─── Views after registration ────────────────────────────────────────────

    function testTotalSupplyReflectsInitialMint() public {
        _facet().setVPFIToken(address(token));
        assertEq(_facet().getVPFITotalSupply(), 23_000_000 ether);
    }

    function testCapAndHeadroom() public {
        _facet().setVPFIToken(address(token));
        _enableCanonical();
        assertEq(_facet().getVPFICap(), 230_000_000 ether);
        assertEq(
            _facet().getVPFICapHeadroom(),
            230_000_000 ether - 23_000_000 ether
        );
    }

    function testMinterView() public {
        _facet().setVPFIToken(address(token));
        _enableCanonical();
        assertEq(_facet().getVPFIMinter(), INITIAL_MINTER);
    }

    function testBalanceOfView() public {
        _facet().setVPFIToken(address(token));
        assertEq(
            _facet().getVPFIBalanceOf(INITIAL_RECIPIENT),
            23_000_000 ether
        );
        assertEq(_facet().getVPFIBalanceOf(address(0xDEAD)), 0);
    }

    // ─── Views reflect post-mint state ───────────────────────────────────────

    function testHeadroomAndSupplyTrackMintAndBurn() public {
        _facet().setVPFIToken(address(token));
        _enableCanonical();

        vm.prank(INITIAL_MINTER);
        token.mint(address(0xD00D), 100 ether);
        assertEq(_facet().getVPFITotalSupply(), 23_000_000 ether + 100 ether);
        assertEq(
            _facet().getVPFICapHeadroom(),
            230_000_000 ether - 23_000_000 ether - 100 ether
        );

        vm.prank(INITIAL_RECIPIENT);
        token.burn(50 ether);
        assertEq(_facet().getVPFITotalSupply(), 23_000_000 ether + 100 ether - 50 ether);
        assertEq(
            _facet().getVPFICapHeadroom(),
            230_000_000 ether - 23_000_000 ether - 100 ether + 50 ether
        );
    }

    // ─── ADMIN_ROLE is granted to owner in SetupTest ─────────────────────────

    function testAdminHoldsAdminRole() public view {
        assertTrue(
            AccessControlFacet(address(diamond)).hasRole(
                LibAccessControl.ADMIN_ROLE,
                owner
            )
        );
    }
}
