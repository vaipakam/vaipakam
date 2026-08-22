## The reward-payout safety gap turned out to be half-closed already (#1566)

A known fund-safety issue has been open since early August: a reward payout is
limited by whatever spare balance the platform happens to be holding, rather
than by the money actually set aside for rewards. That spare balance is not
spare — it also holds two kinds of user collateral, so a reward payout can in
principle be paid out of a borrower's collateral.

Re-reading that issue against the platform as it stands today changed the
picture, though not as cleanly as a first pass suggested. Separate work two days
earlier had already limited part of it: on a chain that RECEIVES its reward
funding, a payout for a day inside the new programme is limited to what actually
arrived. That leaves more open than a first pass suggested, not less: the chain rewards
originate on, where nothing arrives and so the limit has to be defined rather
than copied across; older entitlements on the receiving chains, which are paid by
a route the new limit never sees and never records, so a single person holding
both kinds can spend twice against one balance; and a chain that has been
detached from the group, which ends up limited by nothing at all because it is
no longer recognised as either kind.

That distinction is now written down, along with why the obvious repair — keep a
list of everything else the balance is holding and subtract it — is the one
approach with evidence against it here. The list grew in every review round it
was declared finished, two of its members are invisible to that repair by
construction, and an attempt at it was reverted for creating a fresh way to lose
user value: it left expiry clocks running on entitlements whose claims had begun
to fail.

Four options are set out with what each promises a claimant, and the choice is
left to the owner rather than made in passing. Three of them keep the money in
one shared pot and differ only in how carefully they reason about who owns what;
the fourth keeps the reward money somewhere else entirely, so the question of who
owns a given token stops arising. That fourth one is the largest change and the
only one that removes the problem rather than tracking it — and it was missing
from the first drafts because the search was for a better way to count, not for
a different arrangement. A first draft of this note did
recommend one of them as a cheap first step; review established that it does not
actually set any money aside — it limits what a day may price, which is a
different question — so the recommendation was withdrawn rather than softened.
A note on a fund-safety question whose recommended step leaves the property
unmet is worse than one that recommends nothing. The reward programme stays
un-armed until this closes, which is unchanged and deliberate.
