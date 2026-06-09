// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";

/**
 * @title MirrorTierReceiverFacet — T-087 Sub 2.C
 *
 * Mirror-side Diamond ingress for the cross-chain tier push that
 * `VaipakamRewardMessenger` decodes on inbound. This facet OWNS THE
 * WRITE PATH into `s.userTierCache[user]` + `s.currentTierTableVersion`;
 * the existing Sub 1.C `LibVPFIDiscount._mirrorEffectiveTierAndBps`
 * read path (with its four freshness gates) reads what this facet
 * writes.
 *
 * Trust:
 *   - Sender check: `msg.sender == s.rewardMessenger`. The messenger
 *     contract has already authenticated the CCIP source + channel
 *     peer + payload-size shape; this facet trusts what the messenger
 *     hands over.
 *   - Source-chain check: `srcChainId == s.baseChainId`. Catches the
 *     "wrong-source-chain" misconfig the design's round-4 P1 #4 + Sub
 *     2.C card both surface (mirror must only accept pushes from
 *     Base, not from another mirror).
 *   - Monotonic ordering: `nonce > cache.lastNonce`. Catches replays
 *     and out-of-order delivery before the cache is mutated.
 *
 * Both functions are external (the messenger contract is OUTSIDE the
 * Diamond, so a fallback-routed call is the only way in).
 */
