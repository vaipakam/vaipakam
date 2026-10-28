## Thread — Foundry pinned on every CI job, and three recorded owner decisions (PR #2998)

The release gate and the three end-to-end workflows installed whatever
Foundry release was current upstream, so the compiler that gates a
mainnet release could change without any commit in this repository. They
are now pinned to Foundry v1.8.6, the version that ran the last green
sharded full regression and every recent end-to-end run. No CI job floats
any more: the fast contracts lane and the static-analysis job stay on
v1.8.3 for the compile-reuse reason already recorded, the docs jobs stay
on v1.7.1, and a toolchain bump is now a reviewed commit that moves the
release gate and the end-to-end workflows together.

Release-note fragments now have a stated length that matches practice:
at most about six short paragraphs, with longer reasoning in a linked
design doc, and "Closes" written only when a pull request closes an issue.
The template, the procedures handbook and the agent guide say the same
thing.

The spec audit's NFT-rental daily-fee row is recorded as satisfied: the
app that mis-scaled the fee was deleted, and the remaining app scales it by
the token's decimals. The procedures handbook gains the two sweep habits
for retiring a claim across every document that states it.

Closes #1984, #1799, #2533 and #2189.

> Caveat: the pinned Foundry versions do not update themselves; a newer release reaches CI only through a pull request that changes the pins.
