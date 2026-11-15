## Thread — Auto-lend end date and pro-rata opt-in (PR #3644)

A standing lender intent (Auto-lend) can now carry two more lender choices, set
in the same call that sets its other bounds and stated in its set event, its
read view and the keeper discovery feed.

**Lend-until time.** For money free only for a fixed window, the lender may set
an end time. A fill is admitted only when the loan's agreed maturity (now plus
the borrower's term) falls at or before it, so as the window runs down only
shorter loans fit. A repaid loan is rolled back behind the intent only while a
one-day loan could still fit; after that the roll is refused and the proceeds
take the normal lender claim back to the lender's vault, and the keeper
discovery feed stops listing the intent, since it can fill nothing more. The end
time must leave room for a one-day loan counted from when the newly set terms
may first be filled. Nothing moves when the time passes: un-lent capital stays reserved until the lender withdraws it or sets
a new date. The time bounds agreed maturity only. Late repayment in grace, a
default and a protocol pause can all end a loan after it, so the app must never
say funds return by that date.

**Pro-rata opt-in.** By default an intent still fills only full-term, full-repay
requests. Opted in, it also fills pro-rata requests, including ones that allow
partial repayment, and each loan carries the borrower's chosen mode. A partial
repayment is paid to the lender position's holder exactly as on any loan; it is
not re-committed behind the intent, and the exposure cap keeps counting the
original fill until the loan closes. A later roll re-commits only what the final
repayment measured into the vault, never the original fill. The backstop and the
aggregator adapters keep both choices off.

One shared rule (a new library) decides fills, previews, rolls and both feeds,
so they cannot disagree; the preview gains a "past lend-until" reason. No
fund-moving path changed: the new rules only refuse a fill or a roll. The two
keeper discovery feeds moved from the metrics facet, which had reached its size
limit, to the lender-intent facet beside the per-owner intent list; their
selectors are unchanged. The function signature, struct and event change, so
this reaches a chain by fresh deploy. Design:
`docs/DesignsAndPlans/AutoLendLendUntilDesign.md`.

Closes #3618. Closes #3619.

The keeper's intent pre-filter applies the same pro-rata rule, so the matching service tries a pro-rata request against an opted-in intent. The borrower page's standing lenders count each lender's end date and pro-rata opt-in.

> Caveat: the lender's setup form for the two choices is a follow-up in its own thread.
