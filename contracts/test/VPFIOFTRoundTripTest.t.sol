// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {TestHelperOz5} from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {SendParam} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {MessagingFee} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIOFTAdapter} from "../src/token/VPFIOFTAdapter.sol";
import {VPFIMirror} from "../src/token/VPFIMirror.sol";

/// @title VPFIOFTRoundTripTest
/// @notice End-to-end round trip of VPFI supply across the Phase 1 OFT V2
///         mesh using a LayerZero EndpointV2Mock pair:
///         canonical (Base)  ── lock ──▶ mirror (Polygon-ish)  ── burn ──▶ canonical
/// @dev The canonical token, adapter, and mirror are all deployed behind
///      ERC1967 proxies to match how they will be wired in production. The
///      test contract owns every piece so it can invoke `setPeer` and bridge
///      without extra pranks.
contract VPFIOFTRoundTripTest is TestHelperOz5 {
    using OptionsBuilder for bytes;

    uint32 private constant A_EID = 1; // canonical
    uint32 private constant B_EID = 2; // mirror

    VPFIToken private vpfi;
    VPFIOFTAdapter private adapter;
    VPFIMirror private mirror;

    address private constant INITIAL_MINTER = address(0xBEEF);
    address private userA = address(0xA11CE);
    address private userB = address(0xB0B);

    function setUp() public virtual override {
        vm.deal(userA, 100 ether);
        vm.deal(userB, 100 ether);

        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);

        // ── Deploy canonical VPFI behind an ERC1967Proxy.
        //    Initial mint (23M) lands on address(this) so we can seed userA.
        VPFIToken tokenImpl = new VPFIToken();
        ERC1967Proxy tokenProxy = new ERC1967Proxy(
            address(tokenImpl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), INITIAL_MINTER)
            )
        );
        vpfi = VPFIToken(address(tokenProxy));

        // ── Deploy the canonical-side adapter (proxy).
        VPFIOFTAdapter adapterImpl = new VPFIOFTAdapter(
            address(vpfi),
            address(endpoints[A_EID])
        );
        ERC1967Proxy adapterProxy = new ERC1967Proxy(
            address(adapterImpl),
            abi.encodeCall(VPFIOFTAdapter.initialize, (address(this)))
        );
        adapter = VPFIOFTAdapter(address(adapterProxy));

        // ── Deploy the mirror-side OFT (proxy).
        VPFIMirror mirrorImpl = new VPFIMirror(address(endpoints[B_EID]));
        ERC1967Proxy mirrorProxy = new ERC1967Proxy(
            address(mirrorImpl),
            abi.encodeCall(VPFIMirror.initialize, (address(this)))
        );
        mirror = VPFIMirror(address(mirrorProxy));

        // ── Wire peers both ways so packets can flow.
        address[] memory ofts = new address[](2);
        ofts[0] = address(adapter);
        ofts[1] = address(mirror);
        this.wireOApps(ofts);

        // Seed userA with some VPFI from the initial-mint balance.
        vpfi.transfer(userA, 1_000 ether);
    }

    // ─── Sanity ──────────────────────────────────────────────────────────────

    function testInitialTopology() public view {
        assertEq(vpfi.balanceOf(userA), 1_000 ether);
        assertEq(vpfi.balanceOf(address(adapter)), 0);
        assertEq(mirror.balanceOf(userB), 0);
        assertEq(adapter.token(), address(vpfi));
        assertEq(mirror.token(), address(mirror));
    }

    // ─── Outbound: canonical → mirror ────────────────────────────────────────

    function testBridgeCanonicalToMirrorLocksAndMints() public {
        uint256 amount = 100 ether;
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200000, 0);

        SendParam memory sp = SendParam(
            B_EID,
            addressToBytes32(userB),
            amount,
            amount,
            options,
            "",
            ""
        );
        MessagingFee memory fee = adapter.quoteSend(sp, false);

        vm.prank(userA);
        vpfi.approve(address(adapter), amount);

        vm.prank(userA);
        adapter.send{value: fee.nativeFee}(sp, fee, payable(userA));

        // Adapter now holds the locked canonical VPFI.
        assertEq(vpfi.balanceOf(userA), 900 ether);
        assertEq(vpfi.balanceOf(address(adapter)), amount);

        // Deliver the packet to the mirror endpoint.
        verifyPackets(B_EID, addressToBytes32(address(mirror)));

        // userB now has mirror VPFI; total supplies reflect the lock-set.
        assertEq(mirror.balanceOf(userB), amount);
        assertEq(mirror.totalSupply(), amount);
        assertEq(vpfi.totalSupply(), 23_000_000 ether); // canonical unchanged
    }

    // ─── Inbound: mirror → canonical (closes the round trip) ─────────────────

    function testBridgeMirrorBackToCanonicalBurnsAndUnlocks() public {
        // First send canonical → mirror so userB has something to return.
        testBridgeCanonicalToMirrorLocksAndMints();

        uint256 amount = 40 ether; // partial return
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200000, 0);

        SendParam memory sp = SendParam(
            A_EID,
            addressToBytes32(userA),
            amount,
            amount,
            options,
            "",
            ""
        );
        MessagingFee memory fee = mirror.quoteSend(sp, false);

        vm.prank(userB);
        mirror.send{value: fee.nativeFee}(sp, fee, payable(userB));

        // Mirror burned userB's tokens.
        assertEq(mirror.balanceOf(userB), 100 ether - amount);
        assertEq(mirror.totalSupply(), 100 ether - amount);

        // Deliver the packet to the canonical-side adapter.
        verifyPackets(A_EID, addressToBytes32(address(adapter)));

        // Adapter released `amount` VPFI to userA; lock-set shrank 1:1.
        assertEq(vpfi.balanceOf(userA), 900 ether + amount);
        assertEq(vpfi.balanceOf(address(adapter)), 100 ether - amount);
    }

    // ─── Invariant: locked canonical == total mirror supply ──────────────────

    function testLockSetMatchesMirrorSupplyAfterMultipleHops() public {
        // Two outbound hops of different sizes.
        _bridgeAToB(userA, userB, 100 ether);
        _bridgeAToB(userA, userB, 75 ether);

        assertEq(vpfi.balanceOf(address(adapter)), 175 ether);
        assertEq(mirror.totalSupply(), 175 ether);

        // One inbound hop.
        _bridgeBToA(userB, userA, 50 ether);

        // Invariant holds: every mirror VPFI is backed 1:1 by locked canonical VPFI.
        assertEq(vpfi.balanceOf(address(adapter)), mirror.totalSupply());
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _bridgeAToB(address from, address to, uint256 amount) internal {
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200000, 0);
        SendParam memory sp = SendParam(
            B_EID,
            addressToBytes32(to),
            amount,
            amount,
            options,
            "",
            ""
        );
        MessagingFee memory fee = adapter.quoteSend(sp, false);

        vm.prank(from);
        vpfi.approve(address(adapter), amount);
        vm.prank(from);
        adapter.send{value: fee.nativeFee}(sp, fee, payable(from));
        verifyPackets(B_EID, addressToBytes32(address(mirror)));
    }

    function _bridgeBToA(address from, address to, uint256 amount) internal {
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(200000, 0);
        SendParam memory sp = SendParam(
            A_EID,
            addressToBytes32(to),
            amount,
            amount,
            options,
            "",
            ""
        );
        MessagingFee memory fee = mirror.quoteSend(sp, false);

        vm.prank(from);
        mirror.send{value: fee.nativeFee}(sp, fee, payable(from));
        verifyPackets(A_EID, addressToBytes32(address(adapter)));
    }
}
