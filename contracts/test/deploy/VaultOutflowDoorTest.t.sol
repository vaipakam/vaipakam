// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DiamondFacetNames} from "./DiamondFacetNames.sol";
import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";

/**
 * @title  VaultOutflowDoorTest
 * @notice #3205 part 2 — "one function in the Diamond" is held structurally
 *         (`VaultOutflowPolicyDesign.md` §3.2, §6): no Diamond contract but
 *         the policy host, `VaultOutflowFacet`, may call the vault's doors
 *         ({VaipakamVaultImplementation.transferOut}, {grantAllowance},
 *         {closeGrant}). A facet that reached a door directly would move vault
 *         funds past the policy's class checks, its ledgers and its movement
 *         event, so this test fails on any such facet, by name.
 * @dev    Read from the compiled RUNTIME code of every cut facet: a contract
 *         that calls a function carries its 4-byte selector as a PUSH4
 *         operand. The same technique the numeraire-value family uses to find
 *         its consumers (CLAUDE.md). An accidental byte match inside unrelated
 *         data is possible in principle; the test then names the facet, and a
 *         reviewer confirms it.
 */
contract VaultOutflowDoorTest is Test, DiamondFacetNames {
    function _doors() private pure returns (bytes4[3] memory) {
        return [
            VaipakamVaultImplementation.transferOut.selector,
            VaipakamVaultImplementation.grantAllowance.selector,
            VaipakamVaultImplementation.closeGrant.selector
        ];
    }

    function test_onlyThePolicyHostReachesTheVaultDoors() public view {
        string[113] memory facets = cutFacetNames();
        bytes4[3] memory doors = _doors();
        bool hostCallsEach = true;
        for (uint256 i; i < facets.length; ++i) {
            bytes memory code = vm.getDeployedCode(string.concat(facets[i], ".sol:", facets[i]));
            bool isHost = keccak256(bytes(facets[i])) == keccak256("VaultOutflowFacet");
            for (uint256 d; d < doors.length; ++d) {
                bool found = _pushes(code, doors[d]);
                if (isHost) {
                    hostCallsEach = hostCallsEach && found;
                } else {
                    assertFalse(found, string.concat(facets[i], " calls a vault door directly; route it through LibVaultOutflow"));
                }
            }
        }
        assertTrue(hostCallsEach, "VaultOutflowFacet must reach every door (the scan would otherwise prove nothing)");
    }

    /// @dev Whether `code` pushes `selector`, or the selector shifted right by
    ///      any of its trailing zero bits (viaIR emits an even selector that
    ///      way and shifts it back, as the numeraire-value family's
    ///      `1af7aa8e` shows), at any PUSH width.
    function _pushes(bytes memory code, bytes4 selector) private pure returns (bool) {
        uint256 v = uint32(selector);
        // Never below 16 bits: a value that small is pushed for unrelated
        // reasons and would only produce a false finding.
        while (v >= 0x10000) {
            if (_pushesValue(code, v)) return true;
            if (v & 1 == 1) break;
            v >>= 1;
        }
        return false;
    }

    /// @dev Whether some PUSHn in `code` (walking opcodes, so push data is
    ///      never read as an opcode) carries exactly `v`.
    function _pushesValue(bytes memory code, uint256 v) private pure returns (bool) {
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                uint256 n = op - 0x5f;
                if (i + n < code.length) {
                    uint256 x;
                    for (uint256 j = 1; j <= n; ++j) x = (x << 8) | uint8(code[i + j]);
                    if (x == v) return true;
                }
                i += n + 1;
            } else {
                ++i;
            }
        }
        return false;
    }
}
