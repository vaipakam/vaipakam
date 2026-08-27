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
`app.vaipakam.com` does — and it has no DNS record at all, which settles
it: with nothing resolving, there is no binding and no redirect rule
either, since a redirect needs a proxied record to fire on. The note now
records what is actually true, with the date it was verified, and drops
the crawler reasoning — an unresolvable hostname has no index entry to
worry about.

Correcting that one file turned out not to be enough, which is the
recurring shape of this whole effort: three further records said
otherwise, and an operator consulting any of them would have been
directed at a host that no longer exists. The staging plan described it
as the marketing site's current home and listed it as bound; an internal
state note went further and said it served a permanent redirect to the
new site, which was never checkable against a hostname that does not
resolve. All three now say what was verified, and the dated snapshot
keeps its original line — marked as no longer true rather than rewritten,
because a record of what was provisioned in May should not be quietly
edited to match August.

Two more surfaced after that, and they are the ones that would have cost
an operator something. The staging plan's cutover step still instructed
binding both the apex and the `www` host to the Worker — under its old
service name, and in a way that would have replaced the `www` → apex
redirect with a second indexable origin, undoing the canonical setup it
was meant to establish. It is retained as a record of what the step was,
marked not to be executed. And the workspace's own architecture map, the
first thing a new contributor reads, had the canonical host and its
redirect the wrong way round, promised a redirect on the retired hostname
that cannot exist without a DNS record, and gave the keeper a public
hostname it deliberately does not have — the keeper is cron-only and is
the only holder of an on-chain transaction key, so a hostname there would
be a mistake rather than an omission. That qualifier is load-bearing and
this sentence originally dropped it: the notifications Worker is not
keyless either, holding a real key that signs as the notification channel
and whose account carries a stake and its gas. An inventory that says
"the only signing key" understates what a compromise of that Worker would
reach, which is exactly the error being corrected here.

The published whitepaper was carrying the sharpest version of the same
problem. It listed the keeper alongside the other Workers with a public
hostname of its own — a service that does not exist and, by the design
this very correction documents, must never exist, since that Worker is
cron-only and holds the only key that can sign a transaction. A reader
following the public architecture description was being pointed at
nothing. The entry now says it has no public endpoint. Its account of the
keys was already precise and is untouched.

One further setting turned out to sit outside the file entirely, and it
is the sharpest of them. The build's SEO step runs before every build and
picks the origin for every URL in the generated sitemap and the
robots.txt target. It takes an override — but reads it from the shell
environment, not from the operator's configuration file, because it is a
plain script rather than part of the bundler's pipeline. So a deployment
served from any other origin gets sitemap and robots artifacts pointing
at the production host, silently and with nothing to discover in the
file an operator was told is authoritative. It is now documented in that
file under a heading saying plainly that setting it there does nothing,
with the exported form spelled out.

The variable count moved with the same care. It had been attributed to
the operator's own `.env.local`, which is gitignored, absent on a clean
checkout and different on every deployment — so no count could be quoted
from it. Nineteen is the count in the tracked `.env.example` template,
and that is the file the plan now names.
