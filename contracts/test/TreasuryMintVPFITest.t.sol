// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {IVPFIToken} from "../src/interfaces/IVPFIToken.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title TreasuryMintVPFITest
/// @notice Exercises the ADMIN_ROLE-gated `mintVPFI` primitive on
///         TreasuryFacet: access control, guard conditions, the
///         "Diamond-not-minter" bubble-up, happy path, and cap
///         enforcement that is delegated to the token.
contract TreasuryMintVPFITest is SetupTest {
    VPFIToken internal token;
    address internal constant TOKEN_OWNER = address(0xA11CE);
    address internal constant INITIAL_RECIPIENT = address(0xCAFE);
    address internal constant INITIAL_MINTER = address(0xBEEF);

    event VPFIMinted(address indexed to, uint256 amount);

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (TOKEN_OWNER, INITIAL_RECIPIENT, INITIAL_MINTER)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        token = VPFIToken(address(proxy));

        // Tests assume this Diamond is canonical; the dedicated
        // testMintVPFIRevertsWhenNotCanonical flips it off to exercise
        // the gate.
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
    }

    function _treasury() internal view returns (TreasuryFacet) {
        return TreasuryFacet(address(diamond));
    }

    function _facet() internal view returns (VPFITokenFacet) {
        return VPFITokenFacet(address(diamond));
    }

    function _registerToken() internal {
        _facet().setVPFIToken(address(token));
    }

    function _enableCanonical() internal {
        _facet().setCanonicalVPFIChain(true);
    }

    function _makeDiamondMinter() internal {
        vm.prank(TOKEN_OWNER);
        token.setMinter(address(diamond));
    }

    // ─── Access control ──────────────────────────────────────────────────────

    function testMintVPFIRequiresAdminRole() public {
        _registerToken();
        _makeDiamondMinter();

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        _treasury().mintVPFI(address(0xD00D), 100 ether);
    }

    // ─── Guard conditions ────────────────────────────────────────────────────

    function testMintVPFIRevertsOnZeroTo() public {
        _registerToken();
        _makeDiamondMinter();

        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        _treasury().mintVPFI(address(0), 100 ether);
    }

    function testMintVPFIRevertsOnZeroAmount() public {
        _registerToken();
        _makeDiamondMinter();

        vm.expectRevert(TreasuryFacet.ZeroAmount.selector);
        _treasury().mintVPFI(address(0xD00D), 0);
    }

    function testMintVPFIRevertsWhenTokenUnregistered() public {
        // Don't call _registerToken() — Diamond doesn't know the token.
        vm.expectRevert(TreasuryFacet.VPFITokenNotRegistered.selector);
        _treasury().mintVPFI(address(0xD00D), 100 ether);
    }

    function testMintVPFIBubblesNotMinterWhenDiamondIsNotMinter() public {
        _registerToken();
        // Intentionally skip setMinter(diamond): VPFIToken still has
        // INITIAL_MINTER as its minter, so the inner mint call reverts
        // with NotMinter and the Diamond bubbles it up.
        vm.expectRevert(IVPFIToken.NotMinter.selector);
        _treasury().mintVPFI(address(0xD00D), 100 ether);
    }

    // ─── Happy path ──────────────────────────────────────────────────────────

    function testMintVPFIHappyPathMintsAndEmits() public {
        _registerToken();
        _makeDiamondMinter();

        address recipient = address(0xD00D);
        uint256 amount = 1_000 ether;

        uint256 supplyBefore = token.totalSupply();
        uint256 recipientBefore = token.balanceOf(recipient);

        vm.expectEmit(true, false, false, true, address(diamond));
        emit VPFIMinted(recipient, amount);
        _treasury().mintVPFI(recipient, amount);

        assertEq(token.balanceOf(recipient), recipientBefore + amount);
        assertEq(token.totalSupply(), supplyBefore + amount);

        // Views through VPFITokenFacet stay consistent.
        assertEq(_facet().getVPFITotalSupply(), supplyBefore + amount);
        assertEq(_facet().getVPFIBalanceOf(recipient), recipientBefore + amount);
    }

    function testMintVPFIAccumulatesAcrossCalls() public {
        _registerToken();
        _makeDiamondMinter();

        address a = address(0xA);
        address b = address(0xB);

        _treasury().mintVPFI(a, 100 ether);
        _treasury().mintVPFI(b, 250 ether);
        _treasury().mintVPFI(a, 50 ether);

        assertEq(token.balanceOf(a), 150 ether);
        assertEq(token.balanceOf(b), 250 ether);
        assertEq(
            _facet().getVPFITotalSupply(),
            23_000_000 ether + 400 ether
        );
    }

    // ─── Cap enforcement (delegated to token) ────────────────────────────────

    function testMintVPFIExceedingCapRevertsFromToken() public {
        _registerToken();
        _makeDiamondMinter();

        uint256 headroom = token.TOTAL_SUPPLY_CAP() - token.totalSupply();

        // Calling one wei past headroom should revert from ERC20Capped.
        vm.expectRevert();
        _treasury().mintVPFI(address(0xD00D), headroom + 1);
    }

    function testMintVPFIUpToCapSucceeds() public {
        _registerToken();
        _makeDiamondMinter();

        uint256 headroom = token.TOTAL_SUPPLY_CAP() - token.totalSupply();
        _treasury().mintVPFI(address(0xD00D), headroom);

        assertEq(token.totalSupply(), token.TOTAL_SUPPLY_CAP());
        assertEq(_facet().getVPFICapHeadroom(), 0);
    }

    // ─── Minter rotation invalidates Diamond mint path ───────────────────────

    function testMintVPFIRevertsAfterMinterRotatedAway() public {
        _registerToken();
        _makeDiamondMinter();

        // First mint succeeds.
        _treasury().mintVPFI(address(0xD00D), 1 ether);

        // Owner rotates the minter away from the diamond.
        address newMinter = makeAddr("newMinter");
        vm.prank(TOKEN_OWNER);
        token.setMinter(newMinter);

        // Diamond call now bubbles NotMinter from the token.
        vm.expectRevert(IVPFIToken.NotMinter.selector);
        _treasury().mintVPFI(address(0xD00D), 1 ether);
    }

    // ─── Canonical-chain gate ────────────────────────────────────────────────

    function testMintVPFIRevertsWhenNotCanonical() public {
        _registerToken();
        _makeDiamondMinter();

        // Flip the canonical flag off; this Diamond is now a mirror.
        _facet().setCanonicalVPFIChain(false);

        vm.expectRevert(IVaipakamErrors.NotCanonicalVPFIChain.selector);
        _treasury().mintVPFI(address(0xD00D), 1 ether);
    }

    function testCanonicalFlagViewMatchesSetter() public {
        assertTrue(_facet().isCanonicalVPFIChain());
        _facet().setCanonicalVPFIChain(false);
        assertFalse(_facet().isCanonicalVPFIChain());
        _facet().setCanonicalVPFIChain(true);
        assertTrue(_facet().isCanonicalVPFIChain());
    }

    function testCapViewsReturnZeroOnMirror() public {
        _registerToken();
        _facet().setCanonicalVPFIChain(false);

        assertEq(_facet().getVPFICap(), 0);
        assertEq(_facet().getVPFICapHeadroom(), 0);
        assertEq(_facet().getVPFIMinter(), address(0));

        // Supply/balance views remain real on mirror chains.
        assertEq(_facet().getVPFITotalSupply(), token.totalSupply());
    }
}
