## Thread — two facet splits for contract size room (PR #<n>)

Two facets had come close to the 24 KB size limit every contract on the
chain must stay under, which left no room for the next change to either.
Each has had one self-contained part moved into a new facet of its own.
Nothing a user, keeper or app does changes: every function keeps its name,
its inputs and its answers, every event and error keeps its identity, and no
stored data moves.

The sale reads move from the risk preview facet to a new sale admission
facet: the check of whether a loan may take a new lender by sale, the quote
of the bounds a sale listing would record for the seller, and the read of
the bounds a standing listing did record. The backstop's second role, where
treasury capital buys a defaulted position as liquidator of last resort,
moves its governance (the per-pair cap, seeding and withdrawing the cash it
uses, sweeping the collateral it holds, releasing its exposure, its own
switch and its per-pair read) from the backstop facet to a new backstop
absorb facet.

Each pair must be refreshed together, because the sale paths reach the
admission check across a facet boundary and both backstop facets govern the
same backstop vault. The curated refresh scripts that already carried the
risk preview facet now carry the sale admission facet too, and move its
three reads onto it on a Diamond cut before the split.

Apps and services that read the three sale functions through the risk
preview facet's own ABI file must use the new facet's file or the combined
Diamond ABI.

Closes #3843
