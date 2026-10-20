// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {ISwapAttemptHost} from "../../src/interfaces/ISwapAttemptHost.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";

/**
 * @title SwapFailoverHarness — test-only wrapper for LibSwap.
 *
 * Exposes `LibSwap.swapWithFailover` as an external function so
 * Foundry can call it directly and read the return tuple. Also
 * provides seed/reset helpers for the `swapAdapters` storage slot.
 * This contract shares the diamond storage layout (via
 * LibVaipakam.storageSlot) but lives in its own address — each test
 * deploys a fresh harness, so the storage slot is effectively scoped
 * to that deployment's account state.
 *
 * #2472 — a failover attempt is a self-call to
 * {ISwapAttemptHost.swapAttempt}. In the Diamond that selector routes to
 * `SwapAttemptFacet`; here the harness hosts it itself and records itself
 * as the selector's facet in its own Diamond routing table, which is what
 * {LibSwap.attempt} reads to tell a missing host from a failed route.
 */
contract SwapFailoverHarness is ISwapAttemptHost {
    event TestSwapResult(bool success, uint256 output, uint256 adapterIdx);

    constructor() {
        setAttemptHostRouted(true);
    }

    /// @dev Route (or unroute) the attempt host, to exercise
    ///      {LibSwap.SwapAttemptHostMissing}.
    function setAttemptHostRouted(bool routed) public {
        LibDiamond.diamondStorage()
            .selectorToFacetAndPosition[ISwapAttemptHost.swapAttempt.selector]
            .facetAddress = routed ? address(this) : address(0);
    }

    /// @dev Mirrors `SwapAttemptFacet.swapAttempt`, gate included. While the
    ///      selector is unrouted it reverts the way the Diamond's fallback
    ///      does for a selector no facet hosts, so a test can drive the
    ///      missing-host branch of {LibSwap.attempt}.
    function swapAttempt(
        LibSwap.Sale calldata sale,
        uint256 adapterIdx,
        bytes calldata data
    ) external returns (uint256 outputAmount, uint256 inputSpent) {
        require(
            LibDiamond.diamondStorage()
                .selectorToFacetAndPosition[ISwapAttemptHost.swapAttempt.selector]
                .facetAddress == address(this),
            "harness: FunctionDoesNotExist"
        );
        require(msg.sender == address(this), "harness: internal only");
        return LibSwap.runAttempt(sale, adapterIdx, data);
    }

    function setAdapters(address[] calldata adapters) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        delete s.swapAdapters;
        for (uint256 i = 0; i < adapters.length; ++i) {
            s.swapAdapters.push(adapters[i]);
        }
    }

    function getAdapters() external view returns (address[] memory) {
        return LibVaipakam.storageSlot().swapAdapters;
    }

    function doSwap(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        LibSwap.AdapterCall[] calldata calls
    ) external returns (bool success, uint256 output, uint256 adapterIdx) {
        (success, output, adapterIdx) = LibSwap.swapWithFailover(
            loanId,
            inputToken,
            outputToken,
            inputAmount,
            minOutputAmount,
            recipient,
            calls
        );
        emit TestSwapResult(success, output, adapterIdx);
    }

    /// @dev #2472 — the up-to entry (swap-to-repay's), returning the measured
    ///      spend alongside the usual tuple.
    function doSwapUpTo(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        LibSwap.AdapterCall[] calldata calls
    ) external returns (bool success, uint256 output, uint256 adapterIdx, uint256 inputSpent) {
        return LibSwap.swapWithFailoverUpTo(
            loanId,
            inputToken,
            outputToken,
            inputAmount,
            minOutputAmount,
            recipient,
            calls
        );
    }

    /// @dev #2472 — the atomic split entry, so its per-leg delivery rule is
    ///      testable without a full Diamond.
    function doSplit(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        LibSwap.SplitCall[] calldata splits
    ) external returns (uint256 totalOutput) {
        return LibSwap.swapWithSplit(
            loanId,
            inputToken,
            outputToken,
            inputAmount,
            minOutputAmount,
            recipient,
            splits
        );
    }
}
