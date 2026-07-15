## Thread — push-hint sizing telemetry, ahead of the HINT_CAP retune (PR #TBD)

The scoped push-hint feature caps how many affected loan/offer ids one
indexer scan advertises in a refresh frame (`HINT_CAP`, currently 32) —
a conservative launch value chosen without traffic data. Retuning it
needs to know how big real scans actually get, which needs real load on
the testnet that doesn't exist yet.

This change adds the measurement rail so that data is captured the
moment load arrives: each indexer scan that touches anything now emits
one structured `hint-telemetry` log line with the true (pre-cap) id
counts and a breakdown of why a frame would truncate — by size versus
by the signed-order / ownership-transfer events that truncate for
reasons a bigger cap wouldn't fix. A short procedure doc explains how
to collect the stream during a rehearsal-load window and read the
distribution to pick the cap.

No client-visible behaviour changes and no cap change yet: the hint
payload, the truncation-honest contract, and the current cap are all
untouched. The actual number-pick is a one-line follow-up once
rehearsal load produces busy frames to measure.

Refs #1245.
