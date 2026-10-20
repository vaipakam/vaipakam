// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {GuardianPausable} from "../crosschain/GuardianPausable.sol";

/**
 * @title  Storage-layout probes (#1274 / #2092)
 * @notice NEVER DEPLOYED. Each contract below declares ONE state variable of a
 *         namespaced storage struct, so that the compiler's `storageLayout`
 *         output describes that struct exactly: every member's slot, offset
 *         and type, recursively. A library struct that lives at a hashed
 *         position has no state variable anywhere, so without a probe the
 *         compiler never reports its layout at all.
 *
 *         The probe puts the struct at slot 0. The storage-layout guard reads
 *         every slot RELATIVE to the struct's base, so slot 0 here stands for
 *         the namespace position on a live Diamond. The positions themselves
 *         are checked separately, from the source constants, by the same
 *         guard (`contracts/script/storage-layout-guard.mjs`).
 *
 *         Adding a namespaced storage struct anywhere in `src/` means adding a
 *         probe here and a root in `contracts/storage-layout/roots.json`. The
 *         guard resolves every inline-assembly `.slot :=` in `src/` to the
 *         struct it returns and the position constant it is set from, and
 *         refuses one that no root names, or a root whose probe struct and
 *         constant no such pointer joins, so the omission fails loudly.
 *
 *         Each probe variable is never read or written, by design: the
 *         compiler's layout report is the whole point. Slither's unused-state
 *         finding on them is expected and suppressed per probe.
 */
contract StorageLayoutProbeVaipakam {
    // slither-disable-next-line unused-state
    LibVaipakam.Storage internal probe;
}

contract StorageLayoutProbeERC721 {
    // slither-disable-next-line unused-state
    LibERC721.ERC721Storage internal probe;
}

contract StorageLayoutProbeAccessControl {
    // slither-disable-next-line unused-state
    LibAccessControl.AccessControlStorage internal probe;
}

contract StorageLayoutProbePausable {
    // slither-disable-next-line unused-state
    LibPausable.PausableStorage internal probe;
}

contract StorageLayoutProbeReentrancyGuard {
    // slither-disable-next-line unused-state
    LibReentrancyGuard.ReentrancyGuardStorage internal probe;
}

contract StorageLayoutProbeDiamond {
    // slither-disable-next-line unused-state
    LibDiamond.DiamondStorage internal probe;
}

contract StorageLayoutProbeGuardian {
    // slither-disable-next-line unused-state
    GuardianPausable.GuardianStorage internal probe;
}
