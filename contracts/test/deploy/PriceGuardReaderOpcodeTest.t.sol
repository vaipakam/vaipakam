// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {PriceGuardReader} from "../../src/oracle/PriceGuardReader.sol";

/**
 * @title  PriceGuardReaderOpcodeTest
 * @notice #3437 — the guard runs its reader's code over the guard's own
 *         storage. It does so only inside a static call, so the reader cannot
 *         write today; this test makes sure no later edit gives it a way to
 *         try. It walks the reader's runtime bytecode, skipping push data and
 *         the trailing metadata, and refuses any opcode that writes state,
 *         logs, creates, destroys or hands control to code chosen elsewhere.
 * @dev    A read is still allowed to STATICCALL feeds and rate readers.
 *
 *         LOAD-BEARING. The guard pins its reader by address, and nothing
 *         else on-chain says what the reader may do. The reader's code can
 *         never change (no SELFDESTRUCT, no DELEGATECALL, no proxy), and the
 *         deploy script refuses a reader whose runtime code is not this
 *         tree's build ({PriceGuardDeployment.requireArtifactCode}). Those
 *         two conditions together are what make the pinned reader safe; do
 *         not relax an opcode here without a design decision.
 */
contract PriceGuardReaderOpcodeTest is Test {
    function test_ReaderCannotWriteLogCreateOrDelegate() public view {
        bytes memory code = vm.getDeployedCode(string.concat(type(PriceGuardReader).name, ".sol:", type(PriceGuardReader).name));
        assertGt(code.length, 0, "reader artifact not found");
        // Solidity appends CBOR metadata whose length is the last two bytes.
        uint256 meta = (uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]);
        uint256 end = code.length - 2 - meta;
        for (uint256 i; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f; // PUSH1..PUSH32 data
                continue;
            }
            assertTrue(op != 0x55, _at("SSTORE", i));
            assertTrue(op != 0x5d, _at("TSTORE", i));
            assertTrue(op != 0xf0 && op != 0xf5, _at("CREATE", i));
            assertTrue(op != 0xf1, _at("CALL", i));
            assertTrue(op != 0xf2, _at("CALLCODE", i));
            assertTrue(op != 0xf4, _at("DELEGATECALL", i));
            assertTrue(op != 0xff, _at("SELFDESTRUCT", i));
            assertTrue(op < 0xa0 || op > 0xa4, _at("LOG", i));
        }
    }

    function _at(string memory what, uint256 i) private pure returns (string memory) {
        return string.concat("reader bytecode has ", what, " at ", vm.toString(i));
    }
}
