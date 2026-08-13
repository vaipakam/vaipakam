## The staging plan described the indexer Worker as doing less than it does (#1715)

The Cloudflare staging plan's architecture section explains why the three
Workers have different deploy cadences and different reviewer requirements. It
does that by describing what each one can reach. The entry for the indexer said
it was read-only, handled no HTTP-level credentials, and therefore sat at the
bottom of the risk ordering.

Both of those statements were wrong. That Worker holds four credentials used
over HTTP — one marketplace API key and three webhook-verification keys — and
it makes authenticated calls out to a third-party marketplace to publish
listings on users' behalf. It is not read-only and it is not credential-free.

The ordering those statements were used to justify does not survive scrutiny
either, and that is the more serious half. All three Workers share one
database, and access to it is granted per-database, not per-table — so any of
them can write anything in it, whatever its own code happens to do. The
signing Worker reads a counter from that shared store and, once it crosses a
threshold, submits a privileged risk-parameter transaction. An attacker who
holds the indexer can therefore write the counter and have the signing Worker
send the transaction for them. No funds move through the indexer, and funds
still move.

So the corrected position is narrower than the old one: the indexer cannot move
funds directly, but it can publish listings under the project's marketplace
credentials, and it can reach fund-relevant on-chain state indirectly through
inputs the signing Worker trusts. Whether the fix is separate databases,
per-table isolation, or having the signing Worker validate state it did not
itself produce is an architectural decision, filed separately rather than
resolved by adjusting a deploy cadence.

The specific phrase that was removed is the kind an auditor relies on to decide
a component does not need looking at. That is what makes it worth correcting
rather than leaving as an imprecision.

Two sibling descriptions of the same Worker were left alone, but for a
narrower reason than first stated: they pair the shorthand with "no signing
keys", which remains true and is the claim that matters for fund safety.
An earlier draft of this note also cited the Worker's entry point as
documenting its single write path — that was itself wrong. There are three
write-accepting endpoints, not one, and using a false claim to justify leaving
other descriptions alone would have propagated the same error sideways.

No behaviour changes.
