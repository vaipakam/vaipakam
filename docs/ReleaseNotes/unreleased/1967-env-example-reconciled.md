## Thread — the connected app's example configuration matches what it reads (#1967)

`apps/app/.env.example` is what an operator copies to `.env.local` before
deploying, and #1854 made it more load-bearing by pointing the deployment
runbook and the staging plan at it as the authoritative list. It was
missing three of the variables the app actually reads, so an operator
could follow it completely and still not know those settings existed.

All three are optional and all three degrade quietly rather than
breaking, which is exactly why they were easy to lose. One overrides the
host of the indexer's realtime push channel, for deploys that front the
WebSocket somewhere other than the read API — unset, the socket origin is
derived from the read origin by swapping the scheme, so realtime updates
work either way and nothing looks wrong. Another is the WebSocket
endpoint for BNB Testnet: the file documented that key for two of the
three chains carrying a deployment and silently omitted the third, so
live block updates there could not be switched on by anyone following the
list. The last repoints the "report an issue" target in the diagnostics
panel, which otherwise defaults to this repository's tracker.

That last one needed a constraint rather than just an entry, because it
is narrower than it looks. The report is delivered as GitHub issue-form
prefill — the builder appends a template name and this repository's own
bug-form field ids — so the target has to be a GitHub issue endpoint on a
repository carrying the same form, and it must have no query string of
its own, since one is appended unconditionally. Describing it as a way to
send reports "to an internal form" would have been an invitation to
configure something that silently drops every diagnostic.

The variable count quoted in the runbook, the staging plan and the #1854
release note moves from sixteen to nineteen.

Worth recording what this was NOT, because the first pass got it wrong in
both directions. Two per-chain WebSocket entries looked unused and were
nearly removed: nothing in the source mentions them by name, because the
key is assembled at runtime from the matching RPC variable. They are read,
and they stay. Two others looked missing and are correctly absent — one
names a rollout hatch that was removed, surviving only in a comment about
its removal, and the other is a test-only widening that an end-to-end spec
sets and production builds must never carry.

The lesson generalises past this file. A guard that compared the example
against a search for variable names in the source would have produced
exactly those four wrong answers — deleting two live settings and
documenting two that should not be. Any future check here has to
understand computed keys and distinguish operator configuration from test
scaffolding, or it will confidently make the file worse.

Closes #1967.

A second configuration claim was checked against the live account in the
same pass and turned out to be stale. The marketing site's Worker config
described `labs.vaipakam.com` — the hostname the site was served from
before the move to the apex — as still bound, and reasoned at some length
about the duplicate content that binding would produce for crawlers. It
is not bound: the host appears in no binding on the account, and a request
to it fails to connect in exactly the way the deliberately-unbound
`app.vaipakam.com` does. The note now records what is actually true, with
the date it was verified, and drops the crawler reasoning — an
unresolvable hostname has no index entry to worry about.
