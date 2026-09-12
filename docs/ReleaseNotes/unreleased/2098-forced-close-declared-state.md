## Thread — the forced close-out card states its decision and the block it was made at (PR #2148)

Closes #2098. Also delivers #2131.

The lender's forced close-out card renders a decision — closable, not
yet, blocked, still checking — resolved from live chain reads. Until
now it said so only in prose, and it did not say when. A reader with
developer tools, and the live review drive, had to recover the state
from the wording and could not tell which block the facts behind it
came from. On a surface that touches funds, "as of which block" is part
of what the card knows, and the standing rule is that such a surface
states what it knows.

The card now carries two machine-readable attributes beside its text:
the resolver's own name for the state it rendered, and the block every
polled fact behind that state was evaluated at. Every resolved state
names its block: if the read that names it fails, the facts read beside
it are treated as unread too and the card says it is still checking,
because a decision the app cannot date is not stated. The block is
omitted rather than zeroed only beside that still-checking state,
including when the page itself sets the state aside as "unknown" for a
reason of its own, since dating a state that was not resolved from those
facts would be a claim rather than a fact.

The block comes from where the facts come from. The readiness reads
used to be one request per fact, on purpose: the loan-to-value read
reverts by design on unpriced collateral, and a batch that let that
revert take the defaultability answer down with it would leave the
card permanently undecided on the positions it serves best. The reads
are now one aggregate that returns a status per call, which keeps that
independence while making one request instead of seven, and the
aggregate asks the chain its own block number in the same execution.
The loan's own record rides in the same aggregate, so its status, its
consent flag and the kind of asset on each leg carry the same
provenance as the polled facts beside them; the decision consumes
nothing about the loan from anywhere else. The one call addressed by
asset rather than by loan, the liquidity check, is accepted only when
the asset it was asked about is the collateral the loan record itself
names; otherwise liquidity is treated as unread and the card says it is
still checking rather than routing on an answer about some other
token. So the block the card names
is the block every fact behind its decision was read at, not a sighting
taken beside them and not a pinned height a load-balanced provider
might refuse.

The live drive reads both attributes and uses them. Settlement is read
off the declared state where one exists, and inferred from the copy
only on a deployment that predates the attributes. The verdict now
fails a card whose declaration and painted copy disagree about whether
the check is still running, re-reads the two facts a declared state
implies at the exact block the card names and fails a declaration the
chain contradicts there, and reports on every visit whether that
exact-block comparison ran, with the reason when it did not. A
deployment that publishes no attributes is reported as undeclared,
never as a defect.

The fork-tier spec drives the same loan across the grace boundary and
asserts the declared state moves with the copy and the declared block
is a real height the chain has reached. The connected-app functional
specification gains one statement of intent under the forced close-out
section: the card states what it decided and as of which block, so a
reviewer or an automated check can put the same questions to the
protocol at that block and compare. The decision itself, and every
route and refusal it can reach, are unchanged.
