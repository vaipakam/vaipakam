// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {DeployDiamond} from "../../script/DeployDiamond.s.sol";

/**
 * @title  DeployDiamondVerificationProbes
 * @notice The two `DeployDiamond` subclasses `DeployArtifactCompletenessTest`
 *         drives.
 *
 * @dev    **Keep inline assembly out of these contracts, annotated or not.**
 *
 *         An earlier revision of this header blamed the viaIR stack ceiling:
 *         it claimed a subclass's copy of `runWith` has zero spare slots, so an
 *         `internal virtual` hook could never be an override seam. That was
 *         wrong, and it is corrected rather than deleted because it is exactly
 *         the sort of mechanism that sounds right and gets rediscovered.
 *
 *         What actually happened: the failing probe carried a bare
 *         `assembly { revert(add(err, 0x20), mload(err)) }` to rethrow a caught
 *         revert. That block READS MEMORY, and an unannotated block solc cannot
 *         treat as safe by itself — one that accesses memory, or one that
 *         exports a computed pointer to a memory-reference variable — withdraws
 *         viaIR's stack-to-memory mover for the WHOLE contract. These contracts
 *         inherit `runWith`, whose ~80 live facet addresses depend on it. solc
 *         then reports `Variable … is 1 too deep in the stack` naming
 *         `runWith`, a function the assembly block is nowhere near, and adds
 *         the real diagnosis on its last line: "No memoryguard was present."
 *
 *         The qualifier is the whole rule, not a detail: a block of neither
 *         shape does not withhold the guard, and annotating one anyway is
 *         NOISE — a false signal about what the block does — rather than a
 *         bytecode cost. The bytecode cost comes from
 *         ENABLING THE MOVER on a contract that has a real blocker, since the
 *         mover is code; that is what put two facets over EIP-170 in #2268. Do
 *         not restate the rule without the qualifier here — see the
 *         `memoryguard` note on `Deployments.finalizeArtifact`, and CLAUDE.md's
 *         "1 too deep in the stack" section for the canonical treatment.
 *
 *         So the probes failed on their own assembly, not on the seam, and five
 *         revisions were spent moving a call that was never the cause. Neither
 *         probe uses assembly now — the failing one reverts with a plain string.
 *         If one ever needs a block again, annotate it `("memory-safe")` and
 *         only if it genuinely is; see the note in `Deployments.finalizeArtifact`.
 *
 *         `forge build --skip test` cannot see any of this, because it never
 *         compiles these contracts.
 */

/**
 * @notice Records whether a real deploy actually reached its artifact
 *         verification, so the CALL SITE is covered and not only the check.
 *
 * @dev    #2253 r2 — mutation-checking the root fix found it unguarded:
 *         deleting the call left the whole suite green, because every test
 *         there reads the artifact itself and asserts the same property the
 *         deploy asserts. The check was right and nothing depended on it
 *         running.
 *
 *         `super` is still called, so this probe deploys exactly as the real
 *         script does and cannot pass by skipping the thing it is standing in
 *         for.
 */
contract DeployDiamondVerificationProbe is DeployDiamond {
    bool public verificationRan;

    function assertFacetsRecordedExternal(address[] memory expected)
        external
        override
    {
        require(msg.sender == address(this), "probe: self-call only");
        verificationRan = true;
        // Not `super.…`: Solidity does not allow reaching an `external`
        // override that way. `_assertFacetsRecorded` is the base's own body,
        // so this runs what the base runs rather than a copy of it.
        _assertFacetsRecorded(expected);
    }
}

/**
 * @notice A deploy whose artifact verification always FAILS, so the failure
 *         path itself can be exercised without mutating `DeployDiamond`.
 *
 * @dev    #2253 r3 P1. Reverting where the real assertion would revert drives
 *         the library's restore branch while every real write has already
 *         happened — exactly the situation the finding described: a caught
 *         omission, after the canonical artifact has been overwritten.
 *
 *         The revert message deliberately mimics the real one's shape so the
 *         test asserts on behaviour (the deploy reverted, the artifact came
 *         back) rather than on this probe's wording.
 */
contract DeployDiamondFailingVerificationProbe is DeployDiamond {
    function assertFacetsRecordedExternal(address[] memory)
        external
        pure
        override
    {
        revert(
            "Deployments: facet 0x000000000000000000000000000000000000dEaD is installed in the Diamond but was never recorded under any .facets.* key"
        );
    }
}
