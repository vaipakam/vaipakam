## The staging plan described the indexer Worker as doing less than it does (#1715)

The Cloudflare staging plan's architecture section explains why the three
Workers have different deploy cadences and different reviewer requirements. It
does that by describing what each one can reach. The entry for the indexer said
it was read-only, handled no HTTP-level credentials, and therefore sat at the
bottom of the risk ordering.

Both of those statements were wrong. That Worker holds fifteen stored
credentials, not the three the document listed: four are the kind an auditor
pictures — one marketplace key and three webhook-verification keys — and the
other eleven are the network endpoints it reads chains through, each of which
carries a provider key inside the address itself and is therefore just as
leakable and just as billable. Counting only the first four reproduces the
undercount this change exists to correct. Those four credentials are used
over HTTP — one marketplace API key and three webhook-verification keys — and
it makes authenticated calls out to a third-party marketplace to publish
listings on users' behalf. It is not read-only and it is not credential-free.

The ordering those statements were used to justify does not survive scrutiny
either, and that is the more serious half. All three Workers share one
database, and access to it is granted per-database, not per-table — so any of
them can write anything in it, whatever its own code happens to do. The
signing Worker reads a counter from that shared store and, once it crosses a
threshold, submits a privileged risk-parameter transaction. An attacker who
holds a non-signing Worker can write that counter and have the signing Worker
send the transaction.

The bound on that is worth stating precisely, because overstating it would
misdirect the fix. The transaction cannot be conjured from the shared store
alone — the signing Worker independently re-checks live market data each cycle
and does nothing when that check fails. What an attacker gains is the removal
of the *waiting period*: the requirement that the favourable reading persist
across many checks over several days, which exists so that one momentary
reading cannot move a risk setting. So the attack is "act on a single lucky
moment instead of a sustained trend", not "invent a result".

The corrected position is therefore narrower than the old one: the indexer
cannot move funds directly, but it can publish listings under the project's
marketplace credentials, and it can strip the time-based safety margin from a
change the signing Worker makes. Whether the fix is separate databases,
per-table isolation, or having the signing Worker validate state it did not
itself produce is an architectural decision, filed separately rather than
resolved by adjusting a deploy cadence.

The same reasoning applies to the other non-signing Worker, which holds the
same database access — so the deploy-cadence rationale that section states is
now marked as suspended for both, rather than corrected for one and left
standing for the other.

The specific phrase that was removed is the kind an auditor relies on to decide
a component does not need looking at. That is what makes it worth correcting
rather than leaving as an imprecision.

Two sibling descriptions of the same Worker are now corrected as well, rather
than excused. An earlier draft left them alone on the grounds that they pair
the shorthand with "no signing keys", which is true — but this very change
establishes that holding no signing key does **not** make a component
fund-safe, because it can still alter state the signing component acts on.
Using that phrase to justify a "read-only" label the same document proves
false would have been the argument refuting itself. The labels said "Reads
only" on a component with three endpoints that write to the shared database
and one that publishes orders to an outside marketplace on a borrower's behalf — orders the borrower authorised on-chain, which the Worker can re-expose but cannot invent.
An earlier draft of this note also cited the Worker's entry point as
documenting its single write path — that was itself wrong. There are three
write-accepting endpoints, not one, and using a false claim to justify leaving
other descriptions alone would have propagated the same error sideways.

No behaviour changes.
