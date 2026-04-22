// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import {ConfigureLZConfig} from "../script/ConfigureLZConfig.s.sol";

/**
 * @title LZConfigTest
 * @notice Policy-conformance tests for the post-Kelp LayerZero hardening
 *         config applied by {ConfigureLZConfig.s.sol}. Two modes:
 *
 *         1. **Shape test (always on)**: the `_policyForChain` builder
 *            in the script must produce a UlnConfig with 3 required DVNs
 *            + 2 optional + threshold 1, with DVN arrays sorted
 *            ascending, for every supported Phase-1 chain. Confirmation
 *            counts must match the table pinned in `contracts/README.md`.
 *            This runs in CI and fails the build on drift.
 *
 *         2. **DVN-populated test (env-gated)**: set
 *            `LZ_CONFIG_VERIFY_DVNS=1` to additionally assert that the
 *            DVN placeholder constants in the script have been replaced
 *            with real non-zero addresses (i.e. the security team has
 *            pinned the operator set). The mainnet-deploy runbook MUST
 *            gate on this variant passing before broadcasting the config
 *            script.
 *
 * @dev This test does NOT attempt to read from a live endpoint — that
 *      verification step is a fork-mode smoke run described in the
 *      runbook. What this file protects against is the policy BUILDER
 *      drifting from the documented shape (confirmations, DVN cardinality,
 *      sort order) without a corresponding doc update.
 */