contract MirrorTierReceiverFacet {
    // ─── Events ─────────────────────────────────────────────────────────

    /// @custom:event-category state-change/mirror-tier-cache
    /// @notice T-087 Sub 2.C — cache write landed for `user`.
    event MirrorTierCacheWritten(
        address indexed user,
        uint256 indexed sourceChainId,
        uint8 effectiveTier,
        uint16 effectiveBps,
        uint64 nonce,
        uint16 tierTableVersion
    );

    /// @custom:event-category state-change/mirror-tier-cache
    /// @notice T-087 Sub 2.C — mirror's `currentTierTableVersion` rose.
    event MirrorTierTableVersionBumped(
        uint256 indexed sourceChainId,
        uint16 oldVersion,
        uint16 newVersion
    );

    // ─── Errors ─────────────────────────────────────────────────────────

    /// @notice The caller is not the configured CCIP messenger.
    error NotMessenger(address caller);
    /// @notice The push arrived from a chain that is not Base.
    error WrongSourceChain(uint256 got, uint32 expected);
    /// @notice The push's nonce is not strictly greater than the
    ///         cached `lastNonce` — stale or replay.
    error StaleNonce(uint64 got, uint64 cached);
    /// @notice The push's nonce does not fit a `uint64`; either an
    ///         operator misconfig on Base produced an oversized
    ///         nonce, or a malicious payload was forged. Reject
    ///         rather than silently truncate.
    error NonceOverflow(uint256 got);

    // ─── Receive surface ────────────────────────────────────────────────

    /// @notice Called by `VaipakamRewardMessenger.onCrossChainMessage`
    ///         on inbound `MSG_TYPE_TIER_UPDATED`. Validates trust +
    ///         monotonic order, then writes the cache + the
    ///         observation timestamp.
    /// @param  sourceChainId   The CCIP source chain id (must be Base).
    /// @param  user            The user whose tier was pushed.
    /// @param  effectiveTier   Post-gate tier (Base accumulator output).
    /// @param  effectiveBps    Post-gate BPS.
    /// @param  /* computedAt */ Base's `block.timestamp` at push (unused
    ///         on mirror — `lastUpdateSec` uses local time so the
    ///         `cfgMirrorTierMaxAgeSec` backstop is local-clock based).
    /// @param  nonce           Strictly-increasing per-user push counter
    ///                         on Base; mirror rejects `<=` cached.
    /// @param  tierExpirySec   Projected expiry (sentinel today; Sub 2.A
    ///                         documented why).
    /// @param  tierTableVersion Base's table version at push time.
    function onTierUpdateReceived(
        uint256 sourceChainId,
        address user,
        uint8 effectiveTier,
        uint16 effectiveBps,
        uint40 /* computedAt */,
        uint256 nonce,
        uint40 tierExpirySec,
        uint16 tierTableVersion
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertMessenger(s);
        _assertSourceChain(s, sourceChainId);

        if (nonce > type(uint64).max) revert NonceOverflow(nonce);
        uint64 nonce64 = uint64(nonce);

        LibVaipakam.CachedTier storage cache = s.userTierCache[user];
        if (nonce64 <= cache.lastNonce) {
            revert StaleNonce(nonce64, cache.lastNonce);
        }

        cache.effectiveTier = effectiveTier;
        cache.lastUpdateSec = uint40(block.timestamp);
        cache.lastNonce = nonce64;
        cache.tierExpirySec = tierExpirySec;
        cache.tierTableVersion = tierTableVersion;
        cache.effectiveBps = effectiveBps;

        emit MirrorTierCacheWritten(
            user,
            sourceChainId,
            effectiveTier,
            effectiveBps,
            nonce64,
            tierTableVersion
        );

        // Codex Sub 2.C round-1 P2 — also raise this mirror's
        // `currentTierTableVersion` when the incoming push carries a
        // newer version than we have observed. The Sub 1.C read path
        // returns tier 0 unless `cache.tierTableVersion ==
        // s.currentTierTableVersion`, so without this raise an
        // out-of-order delivery (TierUpdated arriving BEFORE its
        // companion VersionBumped, or the VersionBumped being missed
        // / re-executed later) would write a cache entry that the
        // freshness gate immediately rejects. The TierUpdated payload
        // ITSELF carries the authoritative version stamp on Base, so
        // honouring it here closes the gap without needing the
        // separate VersionBumped message to arrive first.
        uint16 currentVersion = s.currentTierTableVersion;
        if (tierTableVersion > currentVersion) {
            s.currentTierTableVersion = tierTableVersion;
            emit MirrorTierTableVersionBumped(
                sourceChainId, currentVersion, tierTableVersion
            );
        }
    }

    /// @notice Called by `VaipakamRewardMessenger.onCrossChainMessage`
    ///         on inbound `MSG_TYPE_VERSION_BUMPED`. Raises the mirror's
    ///         `currentTierTableVersion` only — write is a monotonic
    ///         max so out-of-order delivery is benign.
    function onVersionBumpedReceived(uint256 sourceChainId, uint16 newVersion)
        external
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertMessenger(s);
        _assertSourceChain(s, sourceChainId);

        uint16 current = s.currentTierTableVersion;
        if (newVersion <= current) return; // benign no-op
        s.currentTierTableVersion = newVersion;
        emit MirrorTierTableVersionBumped(sourceChainId, current, newVersion);
    }

    // ─── Read surface ──────────────────────────────────────────────────

    /// @notice T-087 Sub 2.C — read the full cached tier struct for
    ///         `user`. Used by off-chain monitoring + tests; the live
    ///         fee-path read is already wired through Sub 1.C's
    ///         `_mirrorEffectiveTierAndBps` (which applies the four
    ///         freshness gates).
    /// @dev    Public — reading a cache snapshot has no security posture.
    function getUserTierCache(address user)
        external
        view
        returns (LibVaipakam.CachedTier memory)
    {
        return LibVaipakam.storageSlot().userTierCache[user];
    }

    /// @notice T-087 Sub 2.C — read the mirror's current tier-table
    ///         version. Off-chain consumers compare this to Base's
    ///         `tierTableVersion` to detect "behind by version" state.
    function getCurrentTierTableVersion() external view returns (uint16) {
        return LibVaipakam.storageSlot().currentTierTableVersion;
    }

    // ─── Private guards ────────────────────────────────────────────────

    function _assertMessenger(LibVaipakam.Storage storage s) private view {
        if (msg.sender != s.rewardMessenger) {
            revert NotMessenger(msg.sender);
        }
    }

    function _assertSourceChain(
        LibVaipakam.Storage storage s,
        uint256 sourceChainId
    ) private view {
        if (sourceChainId != s.baseChainId) {
            revert WrongSourceChain(sourceChainId, s.baseChainId);
        }
    }
}
