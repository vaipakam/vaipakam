# RL-4 — Recycled-stream allocation register (dormant keeper carve)

The recycling governor gained its allocation register: at each day
finalization on the canonical chain, the platform can now carve a
bounded keeper-incentive share out of that day's recycled margin. The
register ships **dormant** — the keeper weight defaults to zero, and
until governance sets it, day finalization behaves exactly as before.

When armed, the split is doubly bounded. It never exceeds the day's
realized margin (the trailing absorption average times the margin
weight actually stamped for that day), and it never draws the recycle
bucket below a forward reserve of seven days of the trailing average —
so a register split can never defund near-term recycled reward budgets.
The keeper share is earmarked within the recycle bucket (a keeper-budget
ledger) rather than moved out of it: the bucket's custody total is
unchanged at split time, so the protocol's standing backing invariant
keeps the keeper budget fully backed, and the earmark is netted out of
the fundable balance so a carved share can never be re-sized into a later
day's reward budget (no token transfer at split time), the weight is
capped at
half, and every split emits a public event so indexers can replay the
register from events alone. Spend paths for the accumulated keeper
budget arrive with a later ratified stage.
