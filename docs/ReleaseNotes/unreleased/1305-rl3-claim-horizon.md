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
also explicit: every activation — including a re-activation after a
governance dark reset — re-grants every entry, however stale its clock,
at least 90 days of fresh runway before it can expire, so a dark
interval is never silently counted against dormant claimants. A claim
landing any time before expiry always wins.

Expiry uses the ratified split signals riding the governor's PR-3c
machinery: the fresh-funded share genuinely leaves the fresh budget
(consumes the pool cap) and credits the bucket as ExpiredReward
absorption; the recycled-funded share never left the bucket and releases
its commitment with zero new credit — dormant recycled rewards can never
inflate the absorption average. A claim-center countdown view exposes
each entry's clock start and expiry; the pre-expiry notice rides the
free in-app notification channel per the design (paid push may only be
additional). The governor design's "released only by forfeit — never by
time" sentence gains its ratified superseding note, and functional spec
§4 gains the claim-horizon rules. Closes #1305.
