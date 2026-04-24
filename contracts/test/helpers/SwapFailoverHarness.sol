// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

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
 */
contract SwapFailoverHarness {
    event TestSwapResult(bool success, uint256 output, uint256 adapterIdx);

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
}
