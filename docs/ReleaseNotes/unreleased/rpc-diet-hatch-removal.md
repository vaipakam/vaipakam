# Signal-gated freshness graduates: the legacy-timers hatch is removed

The read-diet rollout shipped with a build-time escape hatch that
could pin the connected app back to its old fixed-timer refresh
behaviour without touching the server side. The design gated the
hatch's removal on a live post-deploy review: pushed updates observed
end to end on the deployed testnet, including a position NFT changing
hands and the new holder's claim surfacing from the live signals.
That review passed, so the hatch is gone.

Nothing changes for users. The rail-down fallback — plain polling at
the old cadence whenever the push rail cannot prove itself — remains
the permanent safety net; it is the same posture the hatch pinned,
reachable automatically instead of via a build flag.
