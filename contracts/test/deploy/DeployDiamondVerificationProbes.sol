// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {DeployDiamond} from "../../script/DeployDiamond.s.sol";

/**
 * @title  DeployDiamondVerificationProbes
 * @notice The two `DeployDiamond` subclasses `DeployArtifactCompletenessTest`
 *         drives.
 *
 * @dev    **Both override `assertFacetsRecordedExternal`, and nothing else.
 *         That is a hard constraint, not a style choice.**
 *
 *         `DeployDiamond.runWith` sits at the viaIR whole-unit stack ceiling,
 *         and a subclass gets its OWN inlined copy of it. That copy has zero
 *         spare slots: an earlier revision put the seam on an `internal
 *         virtual` hook called from `runWith`, and every override body tried —
 *         down to a single external self-call taking one argument — failed the
 *         test build with `Variable … is 1 too deep in the stack` while the
 *         identical base contract compiled cleanly. `forge build --skip test`
 *         reports success throughout, because it never compiles these.
 *
 *         An EXTERNAL function is not inlined into `runWith`, so overriding one
 *         costs that frame nothing. Do not add an override of anything
 *         `internal` here, and do not add a subclass of `DeployDiamond` that
 *         does.
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
