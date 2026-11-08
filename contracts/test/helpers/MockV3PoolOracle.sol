// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";

/// @title  MockV3PoolOracle
/// @notice #3354 — mocks a V3-clone pool's own oracle (`observe(uint32[])`)
///         for tests that stand a pool up with `vm.mockCall`.
/// @dev    The liquidity route search requires the pool's oracle to answer
///         for the TWAP window and credits its harmonic-mean liquidity
///         (`window · 2¹²⁸ / Δ secondsPerLiquidity`), so a pool mocked with
///         `slot0()` and `liquidity()` alone no longer counts. The mock
///         matches on the selector only, whatever window the caller asks
///         for, and answers as if `meanLiquidity` and `meanTick` had held
///         for `window` seconds. Pass the window the Diamond is configured
///         with (`DEFAULT_WINDOW` unless the test changed it).
library MockV3PoolOracle {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev `LibVaipakam.TWAP_WINDOW_SEC_DEFAULT`.
    uint32 internal constant DEFAULT_WINDOW = 30 minutes;

    /// @notice The pool held `liquidity` at tick `tick` for the whole window.
    function steady(address pool, int24 tick, uint128 liquidity) internal {
        history(pool, tick, uint256(liquidity), DEFAULT_WINDOW);
    }

    /// @notice The pool's window mean was `meanLiquidity` at `meanTick`,
    ///         whatever its current state.
    function history(address pool, int24 meanTick, uint256 meanLiquidity, uint32 window) internal {
        int56[] memory ticks = new int56[](2);
        ticks[0] = 0;
        ticks[1] = int56(meanTick) * int56(uint56(window));
        uint160[] memory spl = new uint160[](2);
        spl[0] = 0;
        // A zero mean stands for a pool that held no liquidity: V3 then
        // divides by one, so the accumulator grows by the whole window.
        uint256 denom = meanLiquidity == 0 ? 1 : meanLiquidity;
        spl[1] = uint160((uint256(window) << 128) / denom);
        VM.mockCall(pool, abi.encodeWithSignature("observe(uint32[])"), abi.encode(ticks, spl));
    }

    /// @notice The pool's oracle cannot answer for the window (a pool at the
    ///         default observation cardinality of one reverts `OLD`).
    function noHistory(address pool) internal {
        VM.mockCallRevert(pool, abi.encodeWithSignature("observe(uint32[])"), bytes("OLD"));
    }
}
