// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SlippageCensus} from "../../script/SlippageCensus.s.sol";
import {RehearsalChain} from "../../script/lib/RehearsalChain.sol";

/// @dev Calls the library from an external frame so `expectRevert` can see it.
contract RehearsalChainHarness {
    function check() external view {
        RehearsalChain.requireRehearsalChain("Harness");
    }
}

/// @dev Exposes the census's CSV field encoder.
contract SlippageCensusHarness is SlippageCensus {
    function csvField(string memory raw) external pure returns (string memory) {
        return _csvField(raw);
    }
}

/**
 * @title  DeployScriptHardeningTest
 * @notice #2763 — the script-side fixes: the one rehearsal-chain guard every
 *         mock-wiring script shares and the census CSV encoder. (The V2
 *         factory script it also covered was retired with the V2 leg of
 *         the liquidity route search, #3354.)
 */
contract DeployScriptHardeningTest is Test {
    // ── RehearsalChain ────────────────────────────────────────────────

    /// @notice One sequential test: the env var is process-wide, so its
    ///         cases must not run beside each other.
    function test_RehearsalChain_AnvilAlways_TestnetOnlyWhenNamed_ProductionNever() public {
        RehearsalChainHarness h = new RehearsalChainHarness();

        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "0");
        vm.chainId(31337);
        h.check();

        vm.chainId(84532);
        vm.expectRevert();
        h.check();

        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "421614");
        vm.expectRevert();
        h.check(); // names another testnet

        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "84532");
        h.check();

        vm.chainId(8453);
        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "8453");
        vm.expectRevert();
        h.check(); // a production chain, even when named

        vm.setEnv("REHEARSAL_ALLOW_CHAIN_ID", "0");
    }

    // ── SlippageCensus ────────────────────────────────────────────────

    function test_CensusCsvField_KeepsOneColumnOneRowAndNoFormula() public {
        SlippageCensusHarness h = new SlippageCensusHarness();
        assertEq(h.csvField("USDC"), "USDC", "a plain symbol is unchanged");
        assertEq(h.csvField(""), "");
        assertEq(h.csvField("A,B"), "\"A,B\"", "a comma is quoted");
        assertEq(h.csvField("say \"hi\""), "\"say \"\"hi\"\"\"", "quotes are doubled");
        assertEq(h.csvField("X\nCENSUS,forged"), "\"X CENSUS,forged\"", "a newline cannot start a row");
        assertEq(h.csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)", "a formula reads as text");
        assertEq(h.csvField("-1,2"), "\"'-1,2\"");
        assertEq(h.csvField("\t@x"), " @x", "a leading control byte becomes a space");
    }
}
