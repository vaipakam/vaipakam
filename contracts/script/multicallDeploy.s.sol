// script/multicallDeploy.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {EncodeMultiSend} from "./utils/EncodeMultiSend.sol";

/**
 * @title multicallDeploy
 * @author Vaipakam Developer Team
 * @notice T-086 Round-5 Block A (#313) — atomic batched deploy
 *         for ABI-breaking executor + facet upgrades. Per
 *         Round-5.1 errata §16 A.10, the UUPS executor upgrade +
 *         the diamondCut MUST land in ONE transaction to avoid a
 *         transient ABI-mismatch outage.
 *
 *         Workflow (testnet rehearsal + mainnet share the SAME
 *         call shape; only the signer set differs):
 *
 *           1. Operator runs `DeployGnosisSafe.s.sol` (testnet)
 *              OR uses the production multisig (mainnet) to
 *              obtain the Safe address that owns the Diamond +
 *              executor proxy.
 *           2. Operator deploys the NEW executor implementation
 *              (UUPS — no proxy redeploy; the singleton's
 *              ERC1967 proxy stays the same address).
 *           3. This script encodes a MultiSend payload with TWO
 *              sub-calls:
 *                a) `executor.upgradeToAndCall(newImpl, "")` —
 *                   swaps the proxy's implementation pointer.
 *                b) `diamond.diamondCut(cuts, address(0), "")` —
 *                   the AddNew + RemoveOld selector cut.
 *           4. Operator submits ONE `Safe.execTransaction(
 *              multiSendAddress, 0, multiSendCalldata,
 *              Operation.DelegateCall, ...)` — atomic.
 *
 *         Operation.DelegateCall on the outer Safe call is what
 *         makes both sub-calls execute in the Safe's storage
 *         context, so `msg.sender` for both `upgradeToAndCall`
 *         and `diamondCut` is the Safe owner — both `onlyOwner`
 *         predicates pass.
 *
 *         This script PREPARES the payload + prints the
 *         calldata operators paste into the Safe UI. Actual
 *         submission via `vm.broadcast` is supported for the
 *         dev-EOA pre-handover rehearsal path (where the EOA
 *         can pre-sign the safeTxHash); production deploys
 *         always go via the Safe UI for human approval.
 */
contract MulticallDeployScript is Script {
    /// @notice Compute the MultiSend payload for the
    ///         executor-upgrade + diamondCut batch. Pure: doesn't
    ///         touch chain state.
    /// @param  executorProxy    Address of the deployed
    ///                          `CollateralListingExecutor` ERC1967
    ///                          proxy.
    /// @param  newExecutorImpl  The newly-deployed implementation
    ///                          carrying the extended
    ///                          `recordOrder(FeeLeg[])` signature.
    /// @param  diamond          The Vaipakam Diamond address.
    /// @param  diamondCutData   The full diamondCut calldata
    ///                          (Add new `postPrepayListing` /
    ///                          `updatePrepayListing` selectors +
    ///                          Remove the old four-arg selectors).
    ///                          Computed by `DeployDiamond.s.sol`'s
    ///                          existing selector-cut machinery.
    function buildPayload(
        address executorProxy,
        address newExecutorImpl,
        address diamond,
        bytes memory diamondCutData
    ) public pure returns (bytes memory multiSendCalldata) {
        EncodeMultiSend.SubCall[] memory calls = new EncodeMultiSend.SubCall[](2);

        // (a) UUPS upgrade — `upgradeToAndCall(newImpl, "")`.
        //     Selector `0x4f1ef286` is the canonical
        //     UUPSUpgradeable.upgradeToAndCall(address,bytes).
        calls[0] = EncodeMultiSend.SubCall({
            operation: 0,
            to: executorProxy,
            value: 0,
            data: abi.encodeWithSelector(0x4f1ef286, newExecutorImpl, hex"")
        });

        // (b) diamondCut — pass the full pre-built calldata
        //     through unchanged. The script's caller (the deploy
        //     orchestrator) is responsible for building the
        //     correct Add+Remove cut.
        calls[1] = EncodeMultiSend.SubCall({
            operation: 0,
            to: diamond,
            value: 0,
            data: diamondCutData
        });

        return EncodeMultiSend.encodeMultiSendCall(calls);
    }
}
