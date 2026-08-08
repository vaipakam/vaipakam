// script/DeployCrosschain.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
// The CCIP token pools declare these types from the CCIP-vendored
// OpenZeppelin 4.8.3 set / the chainlink-evm shared interfaces — not the
// protocol's OZ-5 `IERC20` — so import them from the same paths the pool
// contracts use, or the constructor args won't type-match.
import {IERC20} from "@openzeppelin/contracts@4.8.3/token/ERC20/IERC20.sol";
import {IBurnMintERC20} from "@chainlink/contracts/src/v0.8/shared/token/ERC20/IBurnMintERC20.sol";
import {LockReleaseTokenPool} from "@chainlink/contracts-ccip/contracts/pools/LockReleaseTokenPool.sol";
import {BurnMintTokenPool} from "@chainlink/contracts-ccip/contracts/pools/BurnMintTokenPool.sol";

import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {VPFIMirrorToken} from "../src/crosschain/VPFIMirrorToken.sol";
import {VpfiPoolRateGovernor} from "../src/crosschain/VpfiPoolRateGovernor.sol";
// T-087 Sub 3.A — Base-side inbound handler for the buyback channel.
import {BuybackRemittanceReceiver} from "../src/crosschain/BuybackRemittanceReceiver.sol";
// #776 — mirror-side inbound handler for the reward-budget channel.
import {RewardRemittanceReceiver} from "../src/crosschain/RewardRemittanceReceiver.sol";
// #1568 C2 — the shared vpfi-return channel: sender/escrow on mirrors,
// kind-dispatching receiver on Base.
import {VpfiReturnSender} from "../src/crosschain/VpfiReturnSender.sol";
import {VpfiReturnReceiver} from "../src/crosschain/VpfiReturnReceiver.sol";
import {VaipakamRewardMessenger} from "../src/crosschain/VaipakamRewardMessenger.sol";
import {Deployments} from "./lib/Deployments.sol";

/// @dev The slice of OZ/Chainlink `Ownable2Step` this script drives — the
///      CCIP `TokenPool` is `Ownable2Step`, so a fresh pool is owned by
///      the deploying EOA and ownership moves in two steps.
interface IOwnable2Step {
    function transferOwnership(address newOwner) external;
}

/**
 * @title DeployCrosschain
 * @notice T-068 Phase 6 — deploys the Chainlink CCIP cross-chain stack on
 *         ONE chain. Run once per chain (canonical Base + every mirror).
 *         The lane / channel / pool-rate / TokenAdminRegistry wiring is a
 *         separate step — see `ConfigureCcip.s.sol`.
 *
 * @dev    Canonical (Base) vs mirror is decided by `block.chainid`:
 *         8453 / 84532 are canonical; every other chain is a mirror.
 *
 *         Deploys, EVERY chain:
 *           - `CcipMessenger`           — UUPS proxy; the one CCIP-aware adapter
 *           - the VPFI CCIP `TokenPool` — Lock/Release on Base, Burn/Mint on mirrors
 *           - `VpfiPoolRateGovernor`    — UUPS proxy; the pool `rateLimitAdmin`
 *           - `VaipakamRewardMessenger` — UUPS proxy
 *         Canonical (Base) only:
 *           - `BuybackRemittanceReceiver` — UUPS proxy; Base-side buyback
 *             remittance inbound handler
 *           - `VpfiReturnReceiver`      — UUPS proxy; Base-side inbound
 *             handler of the shared vpfi-return channel (#1568 C2)
 *         Mirror only:
 *           - `VPFIMirrorToken`         — UUPS proxy (the mirror VPFI ERC20)
 *           - `RewardRemittanceReceiver` — UUPS proxy; mirror-side reward-budget
 *             inbound handler
 *           - `VpfiReturnSender`        — UUPS proxy; mirror-side sender/escrow
 *             of the shared vpfi-return channel (#1568 C2)
 *
 *         (#687-A removed the cross-chain VPFI fixed-rate buy
 *         (`VpfiBuyReceiver`/`VpfiBuyAdapter`) from this script.)
 *
 *         Required env:
 *           - DEPLOYER_PRIVATE_KEY  : the deploying EOA
 *           - ADMIN_ADDRESS         : owner of every deployed proxy
 *           - CCIP_ROUTER           : this chain's CCIP Router
 *           - CCIP_RMN_PROXY        : this chain's RMN proxy (token-pool ctor)
 *         Mirror chains also need:
 *           - BASE_CHAIN_ID         : EVM chain id of canonical Base
 *         Optional:
 *           - CCIP_DEST_GAS_LIMIT     : cross-chain callback gas (default 400000)
 *
 *         The Diamond + canonical `VPFIToken` are read from the per-chain
 *         deployments artifact written by `DeployDiamond.s.sol`.
 *
 *         Usage:
 *           forge script script/DeployCrosschain.s.sol \
 *             --rpc-url $RPC_URL --broadcast -vvv
 */
