## Keeper — mirrors kept on Base's tier table

Each governance change to the VPFI discount tiers raises Base's tier-table version. A mirror chain keeps the version it last received, and nothing sent the new version to a mirror unless someone called the broadcast by hand. The keeper's protocol upkeep pass now has an eighth step that does this on Base. It reads Base's version and each mirror's own version from the mirror's RPC, then sends the version to any mirror that is behind.

The lane fee is paid from the keeper key. It is held to its own ceiling, `TIER_VERSION_SYNC_MAX_FEE_WEI`, which defaults to 0.002 of the native token. Once the keeper has sent a version, it allows six hours for the message to arrive before paying again for the same version. A newer version is sent at once. The run's line reports each mirror as current, behind and sent, waiting on a message in flight, ahead of Base, or unread.

The step ships disarmed behind `TIER_VERSION_SYNC_ENABLED`, and it also needs `PROTOCOL_UPKEEP_ENABLED`. The permissionless-steps ledger now records the broadcast as keeper-backed instead of a gap.

Closes #912
