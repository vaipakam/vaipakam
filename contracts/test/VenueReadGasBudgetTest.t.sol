// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibPriceGuard} from "../src/libraries/LibPriceGuard.sol";

/// @dev Answers `slot0()` with a fixed word, or burns more than the budget.
contract VenueStub {
    bool public greedy;

    function setGreedy(bool g) external {
        greedy = g;
    }

    function probe() external view returns (uint256) {
        if (greedy) {
            // Runs until the call's own gas is gone, so it fails at any budget.
            uint256 x;
            while (true) {
                x = uint256(keccak256(abi.encode(x)));
            }
        }
        return 42;
    }
}

contract VenueReadHarness {
    function read(address target) external view returns (bool ok, bytes memory ret) {
        return LibPriceGuard.venueRead(target, abi.encodeCall(VenueStub.probe, ()));
    }
}

/**
 * @title VenueReadGasBudgetTest
 * @notice #3504 part 2: a read of an outside contract whose failure the caller
 *         reads as a fact about that contract (no pool, no oracle history,
 *         unreadable decimals) gets exactly {LibPriceGuard.VENUE_READ_GAS}.
 *         Too little gas left reverts {LibPriceGuard.PriceReadOutOfGas} by
 *         name, so the transaction's gas limit can never choose the verdict.
 *         A contract that needs more than the budget fails the read the same
 *         way for every caller.
 */
contract VenueReadGasBudgetTest is Test {
    VenueStub internal stub;
    VenueReadHarness internal harness;

    function setUp() public {
        stub = new VenueStub();
        harness = new VenueReadHarness();
    }

    function test_shortOfGas_revertsByName() public {
        (bool ok, bytes memory ret) =
            address(harness).call{gas: LibPriceGuard.VENUE_READ_GAS}(abi.encodeCall(VenueReadHarness.read, (address(stub))));
        assertFalse(ok);
        assertEq(bytes4(ret), LibPriceGuard.PriceReadOutOfGas.selector);
    }

    function test_enoughGas_answers() public view {
        (bool ok, bytes memory ret) = harness.read(address(stub));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), 42);
    }

    /// @dev The verdict on a contract that burns past the budget is the same
    ///      at any gas limit large enough to make the read at all.
    function test_greedyContract_failsAlikeAtEveryLimit() public {
        stub.setGreedy(true);
        uint256[3] memory limits = [uint256(400_000), 2_000_000, 10_000_000];
        for (uint256 i; i < limits.length; ++i) {
            (bool ok, bytes memory ret) =
                address(harness).call{gas: limits[i]}(abi.encodeCall(VenueReadHarness.read, (address(stub))));
            assertTrue(ok, "the read itself never reverts with enough gas");
            (bool readOk,) = abi.decode(ret, (bool, bytes));
            assertFalse(readOk, "the stub burns past the budget");
        }
    }
}
