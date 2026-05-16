// src/token/VaipakamVestingWallet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/**
 * @title VaipakamVestingWallet
 * @author Vaipakam Developer Team
 * @notice Concrete cliff + linear vesting wallet for a single grantee —
 *         the founder, a developer/team hire, or an early contributor
 *         (T-600). One instance is deployed per grantee.
 * @dev OpenZeppelin's `VestingWalletCliff` is `abstract` (it only adds
 *      the cliff override); this thin wrapper makes it deployable by
 *      threading the `VestingWallet` schedule args through to the base.
 *
 *      Schedule semantics (OZ `VestingWallet` / `VestingWalletCliff`):
 *        - `startTimestamp` … `startTimestamp + durationSeconds` is the
 *          linear-release window.
 *        - nothing is releasable until `startTimestamp + cliffSeconds`;
 *          at the cliff the linearly-accrued amount unlocks in one step,
 *          then continues linearly.
 *        - `release(token)` is permissionless and always pays the
 *          beneficiary (the wallet's `Ownable` owner) — so a keeper or
 *          the grantee can trigger it.
 *
 *      Non-upgradeable by design: a vesting wallet that the grantee
 *      relies on for years should be immutable — there is no admin key
 *      and no upgrade path that could alter the schedule after grant.
 *
 *      Funded once at grant time by minting VPFI into this address via
 *      `TreasuryFacet.mintVPFI(thisWallet, grantAmount)`. The treasury
 *      tracks consumed-vs-remaining headroom per allocation pool
 *      off-chain / in the deploy record.
 */
contract VaipakamVestingWallet is VestingWalletCliff {
    /**
     * @param beneficiary The grantee — receives released tokens and owns
     *        the wallet (non-zero; enforced by OZ `Ownable`).
     * @param startTimestamp Unix timestamp the vesting schedule starts.
     * @param durationSeconds Total linear-vesting duration.
     * @param cliffSeconds Cliff length from `startTimestamp`; must be
     *        ≤ `durationSeconds` (OZ reverts `InvalidCliffDuration`).
     */
    constructor(
        address beneficiary,
        uint64 startTimestamp,
        uint64 durationSeconds,
        uint64 cliffSeconds
    )
        VestingWallet(beneficiary, startTimestamp, durationSeconds)
        VestingWalletCliff(cliffSeconds)
    {}
}
