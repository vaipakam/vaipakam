// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployTestnetVPFI
 * @notice Enables the VPFI fee-discount surface on a TESTNET Diamond so
 *         the alpha02 `/vpfi` page (tiers, discounts) and the borrower
 *         LIF-rebate path can be reviewed end-to-end. Mirrors
 *         `DeployTestnetMocks` in spirit: an operator-run, reproducible
 *         one-shot that wires + funds dormant machinery.
 *
 *         On a fresh testnet deploy `getVPFIToken()` returns
 *         `address(0)` — VPFI is deployed as a token but NOT registered
 *         in the Diamond, so every discount/tier read is zero and the
 *         `/vpfi` page correctly shows "not available on this chain".
 *         This script:
 *
 *           1. (admin) `setVPFIToken(deployments.vpfiToken)` — registers
 *              VPFI so `getVPFIToken()` is non-zero and the discount
 *              machinery activates. Tier thresholds (100 / 1,000 / 5,000
 *              / 20,000 VPFI) and tier BPS (10 / 15 / 20 / 24 %) already
 *              have on-chain defaults — no tier config needed.
 *           2. (admin) `setVPFIDiscountETHPriceAsset(weth)` +
 *              `setVPFIDiscountRate(rate)` — the ETH-price reference and
 *              the wei-per-VPFI rate the borrower LIF-rebate quote uses.
 *              WETH must be oracle-priced (it is, via the oracle mocks).
 *           3. (VPFI source) transfer VPFI from the holder (the treasury
 *              holds the full initial supply on testnet) to up to four
 *              recipient wallets so they can deposit VPFI and climb tiers.
 *
 * @dev   Supported testnets only (84532 / 421614 / 97 / 11155111 /
 *        11155420 / 31337). NEVER a mainnet slug.
 *
 *        Required env:
 *          - ADMIN_PRIVATE_KEY         : holds ADMIN_ROLE on the Diamond.
 *          - VPFI_SOURCE_PRIVATE_KEY   : key of the wallet HOLDING VPFI
 *                                        (the treasury on a fresh testnet
 *                                        deploy). Used only for step 3.
 *        Optional env:
 *          - VPFI_DISCOUNT_RATE        : wei-per-VPFI for the rebate quote
 *                                        (default 1e12 — symbolic, testnet).
 *          - VPFI_RECIPIENT_1..4       : addresses to fund (each optional).
 *          - VPFI_AMOUNT_EACH          : whole VPFI per recipient
 *                                        (default 25000 → top tier).
 *          - BASE_SEPOLIA_WETH / …     : WETH override (else canonical).
 *
 *        Idempotent: setVPFIToken no-ops on an unchanged write; the
 *        discount setters are straight assigns; transfers just top up.
 */
contract DeployTestnetVPFI is Script {
    address constant BASE_WETH_DEFAULT = 0x4200000000000000000000000000000000000006;
    address constant SEPOLIA_WETH_DEFAULT = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    // NOTE: no BNB Testnet default on purpose — WBNB is not WETH; see _wethFor.
    address constant ARB_SEPOLIA_WETH_DEFAULT = 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73;
    address constant OP_SEPOLIA_WETH_DEFAULT = 0x4200000000000000000000000000000000000006;

    function run() external {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || cid == 11155111 || cid == 97 || cid == 421614 || cid == 11155420 || cid == 31337,
            "DeployTestnetVPFI: chain not supported"
        );

        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        address vpfi = Deployments.readAddressForChain(cid, ".vpfiToken");
        require(vpfi != address(0), "DeployTestnetVPFI: deployments.vpfiToken missing");
        address weth = _wethFor(cid);
        uint256 rate = vm.envOr("VPFI_DISCOUNT_RATE", uint256(1e12));

        console.log("=== Enable Testnet VPFI ===");
        console.log("Chain id: ", cid);
        console.log("Diamond:  ", diamond);
        console.log("VPFI:     ", vpfi);
        console.log("WETH:     ", weth);
        console.log("Admin:    ", vm.addr(adminKey));

        // ── Step 1+2: admin wiring ─────────────────────────────────────
        vm.startBroadcast(adminKey);
        VPFITokenFacet(diamond).setVPFIToken(vpfi);
        VPFIDiscountFacet(diamond).setVPFIDiscountETHPriceAsset(weth);
        VPFIDiscountFacet(diamond).setVPFIDiscountRate(rate);
        vm.stopBroadcast();
        console.log("Registered VPFI + set discount rate", rate, "eth-asset WETH.");

        // ── Step 3: distribute VPFI from the holder ───────────────────
        uint256 amountEach = vm.envOr("VPFI_AMOUNT_EACH", uint256(25000)) * 1e18;
        address[4] memory recips = [
            vm.envOr("VPFI_RECIPIENT_1", address(0)),
            vm.envOr("VPFI_RECIPIENT_2", address(0)),
            vm.envOr("VPFI_RECIPIENT_3", address(0)),
            vm.envOr("VPFI_RECIPIENT_4", address(0))
        ];
        bool anyRecip;
        for (uint256 i; i < 4; ++i) {
            if (recips[i] != address(0)) anyRecip = true;
        }
        if (anyRecip) {
            uint256 sourceKey = vm.envUint("VPFI_SOURCE_PRIVATE_KEY");
            address source = vm.addr(sourceKey);
            console.log("VPFI source (holder):", source, "balance:", IERC20(vpfi).balanceOf(source) / 1e18);
            vm.startBroadcast(sourceKey);
            for (uint256 i; i < 4; ++i) {
                if (recips[i] == address(0)) continue;
                if (IERC20(vpfi).balanceOf(recips[i]) >= amountEach) {
                    console.log("  already funded:", recips[i]);
                    continue;
                }
                IERC20(vpfi).transfer(recips[i], amountEach);
                console.log("  sent VPFI to:", recips[i]);
            }
            vm.stopBroadcast();
        } else {
            console.log("No VPFI_RECIPIENT_* set -- skipped distribution (wiring only).");
        }

        console.log("");
        console.log("VPFI enabled. Verify: cast call <diamond> 'getVPFIToken()(address)'");
        console.log("Recipients can now deposit VPFI in /vpfi to climb tiers");
        console.log("(100/1,000/5,000/20,000 VPFI => 10/15/20/24% fee discount).");
    }

    function _wethFor(uint256 cid) private view returns (address) {
        if (cid == 84532) return vm.envOr("BASE_SEPOLIA_WETH", BASE_WETH_DEFAULT);
        if (cid == 11155111) return vm.envOr("SEPOLIA_WETH", SEPOLIA_WETH_DEFAULT);
        // BNB Testnet: WBNB is NOT WETH — the discount math prices the
        // ETH-reference asset via the ETH/USD feed, so defaulting to
        // WBNB would misprice it. REQUIRE the same explicit bridged/
        // mock WETH address DeployTestnetMocks uses.
        if (cid == 97) return vm.envAddress("BNB_TESTNET_WETH");
        if (cid == 421614) return vm.envOr("ARB_SEPOLIA_WETH", ARB_SEPOLIA_WETH_DEFAULT);
        if (cid == 11155420) return vm.envOr("OP_SEPOLIA_WETH", OP_SEPOLIA_WETH_DEFAULT);
        return vm.envOr("ANVIL_WETH", address(0));
    }
}
