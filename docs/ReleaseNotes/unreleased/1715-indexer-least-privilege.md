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

The ordering it was used to justify may well still be right: nothing that
Worker holds can move funds, so the signing Worker still deserves the strictest
handling. But that conclusion should follow from what the Worker actually does,
not from a description written before it started publishing listings. The
section now states the real surface and flags explicitly that the ordering has
not been re-derived against it, rather than quietly restating a conclusion on a
new premise.

The specific phrase that was removed is the kind an auditor relies on to decide
a component does not need looking at. That is what makes it worth correcting
rather than leaving as an imprecision.

Two sibling descriptions of the same Worker were checked and deliberately left
alone: they say "read-only — no signing keys", which pairs the shorthand with
the claim that is actually true and is the one that matters for fund safety,
and the Worker's own entry point already documents its single write path
precisely.

No behaviour changes.
