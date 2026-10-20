// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {GuardianPausable} from "../crosschain/GuardianPausable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20CappedUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20CappedUpgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

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
 *         Adding a namespaced storage struct anywhere `src/` compiles, OpenZeppelin's
 *         upgradeable namespaces included, means adding a probe here and a
 *         root in `contracts/storage-layout/roots.json`. The guard resolves
 *         every inline-assembly `.slot :=` in those sources, from the
 *         compiler's AST, to the struct the pointer is typed as and the
 *         position constant it is set from. It refuses a pointer no root
 *         names, a pointer that reads a rooted namespace as another struct,
 *         and a root whose probe struct and constant no pointer joins, so the
 *         omission fails loudly.
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

// OpenZeppelin's ERC-7201 namespaces, used by the UUPS implementations. They
// live in the audited submodule, so they change only with a bump of it, which
// is itself a re-audit; the guard still records them, so a bump that moves
// one is refused like any other break.

contract StorageLayoutProbeOzInitializable {
    // slither-disable-next-line unused-state
    Initializable.InitializableStorage internal probe;
}

contract StorageLayoutProbeOzERC20 {
    // slither-disable-next-line unused-state
    ERC20Upgradeable.ERC20Storage internal probe;
}

contract StorageLayoutProbeOzERC20Capped {
    // slither-disable-next-line unused-state
    ERC20CappedUpgradeable.ERC20CappedStorage internal probe;
}

contract StorageLayoutProbeOzERC4626 {
    // slither-disable-next-line unused-state
    ERC4626Upgradeable.ERC4626Storage internal probe;
}

contract StorageLayoutProbeOzOwnable {
    // slither-disable-next-line unused-state
    OwnableUpgradeable.OwnableStorage internal probe;
}

contract StorageLayoutProbeOzOwnable2Step {
    // slither-disable-next-line unused-state
    Ownable2StepUpgradeable.Ownable2StepStorage internal probe;
}

contract StorageLayoutProbeOzPausable {
    // slither-disable-next-line unused-state
    PausableUpgradeable.PausableStorage internal probe;
}
