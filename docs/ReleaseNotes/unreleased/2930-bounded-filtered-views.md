## Thread — Every filtered list view is bounded by the rows it reads (PR #TBD)

The platform's filtered list views now all follow one paging rule, the one the
match-eligible loan view already used: a call reads at most the number of rows
the caller asks for, starting from a cursor, and returns the matching rows
among them together with the cursor to resume from. A page can come back empty
while the walk is unfinished; the end is the cursor reaching the end of the
list, never an empty page.

Before, these views took an offset counted in matching rows and walked their
list until a page filled. When few rows matched, one call read the whole list,
and a deep page re-read every row before it. That covered the active offers
by lending asset, the offers compatible with a user's country, a user's loans
by status and offers by state, the four dashboard lists (loans per side, loans
on both sides, offers, claimables), and the whole-history lists of loans and
offers, overall and by status. The per-status and per-user views also reported
a count of all matches, which needed the whole list read on every call; they
no longer report it. The whole-history lists of loans and offers still report
their totals, which cost nothing to read.

The dashboard lists keep their cap of 100 rows per call, now on rows read. The
chain-reading test stub and the custody census page with the new cursor. No
app, indexer, keeper or agent code read any of these views.

This is an interface change, deployed fresh. Closes #2930. Part of #1832 (the
whole-history lists); the lifetime totals that walk every loan remain open
there.
