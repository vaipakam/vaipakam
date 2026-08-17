## Events that name a loan or an offer can no longer be filed without that name attached

The activity ledger stores, alongside each recorded event, which loan and which
offer it concerns. Those two references are what the per-loan and per-offer
history views filter on. They are filled in by a lookup keyed on the event's
name — and an event missing from that lookup is filed with both references
blank.

Nothing about that looks broken. The row is written, the general activity feed
shows it, no check complains. What silently stops working is the per-loan view,
which cannot find the row at all. The only way to notice is to go looking for
that particular event under that particular loan.

This was found the hard way: a review caught one such event, the announcement
added last week specifically so that a status change could be observed — filed
with no loan attached, and therefore invisible in exactly the place it was
introduced to be visible. Measuring the rest turned up **forty-nine** more
event-and-reference pairs in the same state, several of them things a user would
plainly expect on a loan's history: a lender selling their position, a borrower
closing early, collateral added or released, a health-factor liquidation, an
obligation handed to a replacement borrower. One is sharper still — an
offer-closing event that the indexer *does* handle correctly, so the offer's own
record is right while its audit trail cannot find the event that closed it.

A new check now enumerates this from the compiled contract interfaces rather
than from a maintained list, and fails when an event carrying a loan or offer
reference neither files it nor is listed as deliberately unfiled with a stated
reason. It checks each reference separately, because an event can attach one and
drop the other. It also flags entries in that list that have gone stale — an
event since fixed, or one that no longer exists — since a list that quietly
outlives its subject re-opens the hole it documented.

The forty-nine known gaps are listed rather than fixed here, and they are marked
as gaps rather than as decisions. That distinction is the point: writing "this
is deliberate" next to forty-nine real omissions would bury them behind the word
and satisfy the check forever. Each is tagged so the whole backlog can be listed
with a single search, and closing them means moving entries out of that list a
few at a time, each with the behaviour change and its own review. Only four
entries are genuine decisions — companion records whose primary event already
carries the reference, and two internal accounting breadcrumbs — and those are
stated as such.

Worth noting what this check is not. There is an existing check asking whether
an event updates the tables the platform projects. This asks whether an event
can be *found* by the loan or offer it belongs to. An event can legitimately do
the first and not the second, so the reasons from one list were not carried over
to the other; each was decided again on its own terms.
