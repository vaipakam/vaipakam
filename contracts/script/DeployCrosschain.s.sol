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
 *         Mirror only:
 *           - `VPFIMirrorToken`         — UUPS proxy (the mirror VPFI ERC20)
 *
 *         Required env:
 *           - DEPLOYER_PRIVATE_KEY  : the deploying EOA
 *           - ADMIN_ADDRESS         : owner of every deployed proxy
 *           - CCIP_ROUTER           : this chain's CCIP Router
 *           - CCIP_RMN_PROXY        : this chain's RMN proxy (token-pool ctor)
 *         Mirror chains also need:
 *           - BASE_CHAIN_ID         : EVM chain id of canonical Base
 *           - TREASURY_ADDRESS      : local treasury for the buy adapter
 *         Optional:
 *           - VPFI_BUY_PAYMENT_TOKEN  : 0 = native (default), else bridged WETH
 *           - VPFI_BUY_REFUND_TIMEOUT : seconds (default 900 = 15 min)
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

        // ── Record to deployments/<chain>/addresses.json ─────────────────
        Deployments.writeCcipMessenger(messenger);
        Deployments.writeVpfiTokenPool(pool);
        Deployments.writeVpfiPoolRateGovernor(rateGovernor);
        Deployments.writeRewardMessenger(rewardMessenger);
        if (canonical) {
            Deployments.writeBuybackRemittanceReceiver(buybackReceiver);
            Deployments.writeBuybackRemittanceReceiverImpl(buybackReceiverImpl);
        } else {
            Deployments.writeVpfiMirror(vpfiToken);
        }

        console.log("");
        console.log("Crosschain deploy complete.");
        console.log("Next: ConfigureCcip.s.sol (lanes, channels, peers, rate limits).");
    }
}