contract LZConfigTest is Test, ConfigureLZConfig {
    // Mirror the chain-id ↔ expected-confirmations table documented in
    // contracts/README.md's Cross-Chain Security section. Tests iterate
    // this list so adding a chain to the script requires adding the
    // corresponding row here (a compile-time-like coupling, test-time).
    struct ChainExpectation {
        uint256 chainId;
        uint64 expectedConfirmations;
    }

    function _chainTable() internal pure returns (ChainExpectation[] memory t) {
        t = new ChainExpectation[](12);
        t[0] = ChainExpectation(1, 15); // Ethereum Mainnet
        t[1] = ChainExpectation(11155111, 15); // Sepolia
        t[2] = ChainExpectation(8453, 10); // Base
        t[3] = ChainExpectation(84532, 10); // Base Sepolia
        t[4] = ChainExpectation(10, 10); // Optimism
        t[5] = ChainExpectation(11155420, 10); // Optimism Sepolia
        t[6] = ChainExpectation(42161, 10); // Arbitrum One
        t[7] = ChainExpectation(421614, 10); // Arbitrum Sepolia
        t[8] = ChainExpectation(1101, 20); // Polygon zkEVM
        t[9] = ChainExpectation(2442, 20); // Polygon zkEVM Cardona
        t[10] = ChainExpectation(56, 15); // BNB Chain
        t[11] = ChainExpectation(97, 15); // BNB Testnet
    }

    // ─── Shape tests (always on) ────────────────────────────────────────────

    function test_policyShape_requiredOptionalCardinality() public pure {
        ChainExpectation[] memory table = _chainTable();
        for (uint256 i = 0; i < table.length; ++i) {
            UlnConfig memory cfg = _policyForChain(table[i].chainId);
            assertEq(cfg.requiredDVNCount, 3, "3 required DVNs");
            assertEq(cfg.optionalDVNCount, 2, "2 optional DVNs");
            assertEq(cfg.optionalDVNThreshold, 1, "threshold 1");
            assertEq(cfg.requiredDVNs.length, 3, "required array length");
            assertEq(cfg.optionalDVNs.length, 2, "optional array length");
        }
    }

    function test_policyShape_confirmationsMatchTable() public pure {
        ChainExpectation[] memory table = _chainTable();
        for (uint256 i = 0; i < table.length; ++i) {
            UlnConfig memory cfg = _policyForChain(table[i].chainId);
            assertEq(
                cfg.confirmations,
                table[i].expectedConfirmations,
                "confirmations match per-chain table"
            );
        }
    }

    function test_policyShape_dvnArraysMonotonic() public pure {
        // Monotonic (<=) ordering is the builder's output even when DVN
        // placeholders are still all-zero. Strict distinctness is an
        // additional property asserted in
        // `test_dvnsPopulatedForMainnetDeploy` when the pre-mainnet env
        // gate is flipped on.
        ChainExpectation[] memory table = _chainTable();
        for (uint256 i = 0; i < table.length; ++i) {
            UlnConfig memory cfg = _policyForChain(table[i].chainId);
            _assertMonotonicAscending(cfg.requiredDVNs, "required DVNs monotonic");
            _assertMonotonicAscending(cfg.optionalDVNs, "optional DVNs monotonic");
        }
    }

    function test_policyShape_rejectsUnknownChain() public {
        vm.expectRevert(bytes("ConfigureLZConfig: unknown chainId"));
        this.externalPolicyForChain(999999);
    }

    /// @dev Public wrapper so `vm.expectRevert` can target the pure getter.
    ///      Solidity 0.8 otherwise rejects `this._policyForChain(x)` because
    ///      the internal qualifier makes the method unreachable via `this`.
    function externalPolicyForChain(uint256 chainId_) external pure returns (UlnConfig memory) {
        return _policyForChain(chainId_);
    }

    // ─── DVN-populated test (env-gated pre-mainnet gate) ────────────────────

    function test_dvnsPopulatedForMainnetDeploy() public view {
        bool gate = vm.envOr("LZ_CONFIG_VERIFY_DVNS", uint256(0)) != 0;
        if (!gate) {
            // Default CI path: skip silently. Pre-mainnet runbook flips the
            // env flag and the assertion below blocks deploy if the DVN
            // placeholders haven't been replaced with pinned operator
            // addresses.
            return;
        }
        assertTrue(DVN_LAYERZERO_LABS != address(0), "DVN_LAYERZERO_LABS still placeholder");
        assertTrue(DVN_GOOGLE_CLOUD != address(0), "DVN_GOOGLE_CLOUD still placeholder");
        assertTrue(DVN_POLYHEDRA != address(0), "DVN_POLYHEDRA still placeholder");
        assertTrue(DVN_BWARE_LABS != address(0), "DVN_BWARE_LABS still placeholder");
        assertTrue(DVN_STARGATE_LABS != address(0), "DVN_STARGATE_LABS still placeholder");

        // No duplicates across the 5 operators — diversification is the
        // whole point of the 3R+2O config.
        address[] memory all = new address[](5);
        all[0] = DVN_LAYERZERO_LABS;
        all[1] = DVN_GOOGLE_CLOUD;
        all[2] = DVN_POLYHEDRA;
        all[3] = DVN_BWARE_LABS;
        all[4] = DVN_STARGATE_LABS;
        for (uint256 i = 0; i < all.length; ++i) {
            for (uint256 j = i + 1; j < all.length; ++j) {
                assertTrue(
                    all[i] != all[j],
                    "DVN operator addresses must be distinct"
                );
            }
        }

        // Strict-ascending sort within each group — UlnBase.setConfig
        // rejects duplicates and unsorted arrays. Post-sort by the script
        // builder must produce strictly ascending output for real
        // addresses.
        ChainExpectation[] memory table = _chainTable();
        for (uint256 i = 0; i < table.length; ++i) {
            UlnConfig memory cfg = _policyForChain(table[i].chainId);
            _assertStrictlyAscending(cfg.requiredDVNs, "required DVNs strictly ascending");
            _assertStrictlyAscending(cfg.optionalDVNs, "optional DVNs strictly ascending");
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function _assertMonotonicAscending(address[] memory arr, string memory msg_) internal pure {
        for (uint256 i = 1; i < arr.length; ++i) {
            assertTrue(uint160(arr[i - 1]) <= uint160(arr[i]), msg_);
        }
    }

    function _assertStrictlyAscending(address[] memory arr, string memory msg_) internal pure {
        for (uint256 i = 1; i < arr.length; ++i) {
            assertTrue(uint160(arr[i - 1]) < uint160(arr[i]), msg_);
        }
    }
}
