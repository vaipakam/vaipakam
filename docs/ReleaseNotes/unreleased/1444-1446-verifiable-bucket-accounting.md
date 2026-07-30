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

Two corrections came out of review and are worth recording, because both
were cases of the correction itself being subtly wrong. The amount a
release strands is the share that actually left the balance, not the whole
commitment it restores — a partly-sent remittance retires its remainder
without moving anything, so that remainder is still sitting in the
balance and counting it would have credited it twice. And the allowance is admitted
only when two independently-changeable statements of the canonical role
agree — the platform's own record of which chain is canonical, and that
chain's own claim to be. Only the canonical chain can release, but the
role is an administrative setting, so requiring both closes two gaps at
once: a chain demoted after accruing an allowance keeping it, and a
mis-flagged chain granting itself one. A disagreement between those two
statements is now itself a paging alert, because a chain wrongly holding
that flag can close its own reward days and release remittances while the
platform still expects reports from it.

Reviewed further, the checks also gained a mirror image. Verifying only
that the counters do not claim more than the balance received left the
opposite corruption invisible — a transfer arriving and crediting the
balance while the counter that marks it as relocated custody is skipped
makes the original check *looser*, not tighter, and the re-derivation
agrees because it reads the same missing figure. The relation is now
checked in both directions: value in the balance that no counter accounts
for is as much a fault as counters claiming value that is not there. On a
platform upgraded in place, where the historical balance legitimately has
no counter behind it, that reverse direction reports as an advisory
stating the relation is unverifiable rather than either paging or staying
silent — and it resolves itself at the first credit.

Upgrading an existing deployment needed one more thing. A remittance
released *before* these counters existed already restored its commitment
and reversed its payout figure, but nothing recorded how much it stranded
— so both relations would have read as broken, from the first check after
the upgrade, on state the supported path produced. A one-time operator
ceremony seeds that figure. It derives the amount from the platform's own
records rather than accepting one, and refuses outright if the result does
not reconcile both relations, so it cannot be used to quiet a real
discrepancy. Because a long-lived deployment can hold more history than
one transaction can scan, the ceremony runs in operator-chosen chunks
and publishes nothing until the last one completes; and because a
remittance can be released while it is part-way through, it stops rather
than mixing two views of the same range, and can be discarded and
restarted from the current state. It still refuses to run twice, so
no lever edits a figure once published. The operator procedure is in
the Deployment Runbook.

Alongside the amount, the ceremony publishes how many releases were behind
it, so an operator can reconcile the figure against the release history
independently instead of taking it on trust. Two counters sit behind that
tally and both are new, which means a deployment upgraded in place starts
both at zero with real releases already in its past. The scan now repairs
both, not just the amount: without that, the platform would advertise a
"lifetime" release count smaller than the subset the scan had just found,
and an operator following the reconciliation instructions would find it
short by every release that predated the upgrade. It also refuses to go the
other way — a count above what the scan found means the two disagree about
the history, which stops the ceremony rather than being quietly overwritten.

One limitation of that reconciliation is now stated in the runbook rather
than left for an operator to discover: the allowance the scan derives is
*gross*. A remittance released and then delivered late has already handed
over its tokens, yet the scan still counts them as backing held back, so a
successful ceremony can complete over a bucket that is genuinely short by
that amount. A seed proves the published figure agrees with the recorded
reservation history — which is what it is for — not that the tokens are
present. Tracked as #1461.

The redeploy helper also prints those instructions per chain the moment
that chain's upgrade lands, rather than once at the very end of the run. The
instructions are owed from the moment the upgrade takes effect, and a later
step failing — the vault upgrade, or the optional artifact re-export — used
to end the run before anything was printed, leaving an operator with an
upgraded deployment, two alerts inbound, and no procedure.

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
