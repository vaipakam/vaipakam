### A lender's Full-tariff opt-in now counts when a keeper matches their offer

The Full tariff is a fee a party opts into on their own offer, in exchange for
a deeper discount on their own side's fees. Until now that opt-in was honoured
on a direct acceptance but quietly ignored when a keeper matched two standing
offers against each other.

The reason is a detail of how a match executes: it fills the borrower's offer,
so the lender's own offer — the only place their authorization lives — was
never consulted. The lender was resolved as not having opted in at all,
so they were neither charged the tariff nor told their authorization had been
declined. No wrong charge ever occurred and the feature is off in production,
which is why this was safe to leave open, but it made the tariff a party pays
depend on which route happened to fill their offer rather than on what they
signed.

A match now carries the lender's offer through to where the tariff is priced,
so both sides are resolved from the artifact each of them actually signed.
A lender who opted in is charged exactly as on a direct acceptance; a lender
who opted into nothing is charged nothing, whatever the counterparty did.

There is a second half to "honoured whichever venue fills it", and review
caught that the first version only did the first half. When the feature is
switched off — which is how it ships today, and permanently so on chains that
do not host the token — a lender who opted in and refused a downgrade has said
"charge me or do not open this loan". A direct acceptance of that offer
correctly refuses to open. A matched fill did not: the decision about whether
to price the fee at all still looked only at the borrower's offer, so it
skipped the step entirely and opened the loan un-priced. The guarantee was
venue-dependent in exactly the configuration that ships. That decision now
consults the lender's offer too, so both venues refuse alike — and a lender
who *did* permit a downgrade still gets their loan opened, un-priced, as they
asked.

The carried reference cannot outlive its match. Two independent guards stop
it: the substitution is permitted only while a match is in progress, and that
flag has a single clearing point, while the reference itself is cleared beside
it. Removing either alone leaves the other holding — confirmed by removing
each in turn and watching the behaviour stay correct, then removing both and
watching a later unrelated acceptance charge a lender who had authorized
nothing.

Closes #1369. Part of the #1349 recycling-completion programme.
