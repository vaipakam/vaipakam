## Thread — P2-w2: the compensation remit classifies at the mirror, and quarantined value is reserved (PR #1634)

Second build slice of the #1434 P2 zeroed-day lapse mechanisms (design
§1.3, §2.2, §4.1 — slice 2 of §8), and the slice the halt lift is
sequenced behind. The manual-compensation remit now travels on its own
wire shape: a new tagged payload carrying exactly one zeroed day, the
authenticated per-side amounts (the operator sizes lender and borrower
separately — a single scalar would leave the mirror solving for a side),
and the day's frozen expiry inputs read back from the finalization-time
freeze, so the mirror can classify the arrival even when the compensation
overtakes the day's own broadcast. Ordinary batch remits keep the
existing wire unchanged.

Mirror-side, a new classifying ingress replaces blind booking for
compensation deliveries. Era first: a day whose broadcast state is known
accepts the compensation only from the deployment matching the day's
recorded era, only if the day was genuinely zeroed out of its finalized
denominator, and only before any lapse; every other arrival is
QUARANTINED token-safely — the tokens are accepted into a new
arrival reservation (never reverted: a revert would be re-executable into
the same revert forever) with a receipt-keyed record naming why, awaiting
the return path a later slice adds. A day whose state is unknown — the
overtake case — credits PROVISIONALLY under the payload's authenticated
sender as the assumed era; the day's broadcast later confirms the credit
in place or demotes it wholesale to the reservation, moving the
armed-fresh counting with it so the funding reconciliation identity
survives.

The reservation is the claim exclusion the halt lift requires: the single
backing definition both claim-enforcement sites read now subtracts it, so
an ordinary fresh claim can no longer spend quarantined tokens that are
promised back to the canonical chain. The transparency snapshot publishes
the reservation, and the mesh watcher gains a matching critical check —
balance must cover bucket plus reservation — with the standing
skip-on-unknown discipline for chains whose lens predates the widened
snapshot shape.

The review rounds pulled the dispatch cutoff INTO this slice: because
the mirror now evaluates expiry directly from the frozen clock words,
"no arrival can lapse before the terminals ship" stopped being true — so
the canonical chain refuses to dispatch a compensation within the
cutoff gap of the day's frozen expiry, and refuses clockless days
outright (they can never settle; pre-clock days belong to the later
legacy migration). The post-lapse quarantine branch driven by the
terminal FLAGS exists now but stays unreachable until the terminals
arm; the clock-based expiry quarantine is live. Part of #1434 (P2);
umbrella #1349.
