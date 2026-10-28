## Thread — The VPFI discounts chapter is current and in all ten guide languages (PR #<n>)

The Advanced user guide's "How VPFI Discounts Work" chapter existed only in
English, and the English itself had fallen behind the protocol. It described
the old cross-chain tier push, which made a user's own deposit or withdrawal
fail when the protocol's broadcast budget ran dry, a Dashboard "Push my tier
to mirrors now" button the app no longer has, and a requirement to hold VPFI
on every other chain that the fee path does not apply. Translating it as it
stood would have put those claims into nine more languages.

The chapter is rewritten from the tokenomics specification and then
translated. It now says what the discount reduces (the lender's yield fee at
each interest settlement, the borrower's initiation fee once at acceptance on
a liquid loan), that it comes off the fee in the loan's own asset, that the
switch is per chain and must also be on for Base, how the tier is worked out
(the minimum holding period, the recency-weighted average and the lowest tier
touched, written as three separate checks), and how the tier reaches other
chains: each chain delivered on its own, never failing the user's action, a
lower tier sent at once and a higher one paid for at most once a day. It says
plainly what the app does not offer yet (paying to deliver a tier sooner, or
refreshing a tier that rose with time alone), and that a copy whose tier has
not changed is not resent. The operator notes name today's configuration.

The short "How your VPFI tier travels across chains" section under Buy VPFI,
which repeated the stale claims, now summarises the chapter in all ten
languages and points to it. The anchor-parity check no longer records any
missing chapter.

Closes #1593. Anchoring the chapter's cards in all ten editions is #1597.
