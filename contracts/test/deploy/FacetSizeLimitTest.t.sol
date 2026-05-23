// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DiamondFacetNames} from "./DiamondFacetNames.sol";

/**
 * @title FacetSizeLimitTest
 * @notice Issue #66 guardrail — asserts every Diamond facet's runtime
 *         bytecode stays under the EIP-170 24,576-byte contract-size
 *         limit.
 * @dev    A facet over the limit cannot be deployed on anvil or any
 *         real chain — `forge script DeployDiamond --broadcast` reverts.
 *         `forge test` does NOT enforce the EIP-170 *deploy-size* rule,
 *         so without this guardrail an over-size facet stays invisible
 *         until an actual `--broadcast` deploy fails. That is exactly
 *         how RiskFacet's 541-byte breach reached `main` unnoticed
 *         (Issue #66). This test makes the breach fail in the regular
 *         `forge test` run instead.
 *
 *         The runtime bytecode is read with `vm.getDeployedCode` — no
 *         deployment, so the EIP-170 limit is not what's being measured
 *         by the EVM here; the test measures the artifact directly.
 *
 *         The facet set comes from the shared `DiamondFacetNames` list
 *         (the `test/deploy/` deploy-sanity suite's single source of
 *         truth) — when a facet is added to the Diamond, update
 *         `cutFacetNames()` there and this guardrail picks it up.
 */
contract FacetSizeLimitTest is Test, DiamondFacetNames {
    /// @dev EIP-170 maximum runtime contract size, in bytes.
    uint256 internal constant EIP170_LIMIT = 24_576;

    /// @notice Every facet's runtime bytecode must be within EIP-170.
    function test_EveryFacetUnderEip170SizeLimit() public view {
        string[37] memory facets = cutFacetNames();
        for (uint256 i; i < facets.length; ++i) {
            _assertUnderLimit(facets[i]);
        }
        // `DiamondCutFacet` is installed by the `VaipakamDiamond`
        // constructor, not via a cut list, so it is absent from
        // `cutFacetNames()` — size-check it explicitly here.
        _assertUnderLimit("DiamondCutFacet");
    }

    /// @dev Assert a single facet's runtime bytecode is within EIP-170.
    function _assertUnderLimit(string memory facet) private view {
        bytes memory code = vm.getDeployedCode(
            string.concat(facet, ".sol:", facet)
        );
        assertGt(
            code.length, 0, string.concat(facet, " artifact not found")
        );
        assertLe(
            code.length,
            EIP170_LIMIT,
            string.concat(
                facet,
                " runtime bytecode exceeds the EIP-170 24,576-byte limit"
            )
        );
    }
}
