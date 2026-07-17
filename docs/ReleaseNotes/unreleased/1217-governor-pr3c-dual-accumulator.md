## Thread — Recycling governor PR-3c: distribution coupling — dual accumulator + consume-at-claim (PR #TBD)

The stage that closes the governor's loop end-to-end: claims now actually
pay from the absorption-coupled budgets the day-pool stamps size. From an
admin-armed cutover day forward (one-shot, strictly future, and shipped
in-band with every day broadcast so mirrors arm on the identical day with
zero operator drift), each finalized day's claim math prices against the
stamped schedule floor plus recycled budget instead of the raw emission
schedule. Claims spanning the cutover slice exactly — pre-cutover days
pay schedule-only — and the per-user daily cap applies to the combined
value first with the trim apportioned pro-rata across sources, so capping
never changes a user's total.

Consumption is source-split everywhere the pool pays out. A claim's fresh
component consumes the 69M pre-fund and retires its day's fresh
commitment; its recycled component debits the recycle bucket at claim
time and retires the recycled commitment — and at fresh exhaustion the
recycled term keeps paying, the design's promised steady state. A
forfeited reward splits the same way: the fresh share credits the bucket
as genuine absorption while the recycled share is released with zero new
credit (it never left the bucket, and crediting it would inflate the
absorption average while absorbing nothing). Cross-chain remittances
decompose identically, with the per-chain funding split mirroring the
claim-side split so funding and claims cannot diverge.

The day broadcast grows from five to eight words, carrying the pool
composition halves and the arming day; mirrors store them verbatim and a
post-cutover day whose composition hasn't arrived halts claims for that
day fail-closed rather than pricing from the wrong pool. The retired
four-parameter broadcast ingress selector is wired for removal on the
next facet redeploy. Six new end-to-end tests pin the split, the
forfeit-release rule, the exhaustion steady state, cutover slicing, the
mirror composition store, and the arming guards. Functional spec §9 gains
the distribution-coupling rules. Part of #1217; unblocks RL-3 (#1305)
and RL-4 (#1306).
