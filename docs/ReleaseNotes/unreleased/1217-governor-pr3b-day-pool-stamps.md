## Thread — Recycling governor PR-3b: absorption-coupled day-pool stamps (PR #TBD)

Second on-chain stage of the ratified recycling balance governor
(#1217/#1222 §3.1), on top of PR-3a's bucket ledger. Every day
finalization now computes and stamps, write-once, the day's intended
pool composition: the pre-funded schedule floor (capped by remaining
fresh availability) plus the absorption-coupled recycled budget — the
trailing seven-day average of bucket credits, less the retained margin,
capped by what the bucket can actually fund. The trailing average always
divides by the full window (zero-padded, never by elapsed days) so a
launch spike can't contribute more than once; the margin is read once at
finalization and stamped with the day, so a governance retune never
rewrites finalized economics; and a day with no emission schedule stamps
a zero recycled budget too — recycling never makes otherwise-unrewarded
activity rewardable. When the fresh pre-fund exhausts, the floor goes to
zero and the recycled term carries the pool alone: the promised steady
state, now visible per-day on-chain.

Commitment reservation ships dark by design: the stamps are records (two
new transparency reads expose them and the outstanding-commitment state)
until the next stage's distribution-coupling cutover arms reservation
atomically with consume-at-claim — reserving without a consumption path
would silently collapse future availability, so the arming day is a
single storage field the cutover sets. Seven new tests pin the ratified
formula on the real finalization path, the zero-padding rule, both
clamps, the stamp's immutability under a margin retune, exhaustion
steady-state, and the arming gate in both directions. Functional spec §9
gains the day-pool stamp rules. Part of the #1217 Phase A′ stack.
