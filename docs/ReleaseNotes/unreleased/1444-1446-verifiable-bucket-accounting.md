## Thread — Making the recycled-bucket books externally verifiable (PR #1448)

The mesh watcher shipped with two gaps its own README recorded as known
limitations. Both came from the same root: every figure the watcher could
read was one the contracts **derive**, and a derived figure cannot be used
to check the derivation that produced it. This change publishes the small
number of raw counters needed to close both, and tightens the watcher to
use them.

The first gap was bucket coverage — the check that a chain's recycled
balance actually backs the commitments reserved against it. On a receiving
chain that relation is hard, and the watcher pages on it. On the canonical
chain it was not, because of a deliberate design decision elsewhere:
releasing a remittance whose message can verifiably never execute restores
that day's funding commitments but does **not** re-credit the balance,
since the sent tokens are sitting in the transport's custody, outside the
platform's. That is the correct conservative behaviour, and it meant the
canonical chain could legitimately show a shortfall — so the check could
only be reported as an advisory there, which is to say it could not page on
the one chain that funds every other. The platform now records how much
backing each release stranded, so that amount counts as backing that exists
and is in transit. One strict rule now covers every chain, and the
role-based exception is gone rather than documented. The funding gate is
deliberately left alone: a day whose backing was stranded still cannot fund
until recovery. Whether something is a fault and whether it may fund
another day are different questions, and only the first is answered by
knowing where the tokens went.

The second gap was more subtle and is the reason this was flagged as worth
closing before mainnet. Each chain reports a lifetime absorption total to
the canonical chain, and the canonical chain's accepted copy is checked
against the chain's own figure to make sure it never runs ahead. That
catches a transport or replay problem, but it cannot catch the reporting
rule itself regressing — because the same rule produces both numbers, so
they would inflate together and stay equal. The rule in question is
load-bearing: it excludes the platform's own already-spent top-ups from
what a receiving chain reports as its own absorption, and without that
exclusion the canonical chain would re-offer its own top-up as the
receiver's local funding and commit it twice. The fix publishes the stored
counters behind that figure, which lets an outside observer do two things
it previously could not: confirm that the totals a chain claims never
exceed where its tokens actually went, and independently reproduce the
published absorption figure. The first catches a counter advancing without
tokens arriving; the second catches the exclusion being dropped from the
derivation. Neither could be caught by the other, and the tests assert that
division of labour explicitly rather than assuming it.

Both were originally expected to need new capability — a pre-exclusion view
plus, for the harder half, reconciliation against the event stream, which
the watcher deliberately does not do (every read it makes is a view call at
a pinned block). Publishing the raw counters turned out to be enough for
both, so the watcher keeps its read shape.

One incidental finding worth recording: the new reproduce-the-figure check
immediately failed against the watcher's own healthy-mesh test fixture,
because that fixture described a chain reporting less lifetime absorption
than its balance and payouts together imply — a state the contracts cannot
produce. Rather than correct that one fixture, the test helper now derives
those figures from where the tokens went, so no fixture can express an
unreachable state and a future check does not rediscover the same problem.

Closes #1444. Closes #1446. The remaining watcher limitation is #1445 —
nothing verifies that each configured endpoint really is the chain it is
labelled as.
