// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";
import {IZeroExProxy} from "../../src/interfaces/IZeroExProxy.sol";

/**
 * @title MockZeroExLegacyAdapter — test-only ISwapAdapter that wraps the
 *        legacy IZeroExProxy.swap(...) simplified ABI we used pre-Phase-7a.
 *
 * Lets the 240+ existing test call sites that pre-date Phase 7a continue
 * to exercise the same 0x code path through the new adapter abstraction.
 * `adapterData` is ignored — the adapter forwards to the wrapped 0x proxy
 * with the caller-supplied (in, out, amt, minOut, recipient) tuple. The
 * proxy's mock implementation (`ZeroExProxyMock`) handles the rate
 * scaling + insufficient-output revert as it always has, so tests that
 * tune the mock rate continue to drive the same outcomes.
 *
 * Production deployments do NOT register this — they register
 * {ZeroExAggregatorAdapter} which uses the canonical 0x Settler raw-
 * calldata pattern. This shim exists strictly so the test suite can
 * migrate without rewriting every pre-Phase-7a test.
 */
contract MockZeroExLegacyAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    /// @notice The wrapped ZeroExProxyMock instance — fixed at deploy time.
    address public immutable PROXY;

    constructor(address zeroExProxy) {
        require(zeroExProxy != address(0), "PROXY=0");
        PROXY = zeroExProxy;
    }

    function adapterName() external pure override returns (string memory) {
        return "ZeroExLegacy";
    }

    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        bytes calldata /* adapterData */
    ) external override returns (uint256 outputAmount) {
        IERC20 input = IERC20(inputToken);
        // #2472 — snapshot before the pull so only this call's unspent input
        // is handed back (ISwapAdapter's residual invariant).
        uint256 inputBalanceBefore = input.balanceOf(address(this));
        // Pull input from caller (the diamond / harness) and approve the
        // proxy for the exact amount, mirroring the legacy inline pattern
        // that previously lived in RiskFacet / DefaultedFacet.
        input.safeTransferFrom(msg.sender, address(this), inputAmount);
        input.forceApprove(PROXY, 0);
        input.forceApprove(PROXY, inputAmount);

        outputAmount = IZeroExProxy(PROXY).swap(
            inputToken,
            outputToken,
            inputAmount,
            minOutputAmount,
            recipient
        );

        input.forceApprove(PROXY, 0);
        // This call's unspent input (zero on a clean swap; non-zero would
        // indicate a partial fill the proxy mock doesn't simulate) is handed
        // back to the caller — and nothing the shim held before the pull.
        uint256 balanceNow = input.balanceOf(address(this));
        if (balanceNow > inputBalanceBefore) {
            input.safeTransfer(msg.sender, balanceNow - inputBalanceBefore);
        }
    }
}
