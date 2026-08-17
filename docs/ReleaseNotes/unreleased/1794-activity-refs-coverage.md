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
introduced to be visible. Measuring the rest turned up **fifty-nine** more
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

The fifty-nine known gaps are listed rather than fixed here, and they are marked
as gaps rather than as decisions. That distinction is the point: writing "this
is deliberate" next to fifty-nine real omissions would bury them behind the word
and satisfy the check forever. Each is tagged so the whole backlog can be listed
with a single search, and closing them means moving entries out of that list a
few at a time, each with the behaviour change and its own review. Only six
entries are genuine decisions — three companion records whose primary event
already carries the reference, and three internal accounting breadcrumbs — and
those are stated as such.

Worth noting what this check is not. There is an existing check asking whether
an event updates the tables the platform projects. This asks whether an event
can be *found* by the loan or offer it belongs to. An event can legitimately do
the first and not the second, so the reasons from one list were not carried over
to the other; each was decided again on its own terms.

Two refinements came out of review, both about the check being able to establish
what it claims. It had been reading every interface file in the folder, including
two standalone components the platform never routes through its main entry point
— so two of the "gaps" were phantoms that no recorded event could ever have
matched, and the phantom list would have grown with every future standalone
component. The enforced set is now exactly the set the reader can actually
decode.

And the check could be satisfied by a comment. Its test for "is this reference
filled in" scanned the whole block, so a mapping left commented out during a
refactor, sitting above a live line that fills in nothing, read as filled in —
the regression it exists to catch would have passed. Comments are now stripped
before the test, and the test looks only at what the lookup actually returns.
Both were verified by reproducing the failure first: the commented-out case is
now correctly reported as a gap, and the phantom entries are now correctly
reported as stale.

A third refinement widened the check's reach, and a fourth changed how that reach
is decided — which is the more useful of the two to record, because the third one
was not enough.

The scope had been defined by whether an announcement happened to name its
references with the exact same words the ledger's columns use. Where an
announcement used a different name — one naming a lender's offer specifically,
another naming the loan before and after a refinance — the reference was either
unguarded despite being filed correctly, or the announcement sat outside the check
altogether. The first fix was a written list of the alternative names each column
accepts. Review then found the next batch of names missing from that list: the
three legs of an internal three-way match, both halves of the offset close-out
route, and three more offer names. One of those was a deliberate, working entry
that the check was not protecting.

So the list was the wrong instrument, and the second fix removed it. A name is now
recognised by its shape — a qualifier, the column's own name, an optional leg
marker — so any announcement naming its reference that way is in scope the moment
it is added, without anyone remembering to extend a list. The check prints the
names it resolved, because a derivation is only reviewable if what it caught is
visible; and the one thing shape cannot catch — a reference named without the
column in it at all — has a stated escape hatch, empty today, so such a case is
recorded rather than invisible. Widening the reach this way brought three more
announcements and eight more reference pairs into the count, including two halves
of the offset route that had never been in scope.

Two further refinements close ways the check could report success about its own
inputs. It read the platform's combined interface by following each of its parts
back to a file, and quietly skipped any part it could not follow — so losing one
component left the check green while every announcement in that component
silently left coverage. It now fails on any part it cannot resolve, rather than
only when it can resolve none of them.

And the test for "is this reference filled in" accepted any expression that was
not the literal word for nothing. So a misspelled reference name, or one guarded
by a fallback that yields nothing, read as filled in while every row was written
blank — the exact state the check exists to detect, passing green. An expression
must now unconditionally read one of the names that announcement actually carries,
and one that can yield nothing is reported rather than accepted.

One widened-scope gap is left open rather than closed here, for a reason worth
recording: a refinance leaves two loans — the one being left and the one taken on
— and the ledger has a single column for the loan. Filing it against either is
defensible, so the choice belongs to whoever makes it deliberately, not to a
mechanical fix made in passing. The offset route poses the same question twice
over and is left the same way.
