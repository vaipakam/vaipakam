## Thread — events can no longer be filed without the loan or offer they name (PR #1797)

The activity ledger stores, next to each recorded event, which loan and which offer
it concerns; those two references are what the per-loan and per-offer history views
filter on, and they are filled in by a lookup keyed on the event's name. An event
missing from that lookup is filed with both references blank, and nothing looks
broken — the row is written, the general feed shows it, no check complains. What
silently stops working is the per-loan view, which cannot find the row at all. A
review caught one such event last week: the announcement added specifically so that
a status change could be observed, filed with no loan attached, and therefore
invisible in exactly the place it was introduced to be visible.

A new check now derives the expectation from the compiled contract interfaces
rather than from a maintained list, and fails when an event carrying a loan or
offer reference neither files it nor is listed as deliberately unfiled with a
stated reason. It recognises a reference by the shape of its name, including inside
nested structures, so an event that calls one `oldLoanId` or `fields.refinanceTargetLoanId`
is covered without anyone remembering to extend a list; and it checks each
reference separately, since an event can attach one and drop the other. Whether
each filing actually works is then verified by **running the real code**: for
every covered event, the actual lookup is executed against a synthetic decoded
event planted with known ids, and the check passes only when the planted id
comes back out — so a filing that reads the wrong argument, returns a constant,
or only works on some path fails the same way a missing one does. The recording
step is exercised the same way: a synthetic batch must produce exactly one
stored row per event with its references attached. It also flags entries in the
exemption list that have gone stale, because a list that outlives its subject
re-opens the hole it documented. (An earlier iteration of this change tried to
establish the same guarantees by analysing the source code's syntax instead of
running it; review kept finding code shapes the analysis missed, so it was
replaced with the executed form, which has no shapes to miss.)

Measuring the platform this way found **sixty** event-and-reference pairs already
in the blank state, several of them things a user would plainly expect on a loan's
history: a lender selling their position, a borrower closing early, collateral
added or released, a health-factor liquidation, an obligation handed to a
replacement borrower. Those are recorded as tagged gaps rather than as decisions,
so the whole backlog is listable with one search and each closes with its own
behaviour change and review — writing "this is deliberate" beside sixty real
omissions would satisfy the check forever. Only six entries are genuine decisions.
Four of the sixty pairs, one on each of four events, are left deliberately
unresolved because they raise product questions rather than needing a mechanical
fix: a refinance and both halves of the offset route each involve two loans against
a single column, so which one the row belongs to is a choice; and an offer's
refinance-target loan may or may not belong on that loan's timeline at all. Each of
those four says so in its own entry, so the reason travels with the gap. The
tracking issue **#1794** stays open for the sixty mappings; this change is the
guardrail that stops the list growing silently.
