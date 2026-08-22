## The reward-payout safety gap turned out to be half-closed already (#1566)

A known fund-safety issue has been open since early August: a reward payout is
limited by whatever spare balance the platform happens to be holding, rather
than by the money actually set aside for rewards. That spare balance is not
spare — it also holds two kinds of user collateral, so a reward payout can in
principle be paid out of a borrower's collateral.

Re-reading that issue against the platform as it stands today changed the
picture. The cross-chain half of it was closed a fortnight ago by separate work
and nobody had gone back to say so: on any chain that RECEIVES its reward
funding, a payout is already limited to what actually arrived. What remains open
is only the chain rewards originate on, where nothing arrives and so the limit
had to be defined rather than copied across.

That distinction is now written down, along with why the obvious repair — keep a
list of everything else the balance is holding and subtract it — is the one
approach with evidence against it here. The list grew in every review round it
was declared finished, two of its members are invisible to that repair by
construction, and an attempt at it was reverted for creating a fresh way to lose
user value: it left expiry clocks running on entitlements whose claims had begun
to fail.

Three options are set out with what each promises a claimant, and the choice is
left to the owner rather than made in passing. The reward programme stays
un-armed until this closes, which is unchanged and deliberate.