contract DeployCrosschain is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address router = vm.envAddress("CCIP_ROUTER");
        address rmnProxy = vm.envAddress("CCIP_RMN_PROXY");
        uint256 destGasLimit = vm.envOr("CCIP_DEST_GAS_LIMIT", uint256(400_000));
        address diamond = Deployments.readDiamond();

        bool canonical = block.chainid == 8453 || block.chainid == 84532;
        // Canonical Base stores `baseChainId = 0` (it is its own base);
        // mirrors carry the canonical chain's EVM id.
        uint256 baseChainId = canonical ? 0 : vm.envUint("BASE_CHAIN_ID");

        console.log("=== T-068 Phase 6 - CCIP cross-chain deploy ===");
        console.log("Chain id:   ", block.chainid);
        console.log("Canonical:  ", canonical);
        console.log("Admin:      ", admin);
        console.log("Diamond:    ", diamond);
        console.log("CCIP router:", router);
        console.log("RMN proxy:  ", rmnProxy);

        vm.startBroadcast(deployerKey);

        // ── CcipMessenger — every chain. Router is immutable on the impl. ──
        CcipMessenger messengerImpl = new CcipMessenger(router);
        address messenger = address(
            new ERC1967Proxy(
                address(messengerImpl),
                abi.encodeCall(CcipMessenger.initialize, (admin))
            )
        );
        console.log("CcipMessenger:          ", messenger);

        // ── VPFI token + its CCIP TokenPool ──────────────────────────────
        // Base: a Lock/Release pool over the existing canonical VPFIToken.
        // Mirror: a fresh mirror VPFI ERC20 + a Burn/Mint pool over it.
        // Empty allowlist => permissionless pool.
        address vpfiToken;
        address pool;
        if (canonical) {
            vpfiToken = Deployments.readVpfiToken();
            pool = address(
                new LockReleaseTokenPool(
                    IERC20(vpfiToken), 18, new address[](0), rmnProxy, router
                )
            );
            console.log("LockReleaseTokenPool:   ", pool);
        } else {
            VPFIMirrorToken mirrorImpl = new VPFIMirrorToken();
            vpfiToken = address(
                new ERC1967Proxy(
                    address(mirrorImpl),
                    abi.encodeCall(VPFIMirrorToken.initialize, (admin))
                )
            );
            console.log("VPFIMirrorToken:        ", vpfiToken);
            pool = address(
                new BurnMintTokenPool(
                    IBurnMintERC20(vpfiToken), 18, new address[](0), rmnProxy, router
                )
            );
            console.log("BurnMintTokenPool:      ", pool);
        }

        // Hand the pool to `admin` so it joins every other cross-chain
        // contract under one owner. `TokenPool` is `Ownable2Step`: this
        // sets `admin` as the *pending* owner; `ConfigureCcip.s.sol`
        // (admin-broadcast) completes the handover with `acceptOwnership()`
        // before it wires lanes or the `rateLimitAdmin`.
        IOwnable2Step(pool).transferOwnership(admin);

        // ── VpfiPoolRateGovernor — every chain. Needs the pool address. ──
        VpfiPoolRateGovernor govImpl = new VpfiPoolRateGovernor();
        address rateGovernor = address(
            new ERC1967Proxy(
                address(govImpl),
                abi.encodeCall(VpfiPoolRateGovernor.initialize, (admin, pool))
            )
        );
        console.log("VpfiPoolRateGovernor:   ", rateGovernor);

        // ── VaipakamRewardMessenger — every chain. ───────────────────────
        VaipakamRewardMessenger rewardImpl = new VaipakamRewardMessenger();
        address rewardMessenger = address(
            new ERC1967Proxy(
                address(rewardImpl),
                abi.encodeCall(
                    VaipakamRewardMessenger.initialize,
                    (admin, messenger, diamond, canonical, baseChainId, destGasLimit)
                )
            )
        );
        console.log("VaipakamRewardMessenger:", rewardMessenger);

        // #687-A: the cross-chain VPFI fixed-rate buy (VpfiBuyReceiver on the
        // canonical chain / VpfiBuyAdapter on mirrors) was removed alongside
        // the on-chain issuer sale. Mirror chains still record `vpfiMirror`;
        // the canonical chain still deploys the buyback-remittance receiver.

        vm.stopBroadcast();

        // ── T-087 Sub 3.A — Base-side buyback remittance receiver ──────
        address buybackReceiverImpl;
        address buybackReceiver;
        if (canonical) {
            vm.startBroadcast(deployerKey);
            BuybackRemittanceReceiver brImpl = new BuybackRemittanceReceiver();
            buybackReceiverImpl = address(brImpl);
            buybackReceiver = address(
                new ERC1967Proxy(
                    buybackReceiverImpl,
                    abi.encodeCall(
                        BuybackRemittanceReceiver.initialize,
                        (admin, messenger, diamond)
                    )
                )
            );
            vm.stopBroadcast();
            console.log("BuybackRemittanceReceiver:", buybackReceiver);
        }

        // ── #776 — mirror-side reward-budget remittance receiver ───────
        // Mirrors RECEIVE the Base→mirror reward-budget CCIP token message and
        // forward the VPFI into the local Diamond. Base is the SENDER (its
        // Diamond is the reward-budget channel handler), so it needs no
        // receiver here; the canonical branch skips this.
        address rewardReceiverImpl;
        address rewardReceiver;
        if (!canonical) {
            vm.startBroadcast(deployerKey);
            RewardRemittanceReceiver rrImpl = new RewardRemittanceReceiver();
            rewardReceiverImpl = address(rrImpl);
            rewardReceiver = address(
                new ERC1967Proxy(
                    rewardReceiverImpl,
                    abi.encodeCall(
                        RewardRemittanceReceiver.initialize,
                        (admin, messenger, diamond, vpfiToken)
                    )
                )
            );
            vm.stopBroadcast();
            console.log("RewardRemittanceReceiver: ", rewardReceiver);
        }

        // ── #1568 C2 — the shared vpfi-return channel satellites ───────
        // The channel is cut once and shared by both repatriation modes
        // (per-mode payload kinds discriminate); each mirror gets the
        // sender/escrow, Base gets the kind-dispatching receiver. Neither
        // Diamond can be the handler — each is already bound to another
        // channel (`channelOf` is one-to-one).
        address returnSenderImpl;
        address returnSender;
        address returnReceiverImpl;
        address returnReceiver;
        if (canonical) {
            vm.startBroadcast(deployerKey);
            VpfiReturnReceiver vrImpl = new VpfiReturnReceiver();
            returnReceiverImpl = address(vrImpl);
            returnReceiver = address(
                new ERC1967Proxy(
                    returnReceiverImpl,
                    abi.encodeCall(
                        VpfiReturnReceiver.initialize,
                        (admin, messenger, diamond)
                    )
                )
            );
            vm.stopBroadcast();
            console.log("VpfiReturnReceiver:       ", returnReceiver);
        } else {
            vm.startBroadcast(deployerKey);
            VpfiReturnSender vsImpl = new VpfiReturnSender();
            returnSenderImpl = address(vsImpl);
            returnSender = address(
                new ERC1967Proxy(
                    returnSenderImpl,
                    abi.encodeCall(
                        VpfiReturnSender.initialize,
                        (admin, messenger, diamond, vpfiToken, destGasLimit)
                    )
                )
            );
            vm.stopBroadcast();
            console.log("VpfiReturnSender:         ", returnSender);
        }

        // ── Record to deployments/<chain>/addresses.json ─────────────────
        Deployments.writeCcipMessenger(messenger);
        Deployments.writeVpfiTokenPool(pool);
        Deployments.writeVpfiPoolRateGovernor(rateGovernor);
        Deployments.writeRewardMessenger(rewardMessenger);
        if (canonical) {
            Deployments.writeBuybackRemittanceReceiver(buybackReceiver);
            Deployments.writeBuybackRemittanceReceiverImpl(buybackReceiverImpl);
            Deployments.writeVpfiReturnReceiver(returnReceiver);
            Deployments.writeVpfiReturnReceiverImpl(returnReceiverImpl);
        } else {
            Deployments.writeVpfiMirror(vpfiToken);
            Deployments.writeRewardRemittanceReceiver(rewardReceiver);
            Deployments.writeRewardRemittanceReceiverImpl(rewardReceiverImpl);
            Deployments.writeVpfiReturnSender(returnSender);
            Deployments.writeVpfiReturnSenderImpl(returnSenderImpl);
        }

        console.log("");
        console.log("Crosschain deploy complete.");
        console.log("Next: ConfigureCcip.s.sol (lanes, channels, peers, rate limits).");
    }
}
