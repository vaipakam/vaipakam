// script/utils/BatchCaller.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title BatchCaller
 * @author Vaipakam Developer Team
 * @notice T-086 Round-5 Block A (#313) — minimal same-transaction
 *         batched-call helper for ABI-breaking deploys where a
 *         diamondCut + UUPS upgrade MUST land atomically (see
 *         design §16 A.10 + Round-5.1 errata).
 *
 *         **Use NOT for production deploys.** Production uses the
 *         admin Gnosis Safe's `MultiSend` with `Operation.DelegateCall`
 *         so `msg.sender` for each sub-call is the Safe (= the
 *         actual diamond/executor owner). This BatchCaller does
 *         NOT preserve ownership — `msg.sender` for each sub-call
 *         is the BatchCaller's own address. For testnet / Anvil
 *         rehearsals, the deploy script FIRST transfers ownership
 *         of the diamond + executor proxy to a 1-of-1 Gnosis Safe
 *         (with the dev EOA as the single signer), and the
 *         actual batched call is submitted via the Safe's
 *         `execTransaction` with a MultiSend payload — same call
 *         shape as mainnet.
 *
 *         BatchCaller is the **scaffolding stand-in** for the rare
 *         operator workflow where the rehearsal can't use a Safe
 *         (e.g., a quick local sanity check before the real
 *         rehearsal): the dev EOA owns diamond + executor, calls
 *         `BatchCaller.batch(targets, calldatas)` directly, and
 *         the BatchCaller forwards each pair as `targets[i].call(...)`
 *         in a single transaction. This LACKS the ownership-
 *         preservation property — the sub-calls would revert on
 *         `onlyOwner` predicates — so this contract is ONLY useful
 *         after a temporary `transferOwnership(BatchCaller)` step
 *         that the operator MUST reverse immediately after the
 *         batched call. See `script/multicallDeploy.s.sol` for the
 *         orchestration.
 */
contract BatchCaller {
    /// @notice One sub-call's outcome failed. We bubble up the
    ///         original revert reason via the assembly block so
    ///         the operator sees the underlying error (rather than
    ///         a generic "batch failed").
    error SubCallFailed(uint256 idx, bytes reason);

    /// @notice Mismatched arrays — the call wouldn't be safe to
    ///         iterate.
    error LengthMismatch(uint256 targets, uint256 calldatas);

    /// @notice Atomic batched call. All sub-calls execute in this
    ///         transaction; any sub-call revert reverts the whole
    ///         batch (Solidity's standard semantics — no try/catch).
    /// @dev    Reentrancy is structurally bounded: the BatchCaller
    ///         holds no state across calls, so a re-entered
    ///         `batch` would simply run another batch with no
    ///         shared mutable surface. The operator's deploy
    ///         workflow doesn't grant the BatchCaller any role
    ///         beyond the transient ownership transfer, so this
    ///         lack of explicit reentrancy guard is intentional
    ///         and minimal.
    function batch(address[] calldata targets, bytes[] calldata calldatas)
        external
        returns (bytes[] memory results)
    {
        if (targets.length != calldatas.length) {
            revert LengthMismatch(targets.length, calldatas.length);
        }
        results = new bytes[](targets.length);
        for (uint256 i = 0; i < targets.length; ) {
            (bool ok, bytes memory ret) = targets[i].call(calldatas[i]);
            if (!ok) {
                // Bubble up the original revert reason. If the
                // sub-call reverted with a custom error or a
                // string reason, the operator sees the raw bytes.
                // Wrap them in our typed error so the batch index
                // is recoverable.
                revert SubCallFailed(i, ret);
            }
            results[i] = ret;
            unchecked { ++i; }
        }
    }
}
