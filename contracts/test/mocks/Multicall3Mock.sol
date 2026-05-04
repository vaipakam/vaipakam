// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Multicall3Mock
 * @notice Minimal Multicall3 implementation for the anvil playground.
 *         Mirrors the canonical Multicall3 contract
 *         (https://github.com/mds1/multicall3) at
 *         `0xcA11bde05977b3631167028862bE2a173976CA11` on production
 *         networks. The frontend's `lib/multicall.ts` only consumes
 *         `aggregate3`, so this stub implements that single function.
 *
 *         Deployment flow on anvil: `anvil-bootstrap.sh` deploys this
 *         contract via `forge create`, then uses `anvil_setCode` to
 *         copy the runtime bytecode to the canonical address so
 *         viem's per-chain Multicall3 lookup resolves a real
 *         contract instead of a "no data" revert.
 *
 *         Test-tree only — never cut into the Diamond, never deployed
 *         to a real network. The path under `contracts/test/mocks/`
 *         keeps it visually segregated from production sources.
 */
contract Multicall3Mock {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls)
        external
        payable
        returns (Result[] memory returnData)
    {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; ) {
            Call3 calldata c = calls[i];
            (bool success, bytes memory ret) = c.target.call(c.callData);
            if (!success && !c.allowFailure) {
                revert("Multicall3: call failed");
            }
            returnData[i] = Result({success: success, returnData: ret});
            unchecked { ++i; }
        }
    }
}
