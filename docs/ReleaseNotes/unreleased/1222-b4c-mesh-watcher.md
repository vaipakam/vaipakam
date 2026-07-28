## Recycling mesh — an operator watcher for the per-chain ledgers (#1222 M3 B4-c)

The cross-chain recycling ledger has one property no test can check: it
spans chains. Base decides how much recycled reward budget a mirror may
fund from its own bucket, using Base's *model* of that mirror's
availability; the mirror then reserves against its *actual* bucket. Those
two figures live on different chains, are written by different
transactions, and reconcile only through periodic day-close reports. Each
side can be proven correct in isolation — B4-a and B4-b did exactly that
— but only something reading both at once can show they still agree in
production. This release adds that observer: a small internal Cloudflare
Worker, `ops/mesh-watcher`, that every fifteen minutes reads the per-chain
recycled books from the canonical reward chain and each chain's own bucket
and reservation counters from that chain's own Diamond, then checks the
relations that hold the two views together.

Eight of those relations cannot legitimately break — they are maintained
by construction, so a violation means a bug, a spoofed report, or storage
corruption, never ordinary operation. They ship as real alerts: the
per-chain commit identity (outstanding plus retired always equals what
Base instructed); the clamp chain that keeps a mirror trusted for timing
but never for magnitude; the ceiling that stops day-credit attribution
exceeding what a chain reported absorbing; the availability formula
itself, re-derived off-chain so a drifted deployment is visible; the rule
that the canonical chain never books per-chain commitments against itself;
the rule that Base's accepted cumulatives never run ahead of the chain's
own; the bound that instructions to a chain never exceed what it reported
absorbing, net of what it released un-spent; and bucket coverage — that a chain's live bucket actually backs the
reservations made against it, which is the check that would catch Base's
model over-stating what a mirror holds. Bucket coverage allows a small,
documented tolerance rather than comparing exactly, because the payout
path deliberately floors the bucket at zero instead of reverting on
wei-scale rounding, and an exact comparison would page on healthy dust.

The ninth signal — a chain holding recycled commitments while retirement
stays flat — ships deliberately as an **advisory**, labelled as such in
every message. Its condition is necessary but not sufficient: a chain that
simply had no claims, forfeits or expiries fall due in the window
satisfies it perfectly legitimately, because commitments stay reserved
until a user or horizon event retires them. Choosing the
settlement-expected qualifier that would make it pageable is open design
work tracked on #1442. Shipping it as a pager today would have trained
whoever carries it to ignore the alert, which is worse than not having it.
Two further advisories cover a stalled report path and, always, any chain
the watcher could not read this tick — a watcher that quietly narrows its
scope would otherwise report "all clear" for chains it never looked at.

Review hardened several edges before this landed, two of which changed
behaviour rather than wording. Bucket coverage is CRITICAL on mirrors only:
on the canonical chain, releasing a permanently-failed remittance restores
the reservation while deliberately not re-crediting the bucket — those
tokens are locked in the bridge's custody, outside the platform's — so
paging there would have raised a false alarm on the contract's intended
recovery state. It is reported as an advisory naming that cause instead.
And every related read is now pinned to a single block per chain: those
fields are written together on-chain but read over several calls, so an
unpinned read could straddle a transaction and page a violation that never
existed — a false critical being the worst thing a watcher can produce.
The manual trigger is authenticated and fail-closed, because running a
tick is not a read-only probe and an unauthenticated caller could have
forged the very evidence the operator acts on. A second round tightened
what the alerts actually show — a report-lag message now names which of
the three reported cumulatives is behind, rather than always printing the
absorption pair and, when retirement was the trigger, a difference of
zero. A third round caught the report-lag threshold being far too tight:
those cumulatives travel only in a chain's day-close report, so between
reports the canonical side is legitimately behind and frozen for a whole
day, and the original hour-and-a-half window would have alarmed daily on
a perfectly healthy chain. It now spans more than a full report cycle
including the finalization grace. The same round added two things a first
deployment needs: the tick reports whether an alert destination is even
configured and fails if it is not — undeliverable alerts are not a
healthy state however clean the ledgers are — and a source set that omits
the canonical chain is now reported rather than silently papered over,
since the day's global totals are summed over exactly that set.

A fourth round found the one genuine security defect in the work. The
blockchain client library embeds the request URL in its error messages,
and RPC providers put the API key in that URL — so a provider having a
bad minute would have published a credential straight into the operator
chat and the logs. Every error string now passes through a redactor
before it can reach an alert: known secrets become named placeholders,
and any URL at all keeps its host and loses its path and query. The same
round added a missing ledger bound — that instructions to a chain never
exceed what it reported absorbing — which had been invisible because the
availability figure it would otherwise have shown up in saturates at
zero; corrected the stuck-settlement signal to read both of its inputs
from the same chain's books rather than one from each side, which would
have alarmed on chains that had already settled everything; and made the
manual verification actually send a test message, since a configured
pager and a working pager are not the same thing.

A fifth and sixth round were mostly about the hardening itself being
incomplete. Two fixes from an earlier round turned out not to hold: the
database-outage path that was supposed to preserve already-computed
findings still consulted the same unavailable database a moment later and
lost them anyway, and the credential scrubbing missed the one shape where
a secret lives entirely inside a URL's authority rather than its path.
Both are closed. Alongside them: the alert channel now delivers advisories
without notifying, so the non-paging tier is actually non-paging rather
than merely labelled; the manual verification endpoint no longer advances
the observation counters, which are denominated in scheduled runs; one
chain being unreadable no longer discards every other chain's evidence;
and a run that cannot see its whole mesh no longer reports itself healthy.
Verifying that each configured endpoint really is the chain it claims to
be is deferred to its own change.

Two design choices are worth recording. The chain set is not configured
anywhere in the Worker: it reads the expected source chains from the
canonical Diamond each tick, so a mirror wired on-chain is watched as soon
as it is wired, and a missing RPC endpoint surfaces as a reported coverage
gap instead of a silent skip. And the read shapes come from the compiled
facet ABI rather than hand-written signatures, with a startup assertion
that fails loudly if a re-export ever changes a watched view's shape —
the sibling LayerZero watcher could hand-write its signatures safely
because it read a third-party standard surface, but this Worker reads only
our own Diamond, where hand-typed tuples are precisely the drift that
caused the May 2026 decode incident. The check suite is mutation-verified:
every check was removed or subtly broken in turn and confirmed to turn its
own test red.

The Worker is code-complete and **undeployed**. Creating its database,
setting its secrets and the first deploy are documented operator steps in
its README; it runs on the cron slot freed by retiring the LayerZero
watcher, whose surfaces the CCIP migration and the securities-feature
excision had between them made entirely dead. Its typecheck and tests run
in CI as a non-blocking job — the Worker is detection-only, so a red there
should inform rather than block a contracts merge.

Part of #1222. Follow-ups: #1442 (the settlement-expected qualifier),
#1440 (removing the retired LayerZero watcher's source tree).
