## A failed or aged-out configuration read no longer pins the whole session

The marketing pages read the published protocol configuration once and then
held whatever that first attempt produced for as long as the tab lived. Both
ways that could go wrong went wrong silently. A transient failure on the
first read pinned the bundled fallback for the entire session, even after the
configuration service recovered — every later page the reader visited kept
the shipped values, honestly labelled but needlessly stale. And a snapshot
accepted just inside the freshness window kept its published label
indefinitely once held, though the same snapshot arriving an hour later would
have been refused as too old.

The read is now retried when the reader gives the page a natural opportunity:
visiting another page, or returning to a tab that was left in the background.
A healthy, fresh snapshot triggers nothing — browsing must not turn into
request traffic — and a page rendering dozens of figures still causes at most
one request. While a re-check is in flight the page keeps stating its
previous conclusion rather than flickering through an in-between state,
because it still has one.

The freshness rule now also applies for as long as a figure is shown, not
only at the moment it arrives. A snapshot that ages past the window while on
display, and that a re-check cannot replace, reverts to the bundled value
with its label following — the same honest fallback a failed first read gets.
Holding a figure the page would refuse to accept, under a label claiming it
is current, was the one remaining way the provenance marker could overclaim.
