// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibRewardStaging} from "../libraries/LibRewardStaging.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardStagingDomainFacet
 * @notice 3b-ii-A2-ii (#2305) — the lifecycle entries of a multi-chunk claim
 *         DOMAIN ({LibVaipakam.StagingDomain}): a claim whose pending armed
 *         days exceed one settlement chunk is PREPARED by the claim walk (one
 *         day record per day, nothing paid) and then, through these
 *         permissionless pages, RESERVED day by day from the live sources and
 *         the cap headroom, RESOLVED in day order once every day is reserved,
 *         or UNWOUND past its deadline or on the claimant's cancel. Hosted on
 *         its own facet: `RewardStagingFacet` carries the record machinery
 *         and sits within 2.4 KB of EIP-170.
 * @dev    Every value movement here is a record's own — a page of this facet
 *         only chooses which record's page runs; the records' events name the
 *         moves. The domain's own events name its phases, its cursor stops
 *         and its clearing.
 */
contract RewardStagingDomainFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    /// @notice A2-ii domain events the staging library emits through this
    ///         facet's entries, declared here for the exported ABI.
    event StagingDomainOpened(bytes32 indexed domainKey, address indexed user, uint8 side, uint64 firstDay, uint64 lastDay, uint256 chunks);
    event StagingDomainPhase(bytes32 indexed domainKey, uint8 phase);
    event StagingDomainReserveStopped(bytes32 indexed domainKey, uint64 day);
    event StagingDomainCleared(bytes32 indexed domainKey, bool paid);
    event StagingDomainDeadlineSet(bytes32 indexed domainKey, uint64 deadline);

    /// @notice One reservation page of the domain under `domainKey`
    ///         ({LibRewardStaging.reserveDomainPage}). Permissionless.
    function reserveDomainPage(bytes32 domainKey) external nonReentrant whenNotPaused returns (bool done) {
        return LibRewardStaging.reserveDomainPage(LibVaipakam.storageSlot(), domainKey);
    }

    /// @notice One resolution page ({LibRewardStaging.resolveDomainPage}). Permissionless.
    function resolveDomainPage(bytes32 domainKey) external nonReentrant whenNotPaused returns (bool done) {
        return LibRewardStaging.resolveDomainPage(LibVaipakam.storageSlot(), domainKey);
    }

    /// @notice One unwind page ({LibRewardStaging.unwindDomainPage}): past the
    ///         deadline anyone, before it only the claimant.
    function unwindDomainPage(bytes32 domainKey) external nonReentrant returns (bool done) {
        return LibRewardStaging.unwindDomainPage(LibVaipakam.storageSlot(), domainKey, msg.sender);
    }

    /// @notice The claimant binds the venue the domain's days deliver to, while
    ///         the domain is still staging.
    function setDomainVenue(bytes32 domainKey, LibVaipakam.RewardDelivery venue) external nonReentrant {
        LibRewardStaging.setDomainVenue(LibVaipakam.storageSlot(), domainKey, msg.sender, venue);
    }

    /// @notice The domain of (`user`, `side`) — every scalar it carries, and its key.
    function getStagingDomain(address user, LibVaipakam.RewardSide side)
        external
        view
        returns (
            bytes32 domainKey,
            uint8 phase,
            uint64 firstDay,
            uint64 lastDay,
            uint64 preparedThrough,
            uint64 reserveCursor,
            uint64 resolveCursor,
            uint64 unwindCursor,
            uint32 liveRecords,
            uint64 openedAt,
            uint64 deadline,
            uint256 chunks,
            uint256 entryCount
        )
    {
        domainKey = LibRewardCustody.domainKey(user, side);
        LibVaipakam.StagingDomain storage dom = LibVaipakam.storageSlot().stagingDomains[domainKey];
        return (
            domainKey,
            uint8(dom.phase),
            dom.firstDay,
            dom.lastDay,
            dom.preparedThrough,
            dom.reserveCursor,
            dom.resolveCursor,
            dom.unwindCursor,
            dom.liveRecords,
            dom.openedAt,
            dom.deadline,
            dom.chunks,
            dom.entryIds.length
        );
    }
}
