// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {DeployDiamond} from "../DeployDiamond.s.sol";
import {DeployTestnetMocks} from "../DeployTestnetMocks.s.sol";
import {WETH9} from "@chainlink/contracts/src/v0.8/vendor/canonical-weth/WETH9.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";

/**
 * @title  DeployE2EFixture
 * @notice The connected app's e2e chain (#2334): the CURRENT contracts,
 *         deployed from source onto a bare local Anvil, with the faucet and
 *         oracle mocks the specs trade against.
 *
 * @dev    WHY FROM SOURCE. The fork tier used to fork live Base Sepolia, so
 *         every run tested whatever bytecode and state the testnet held at
 *         that block — not the contracts in the PR, and not a fixed state.
 *         A spec could fail on live state that moved between two runs of one
 *         commit (#2334: `createLoanSaleOffer` reverted on one fork and
 *         passed on the rerun), and a contract change could not be seen by
 *         the suite at all until an operator redeployed the testnet.
 *
 *         WHAT THE HARNESS DOES AROUND THIS SCRIPT (`apps/app/e2e/lib/
 *         fixture.ts`), because a script cannot do it itself:
 *           1. before it: etches the three contracts the app expects at
 *              canonical addresses — WETH9 at Base's `0x4200…0006`,
 *              Multicall3 at `0xcA11…CA11`, Permit2 at `0x0000…78BA3`. This
 *              script REQUIRES them, pinning Multicall3 and Permit2 by code
 *              hash and WETH9 by the bytecode compiled here, so installing
 *              the wrong thing fails here rather than as a confusing spec
 *              failure.
 *           2. after it: switches the chain id to Base Sepolia's (84532),
 *              so the app's per-chain wiring applies unchanged, and writes
 *              an e2e-only deployments bundle whose 84532 entry is this
 *              artifact.
 *
 *         Deployed on Anvil's own id (31337) because that is the only chain
 *         `Deployments` lets a script redirect its artifact on: this one
 *         writes to `deployments/.forge-test/e2e/`, never to the committed
 *         `deployments/anvil/` or `deployments/base-sepolia/` files. Every
 *         contract here reads `block.chainid` at call time rather than
 *         caching it, so the later switch is seen by each EIP-712 domain.
 *
 *         Admin and deployer are different keys, as on every real
 *         deployment: `runWith` hands the roles to the admin, and the mocks'
 *         wiring is broadcast by that admin.
 *
 *         Env: `DEPLOYER_PRIVATE_KEY`, `ADMIN_PRIVATE_KEY`,
 *         `TREASURY_ADDRESS`. The harness passes Anvil's well-known dev keys.
 */
contract DeployE2EFixture is DeployDiamond, DeployTestnetMocks {
    /// @notice Base's WETH predeploy — the address the app curates as WETH.
    address internal constant CANONICAL_WETH = 0x4200000000000000000000000000000000000006;
    /// @notice The address viem's chain objects read Multicall3 from.
    address internal constant CANONICAL_MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    /// @notice Uniswap's Permit2, which the app's permit path signs for.
    address internal constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Code hashes of the committed canonical runtimes
    ///         (`Multicall3.runtime.hex`, `Permit2.runtime.hex`); see the
    ///         README beside this script for where each was read from.
    bytes32 internal constant MULTICALL3_CODEHASH =
        0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891;
    bytes32 internal constant PERMIT2_CODEHASH =
        0xdcde65555316946c298e4c60c6213eb5c3aeab4354d1f3fac5427236bcbb9ebe;

    /// @notice Where the fixture's artifact goes — the scratch root
    ///         `Deployments` permits a redirect to, and gitignored.
    string internal constant E2E_ARTIFACT_ROOT = "deployments/.forge-test/e2e";

    function run() external override(DeployDiamond, DeployTestnetMocks) {
        require(
            block.chainid == 31337,
            "DeployE2EFixture: run on a bare Anvil (31337); the harness switches the id afterwards"
        );
        require(
            keccak256(CANONICAL_WETH.code) == keccak256(type(WETH9).runtimeCode),
            "DeployE2EFixture: WETH9 is not etched at 0x4200...0006"
        );
        require(
            CANONICAL_MULTICALL3.codehash == MULTICALL3_CODEHASH,
            "DeployE2EFixture: the canonical Multicall3 is not installed at 0xcA11...CA11"
        );
        require(
            CANONICAL_PERMIT2.codehash == PERMIT2_CODEHASH,
            "DeployE2EFixture: the canonical Permit2 is not installed at its address"
        );

        setArtifactRootOverride(E2E_ARTIFACT_ROOT);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        runWith(vm.addr(adminKey), vm.envAddress("TREASURY_ADDRESS"), deployerKey);
        _deployTestnetMocks(deployerKey, adminKey, diamond, CANONICAL_WETH);

        // THE LIVE TESTNET'S POSTURE, where a spec depends on it. Each line
        // names the flag, what the testnet holds, and why the suite needs it.
        vm.startBroadcast(adminKey);
        // Base Sepolia holds `true`. A lender completing a borrower's posted
        // refinance request is gated by this switch today, although the switch
        // is documented as keeper-only — #2349. Until that is decided,
        // spec 29 needs it on, as the testnet has it.
        AdminFacet(diamond).setAutoRefinanceEnabled(true);
        vm.stopBroadcast();
    }
}
