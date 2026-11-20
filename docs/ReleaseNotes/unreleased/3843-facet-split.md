## Thread — three facet splits for contract size room (PR #<n>)

Two facets had come close to the 24 KB size limit every contract on the
chain must stay under, which left no room for the next change to either.
Self-contained parts of them have moved into three new facets. Nothing a
user, keeper or app does changes: every function keeps its name, its inputs
and its answers, every event and error keeps its identity, and no stored data
moves.

The sale reads move from the risk preview facet to a new sale admission
facet: the check of whether a loan may take a new lender by sale, the quote
of the bounds a sale listing would record for the seller, and the read of
the bounds a standing listing did record. The preview of a standing-intent
fill (the read a keeper makes before filling an Auto-lend slot, which says
whether the fill would succeed and, if not, the first reason it would fail)
moves from the same facet to a new intent preview facet, taking the shared
matching rules it runs with it. The rule for who is checked when two offers
are matched, which that preview shares with the match check and the match
preview that stay behind, is now written once and used by both facets. The
backstop's second role, where treasury capital buys a defaulted position as
liquidator of last resort, moves its governance (the per-pair cap, seeding
and withdrawing the cash it uses, sweeping the collateral it holds,
releasing its exposure, its own switch and its per-pair read) from the
backstop facet to a new backstop absorb facet.

Each group must be refreshed together: the sale paths reach the admission
check across a facet boundary, the intent preview reaches the risk bounds on
the risk preview facet the same way the other matching facets do, and both
backstop facets govern the same backstop vault. The curated refresh scripts
that already carried the risk preview facet now carry the sale admission and
intent preview facets too, and move their functions onto them on a Diamond
cut before the split.

Apps and services that read the three sale functions or the intent preview
through the risk preview facet's own ABI file must use the new facets' files
or the combined Diamond ABI.

Closes #3843
