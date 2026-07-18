## Thread — RL-3: post-claimability reward claim horizon (PR #TBD)

Third ratified delta of the recycling loop-closure design. Once
governance sets the bounded horizon knob (default 365 days, never below
180; dark until set), a reward that has been fully claimable for the
horizon becomes sweepable into the recycle bucket by a permissionless
keeper call — closing the unbounded liability tail of dormant claimants
the design flagged, with the dYdX epoch-sweep precedent.

The clock is per entry and starts only when the sweep first observes the
entry claimable: it never runs while a claim is blocked on finalization
or broadcast (a cross-chain delay can't eat a user's window), and it
cannot start before feature activation, so every pre-existing dormant
entry gets at least one full horizon of runway after arming —
grandfathering by construction. The ratified 90-day notice floor is
also explicit: every non-zero configuration — first activation,
re-activation after a governance dark reset, and any retune including
a shortening — re-grants every entry, however stale its clock, at
least 90 days of fresh runway before it can expire, so neither a dark
interval nor a horizon shortening is ever silently counted against
dormant claimants. The protected floor is the funded 90-day final
notice, not the main horizon: an entry is removed only after a
contiguous 90-day window counted solely from moments the reward is
provably claim-executable — the amount a claim would really pay (fresh
capped to remaining pool capacity, plus recycled) is non-zero, covered
by local funding, and the owner unsanctioned. The horizon clock starts
only from the first claim-executable moment (an outage or a sanction at
first-claimability never anchors it early), and the H-day main horizon
is coarse wall-clock grace before that final-notice clock can begin —
so an entry blocked for part or all of the main horizon still gets its
full funded final notice from the first moment it is both due and
claim-executable. Expiry is two-phase: past the horizon, a funded sweep
touch first arms a public final-notice window, and removal happens no
earlier than 90 days after that funded arming — every removal follows a
funded last call, even when an outage straddled the horizon instant. A
sanctioned owner cannot claim, so their entries'
clocks stay frozen and can never be swept while flagged (a delist
re-opens the clock — freeze, not seize). And any funded arming is
invalidated when a later touch finds the entry unpayable or sanctioned,
or when governance reconfigures the horizon: the next payable touch
re-arms and the 90-day final notice re-counts, so a stale arm can never
spring an expiry the moment the entry becomes payable again. A claim
landing any time before expiry always wins.

The lifecycle is fully observable: reward-entry ids are enumerable
per user, the clock start and the expiry each emit a public per-entry
signal (the notification pipeline schedules the free pre-expiry notice
from indexed events alone), and an entry whose fresh share cannot be
credited at expiry — the fresh budget fully exhausted — is deferred,
never processed with its value silently burned.

Expiry uses the ratified split signals riding the governor's PR-3c
machinery: the fresh-funded share genuinely leaves the fresh budget
(consumes the pool cap) and credits the bucket as ExpiredReward
absorption; the recycled-funded share never left the bucket and releases
its commitment with zero new credit — dormant recycled rewards can never
inflate the absorption average. A claim-center countdown view exposes
each entry's clock start and its earliest terminal-removal time — for an
entry not yet in its final notice the view reports the horizon-due time
plus the full 90-day notice (never the bare horizon-due time, which the
sweep can only arm at, never expire), so the countdown never understates
how long a claimant has; the pre-expiry notice rides the
free in-app notification channel per the design (paid push may only be
additional). The governor design's "released only by forfeit — never by
time" sentence gains its ratified superseding note, and functional spec
§4 gains the claim-horizon rules. Closes #1305.
