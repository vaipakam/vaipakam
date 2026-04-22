// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

interface IOAppSetPeer {
    function setPeer(uint32 _eid, bytes32 _peer) external;
}

/**
 * @title WireVPFIPeers
 * @notice Sets one remote peer on any Vaipakam OApp from the owner wallet.
 *         Works for both the VPFI OFT mesh (adapter ↔ mirror) AND the
 *         fixed-rate buy mesh (VPFIBuyAdapter ↔ VPFIBuyReceiver). Run
 *         once per (local-chain, remote-chain) pair during Phase 1
 *         rollout. Must be executed by the OApp owner (timelock / multisig).
 *
 * @dev Required env vars:
 *        - PRIVATE_KEY   : owner key (broadcaster — must match
 *                          adapter/mirror/receiver owner)
 *        - LOCAL_OAPP    : OApp proxy address on this chain
 *                          (VPFI adapter/mirror OR VPFIBuyAdapter/Receiver)
 *        - REMOTE_EID    : LayerZero endpoint id of the remote chain
 *        - REMOTE_PEER   : OApp proxy address on the remote chain
 *                          (right-padded into bytes32 — this script
 *                          does the cast)
 *
 *      Usage examples:
 *
 *      OFT mesh (Base Sepolia → Polygon Amoy mirror):
 *        LOCAL_OAPP=0xAdapter REMOTE_EID=40267 REMOTE_PEER=0xAmoyMirror \
 *          forge script script/WireVPFIPeers.s.sol --rpc-url base_sepolia --broadcast
 *
 *      Buy mesh (Sepolia adapter → Base Sepolia receiver):
 *        LOCAL_OAPP=0xSepoliaBuyAdapter REMOTE_EID=40245 \
 *        REMOTE_PEER=0xBaseSepoliaBuyReceiver \
 *          forge script script/WireVPFIPeers.s.sol --rpc-url sepolia --broadcast
 *
 *      Wiring is symmetric — the counterpart transaction must also be sent
 *      on the remote chain with LOCAL_OAPP swapped for REMOTE_PEER and vice
 *      versa; otherwise packets from this chain arrive but the response
 *      path is blocked.
 */
contract WireVPFIPeers is Script {
    function run() external {
        uint256 ownerKey = vm.envUint("PRIVATE_KEY");
        address localOApp = vm.envAddress("LOCAL_OAPP");
        uint32 remoteEid = uint32(vm.envUint("REMOTE_EID"));
        address remotePeer = vm.envAddress("REMOTE_PEER");

        console.log("=== Wire VPFI OFT Peer ===");
        console.log("Local OApp: ", localOApp);
        console.log("Remote eid: ", remoteEid);
        console.log("Remote peer:", remotePeer);

        vm.startBroadcast(ownerKey);
        IOAppSetPeer(localOApp).setPeer(remoteEid, _toBytes32(remotePeer));
        vm.stopBroadcast();

        console.log("Peer set. Remember to wire the reverse direction on the remote chain.");
    }

    function _toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
