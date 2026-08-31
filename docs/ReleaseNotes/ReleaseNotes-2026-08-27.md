# Release Notes — 2026-08-27

The day the connected app became `apps/app`. Around that cutover sits a set of
changes about systems telling the truth about their own state: the reward expiry
clock now stops when a claim would be refused rather than running down against a
door that is shut; the arming ceremony can read whether a chain has already
applied a day instead of assuming; and the keeper's liquidation scan, which had
been described as batching, turns out never to have batched at all. Three
smaller corrections tidy the edges an app move leaves behind — the example
configuration now matches what the app actually reads (#1967), three deploy
commands stopped pointing at a host that no longer exists (#1969), and one bad
moment upstream no longer fails an entire end-to-end run (#1973). The forfeited
loan-initiation VPFI note closes the day by stating a share that had been left
implicit.

# The reward expiry clock now stops when a claim would be refused

**Task:** #1499

Interaction rewards can eventually expire: once a reward has been claimable for
a long enough stretch, a keeper may sweep it back into the recycling pool. The
clock that measures "claimable" is supposed to run only while the owner could
actually have collected.

It did not match the claim. The claim refuses a payout whose funded part will
not fit above the balance already spoken for by the recycling bucket and the
recovery reservations; the expiry clock was testing the raw balance instead. On
a thinly funded deployment those disagree, and they disagree in the direction
that costs the claimant: the clock keeps running through a period when every
attempt to claim reverts, and the reward can then be swept away on time the
owner never had.

The clock now measures the same thing the claim does — the balance net of what
is already reserved, and whether the recycled part of the payout can actually be
transferred. Where the platform cannot compute a claimant's exact recycled
obligation it uses a bound that may pause a clock which would in fact have run,
and never the reverse. Pausing only delays a sweep; running too freely destroys
the reward.

Nothing is observable yet: the expiry horizon ships switched off, so no clock is
accruing on any deployment today. This is the correctness precondition for
turning it on.

Also in this change: the sweep and the countdown now compute each claimant's
per-user figures once and share them, instead of recomputing the same walks
several times per reward examined. That work grew with a claimant's history and
could have pushed a keeper's batch past the block gas limit, which would have
stranded exactly the rewards the sweep exists to process.
<!-- assembled-fragment: 1499-rl3-horizon-backing-gate.md sha256=442cf73378865c4feea74e9ab426518c0eac6142ff31518da89e21d4c23eb924 -->

## Thread — the connected app becomes `apps/app` (PR #TBD)

The connected app takes its final name. What shipped for two months as
`apps/alpha02` is now simply the app: folder `apps/app`, package
`@vaipakam/app`, Cloudflare Worker `vaipakam-app`, destined for
**app.vaipakam.com** — a hostname this change deliberately stops short of
switching users onto, for reasons set out below. The three surfaces it
superseded are
deleted — `apps/defi` (frozen since the redesign began, previously at
defi.vaipakam.com) and the two earlier prototypes `apps/alpha` and
`apps/alpha01`. Nothing named "alpha" survives in the source tree, the package names
or the app's own shell. One does survive where users can still reach
it: the `vaipakam-alpha02` Worker is still deployed on
alpha02.vaipakam.com, because deleting a source directory does not
retire a running deployment. That retirement is an operator step, and
it is listed with the others at the end of this note.

The marketing site needed no structural change, which is worth recording
because it was the part everyone expected to be hard. `apps/www` never
imported the connected app: every "Launch App" button and every link to a
public-read tool (analytics, NFT verifier, protocol console) resolved
through a single URL helper, and a cross-domain link turned out to be the
entire coupling between the two sites, exactly as intended when they were
split.

That helper did need reworking, though not for the reason expected. The
two surfaces do not agree on their paths — the verifier and the VPFI
vault each answer on a different route in each app — so moving the host
without moving the paths breaks the links just as thoroughly as moving
neither. It happened twice during review before the shape changed: call
sites now name a destination rather than a path, and one setting selects
the host and the route table together, so the two cannot drift apart.

Two consequences operators and users should expect. First, browser-stored
preferences do not survive the move: theme, Basic/Advanced mode, dismissed
notices and pending-action markers all live in per-origin browser storage,
and app.vaipakam.com is a new origin, so everyone starts from defaults
regardless of what the storage keys are called. Second, the scripted
Cloudflare frontend deploy — the only one in the repository, and formerly
`apps/defi`'s — was repointed rather than removed, so `deploy-chain.sh`,
`deploy-testnet.sh` and `deploy-mainnet.sh` still ship a frontend; the
per-app skip flag is now `--skip-app` and the phase is `cf-app`.

Those scripts now also state plainly what they are not doing. Until the
cutover completes, publishing the app Worker does not reach the surface
users are actually on, and there is no second frontend to publish to
instead — the retired app's source is gone with it, so it cannot be
rebuilt to carry new contract addresses. Refusing to deploy contracts
at all until three unrelated frontend blockers clear would be a worse
answer than saying so, so each run prints the caveat and names them.

Two workflow display names deliberately keep stale text. A required status
check is keyed on the workflow's name, so renaming one strands it as
permanently pending and blocks every merge; `defi vitest` and
`alpha02 e2e (anvil fork)` therefore stay until branch protection is
updated by hand. Their files were renamed and every path filter and
package filter inside them was updated — only the two check-context
strings were left alone, each with a comment saying why.

Documentation that cited the deleted app by file path was repointed at
live successors rather than at git history. The published user guide told
advanced users to read two source files for the OpenSea listing path; both
died with `apps/defi`, so the guide now names the surviving reference for
each — the collection proxy the app reads collection fees through, and the
indexer-side publisher. The same sweep removed an English editorial note
that had been inserted into all ten translations of that guide. On the
internal side, the risk-committee sign-off questionnaire cited the deleted
app for its abnormal-market consent disclosure; its disclosure strings were
repointed to the marketing site, and the claim that consent *gates* offer
creation was re-verified against the connected app, where the refusal
actually lives. That correction matters on its own: the gate was previously
attributed to the disclosure text, but text cannot gate anything — the
validator refuses the form, and the accepted consent is recorded on-chain
with the offer, so it is auditable on the position rather than only in a
browser session.

The new hostname is not live yet, and this change deliberately does not
pretend otherwise. The `vaipakam-app` Worker exists — created equivalent
to the one it replaces, same compatibility date and flags, with no
bindings or secrets to carry over since the app is a static-assets
deploy — but `app.vaipakam.com` is unbound, and every link the marketing
site emits still resolves to the host that actually answers.

That ordering is the lesson rather than an oversight. The Worker was
first deployed and bound during this change, then unbound again, because
the build behind it had been made without any of the nineteen operator
variables the app needs: no indexer origin, so no offer book, push rail
or config snapshot, no keyed RPC endpoints, and no WalletConnect
project ID. The last two degrade rather than break — the app falls back
to public RPC endpoints, which are rate limited rather than absent, and
loses WalletConnect pairing while keeping the injected and Coinbase
connectors — but a build in that state is a preview, not something to
put on a production hostname.
A bare build only warns about that; the package's own deploy script
turns it into a hard failure, and using the shortcut is what let a
configuration-empty build reach a production hostname at all. The
scripted deploy paths were routing around the same guard, and no longer
do.

Finishing the cutover is not a one-line flip, and it would be a
disservice to describe it as one. Three things must be built first. The
successor has no Terms-of-Service gate: the retired app refused every
connected route until the wallet had accepted the current version, the
contracts delegate that enforcement to the client rather than checking
it per action, and nothing in the new app does it — so switching users
across while a Terms version is in force would leave that requirement
quietly unenforced for everybody. The successor also has no Data Rights
page, and the marketing site's export-and-erase controls cannot stand in
for one: browser storage is per-origin, so they can neither read nor
clear what the app keeps on its own — moving users across before that is
ported would take away a privacy control they have today. And two public
tools, Analytics and the Protocol Console, were never ported, which is
why the marketing site still points those particular links at the old
surface and why that surface cannot yet be retired or redirected
wholesale.

Only then does the mechanical part apply, and it is more than the
hostname: the app's own deploy, the binding, the link helper's target,
the recovery links hard-coded in ten translated guides, the agent's
first allowed origin — which is where its Frame and notification links
are built from — and the discovery links that automated consumers read
from the indexer's catalogue and the generated `llms.txt`. Those move
together or they contradict each other, which happened twice while this
change was in review. The full sequence lives beside the switch that
performs it, so whoever flips it is reading the list at the moment they
need it.

Until all of that lands, the repository never advertises a hostname
that nothing answers — which matters here because this change also
repoints every live end-to-end driver.

The deployment runbook gains the record that made this awkward to
begin with. Which hostname served which Worker existed only in the
Cloudflare dashboard, so nothing in the repository could answer what
`alpha01.vaipakam.com` pointed at, or explain how a hostname gets
attached at all — which is not uniform, and that is the part worth
knowing. Almost every one is created out-of-band as a Custom Domain,
invisible to the repository; the indexer is the single exception,
declaring its own hostname in its Worker config so that publishing the
Worker maintains the binding too. Reading one of those as the rule
sends you either hand-binding a hostname that is already managed, or
waiting for a deploy to create one that nothing will. That mapping, the
binding procedure and its exception, and the deploy-before-merge
ordering are now written down.

Two follow-ups stay open. The four Workers whose sources are gone still
run — `vaipakam-defi`, `vaipakam-alpha`, `vaipakam-alpha01` and
`vaipakam-alpha02` — and the recommendation is to convert the first and
last into redirects rather than delete them, since both had real users
and `alpha02` in particular is cited as the testnet-review target
throughout the findings notes; the two prototypes can go outright. And
`packages/defi-client` is now orphaned, `apps/alpha01` having been its
only consumer. It is kept with its description saying so, to be deleted
if nothing adopts it.

Closes #1854.
<!-- assembled-fragment: 1854-apps-restructure-app-cutover.md sha256=13bcc43528028debe4744b94b18860cb2e11d7b72ec0cbce07606a0e3e002670 -->

# The arming ceremony can now read whether a chain already applied a day

Before a cross-chain reward day can be used to carry the recycling cutover
date, the operator has to pick a day that the target chains have not already
applied. That matters because applying a day is one-way: a chain that has
already applied a day treats a later re-send of the same day as a duplicate
and takes no further action from it — so the cutover date riding on that day
never lands, and that date can only be chosen once.

Until now the only way to find out whether a chain had already applied a
given day was to search back through its published event history. That is a
poor way to answer a question the ceremony asks under time pressure, and it
fails in the worst possible direction: a search that quietly misses part of
the history reports "not applied", which is exactly the answer that wastes
the candidate day.

Each chain now publishes that state directly, per day, as a public read. The
operator can check every target chain immediately before sending, and line up
several candidate days in advance, without reconstructing history.

This is a read-only addition. It does not change how days are applied, does
not change what a duplicate does, and does not by itself remove the
underlying constraint that a day already applied cannot carry the cutover
date — it makes the existing workaround dependable instead of best-effort.
The durable fix for that constraint is still open and wants its own design
pass.

Issue: #1944
<!-- assembled-fragment: 1944-broadcast-applied-readback.md sha256=8b96b2af12bdcdb5c776965c40c63bcdd89e5c17d02bc82ed85b3e3ec3383f59 -->

# The keeper's liquidation scan was never actually batching

The keeper checks every active loan's health factor on each pass. That scan
was written to ask for all of them together in one grouped request, with a
fall-back to asking one loan at a time if a chain could not support the
grouped form — described as a rare case.

The rare case was the only case. The grouped request was being rejected
immediately, before it ever left the Worker, because the connection it was
issued on carries no chain identity and the grouped-call helper needs to be
told explicitly where to send it. The scan then quietly did what it was
designed to do when grouping is unavailable: it fell back to asking for each
loan separately.

Nothing looked wrong from the outside. The pass still finished, still logged
its completion, and the only trace was a single error line that read like a
passing network blip. What it cost was one request per active loan, per
chain, on every pass — against a fixed per-invocation request budget. A busy
chain could exhaust that budget and leave the tail of its loan list unscanned.

The grouped request is now told where to send itself, so the scan batches as
intended. A test asserts the batched path actually runs and that no
one-at-a-time fallback happens.

The same defect had already been found and fixed in the reward-remittance
path; the address it needed now lives in one shared place rather than being
repeated, so a third caller cannot reintroduce it by copying an older call
site.

Issue: #1946
<!-- assembled-fragment: 1946-liquidator-multicall-batching.md sha256=373fe01eb94942490a11164497b64af901a51695f9056638c1f82be0b3cb42bb -->

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
<!-- assembled-fragment: 1967-env-example-reconciled.md sha256=84e317792355393a375e131b05b8e59337a0abaef7f4e30965c5d75d7e2e2660 -->

## Thread — three deploy commands pointed at a host that no longer exists (#1969)

The deployment runbook carried three instructions an operator runs
verbatim, all aimed at the hostname of a Worker retired in the Stage 3
split. That hostname stopped resolving when the Worker was
decommissioned, so each one failed — but not in the same way, and the
first one did not look like a failure at all.

Registering the Telegram webhook was the dangerous one. The registration
call is made against Telegram, not against our own service, and Telegram
accepts whatever address it is given without checking that anything
answers there. So the command reported success, the operator moved on,
and the bot then silently received nothing — a failure that surfaces
much later as "the bot doesn't respond", with nothing connecting it back
to the step that caused it. It now names the Worker that actually serves
the webhook.

The second was wrong twice over. A frontend deployment step set a
variable that no source file in any app reads — it was split into two
separate origin settings at the same refactor — and pointed it at the
same dead host. An operator following it got precisely the degraded
Alerts page the step exists to prevent, having done everything asked.
Both halves are corrected, with a note recording what the line used to
say, since anyone comparing against an older deployment will find the
old form in their notes.

Repointing them turned out to need more care than swapping a hostname,
and review caught two ways a naive substitution goes wrong.

The frontend step says "set on every frontend deploy", and writing the
production address into it looked like pointing staging at production.
The truth turned out to be less comfortable: there is only one such
service and every environment already shares it, so there was no
per-environment address to prefer. The step now says that, and states
the consequence instead of implying a separation that does not exist.

The smoke test carried a second flaw underneath the same wrong host. Its
payload carried a fixed identifier while the table treats that
column as a primary key with no conflict handling, so the test worked
once per database and then failed with a constraint error that looks
like a fault in the service. It now generates a fresh identifier per run
and verifies that specific row rather than whatever landed most
recently.

The third was a diagnostics smoke test. It would fail cleanly, which is
the best of the three outcomes, but reads as an outage of a service that
is healthy.

The smoke test needed one more fix that only becomes visible once it can
run at all. Beyond a unique identifier per attempt, each run also needs
to look like a *different* event: the service deduplicates on the shape
of a report and stops writing when the last several records in the whole
table are identical. That check is global rather than per-user, and with
no consumer sending anything else, a run of identical smoke tests trips
it — the sixth returns a polite refusal and the verification query comes
back empty, which reads as a broken deploy but is the deduplication
working exactly as designed. The documented payload now varies per run,
and the refusal is written down so nobody debugs it as a fault.

One correction went further than repointing. The section describing how
the frontend connects to that endpoint said a now-retired variable was
read and already configured. Neither was true, and the endpoint has no
consumer in the shipping app at all — its only callers lived in the
retired connected app. The section now leads with that, because an
operator configuring something nothing calls will be confused by
silence, not by an error.

That correction then had to be made in three places rather than one. The
same section elsewhere described the frontend firing a report on every
failure, and two further settings shaping what gets captured — none of
which exist in the shipping app. The section now says once, at the top,
that the whole feature is dormant and that everything below describes how
it will behave when something calls it. An empty table is the correct
observation today, and an operator checking capture health deserves to
know that before reading three pages about it.

One instruction had to be walked back after review, and the correction
is worth recording because the first attempt was reasonable and wrong.
Warned that the frontend step should not point a preview build at the
live service, I told operators to use the deployment for their own
environment — but there is only one such service, shared by every
environment, and nothing per-environment exists to point at. The step now
says that plainly, and states the consequence instead of pretending it
away: alert settings written from any environment reach real users,
because there is one database behind that one service. Leaving the
setting empty is a safe choice rather than a broken one, since the app
hides the feature and sends nothing. That per-environment isolation does
not exist is a genuine gap, and saying so is more useful than inventing a
URL.

Review then found the warning itself was too narrow, in the direction
that matters. Sharing one service across environments does not only put
alert settings at risk: the same origin carries the support form, and a
ticket submitted from a preview build writes a durable record and pages
real operators through the internal alerting channel. The advice to use a
test wallet is no protection there, because tickets carry no wallet
identity at all — there is nothing for a test wallet to isolate. The
warning now names all three surfaces and says plainly that for support
the only real protection is not exercising the form outside production.

A related instruction was removed rather than corrected. Operators were
told they could hide the in-app diagnostics drawer with a setting once
capture looked healthy. That setting is read nowhere in the shipping app
and the drawer is mounted unconditionally, so the instruction would not
have worked today and would not work after a consumer is ported either.
Saying so is more useful than leaving a knob that quietly does nothing.

The published privacy policy turned out to describe this same dormant
capture as though it were running — telling every visitor their errors,
redacted wallet and chain are transmitted and kept for ninety days. That
is over-disclosure rather than under-disclosure, but it is still wrong on
a page whose whole purpose is accuracy. It is raised separately rather
than folded in here: it is public legal copy, it needs a decision rather
than a mechanical edit, and burying it in an operations change is how it
would go unread.

Left alone deliberately: the incident runbook already tells operators to
use the correct host and explicitly not this one, the staging plan
describes decommissioning it, and the release notes record the migration
onto it. Those are accurate records of the past, and rewriting history to
match the present is how a dated record stops being useful.
<!-- assembled-fragment: 1969-runbook-dead-host-commands.md sha256=ca1eed37dcb6153dbab24042a2cab8856a80cb104c12d31c4f26620db0354ecd -->

## Thread — one bad moment upstream no longer fails the whole end-to-end job (#1973)

The browser end-to-end suite starts by forking the test network at its
current head. That is inherently racy: the upstream node can advertise a
block whose state a load-balanced peer cannot serve yet, and the fork
tool then exits during setup rather than starting. It happened once
today, on a documentation-only change that could not possibly have
caused it.

What made it worth fixing is not the frequency — the same job passed
twice on equivalent code either side of the failure — but who pays. The
failure surfaces as a red required check on whatever change happens to
be in flight, with a stack trace pointing into the test harness, so the
natural reading is that the change broke the tests. Establishing
otherwise took real time.

Startup now retries a small number of times before giving up, and says
so in the log each time. Two deliberate limits: it retries only when the
fork tool exits quickly, which is what an upstream hiccup looks like, and
never when startup simply times out, because that indicates something
structurally wrong and retrying would only triple the wait before
reporting it. The final failure message now names the likely cause and
points at the issue, so the next person reading it does not start by
suspecting their own diff.

Two limits keep the retry from becoming its own problem. It only applies
when the fork tool dies within the first half-minute, which is what a
genesis failure looks like; something that runs almost to the readiness
deadline and then exits is a different fault, and retrying it would
multiply the wait rather than recover from anything, so that fails
immediately with a message saying which case it was. And the attempt
count, which is overridable, is validated on the way in: an empty or
mistyped value would otherwise skip startup silently, a fractional one
would never reach the give-up branch, and an unbounded one would retry
forever. A configuration typo now fails with a message naming the
accepted range.

One thing that looks like a problem here is not one, and the check is
now recorded in the code so nobody spends the effort twice. Readiness is
watched by a poller racing against the process exiting; the loser of that
race is abandoned mid-flight, and since the poller reports a timeout by
failing, an abandoned one looks like a failure nobody is waiting for —
the kind that can bring down an otherwise healthy run minutes later. It
is not: a race keeps watching every entrant even after one has won, so
the late failure is seen and discarded. That was verified by experiment
rather than reasoned about, after reasoning about it produced the wrong
answer, and a change made on the strength of the wrong answer was
withdrawn — it would have thrown away the underlying error the timeout
message carries, which is the most useful thing in it.

Retrying also meant being careful about what the teardown step is told
to clean up, in two places rather than one. The record of running
processes is now emptied at the very start of setup, before any check
that can abort it — a list left over from an earlier run is not merely
useless, because cleanup kills whatever it finds and the operating
system reuses those numbers. Several checks abort before the first real
write, so clearing once at the top is what makes all of them safe,
rather than each one having to remember. Each attempt's process id is recorded as soon as it starts,
so a live one is always killable — but a dead one has to come back out
again the moment it is seen to have exited. Leaving it would be worse
than untidy: the cleanup step kills every recorded id, tolerating one
that is simply gone, but an operating system reuses those numbers, and on
a long run the number could by then belong to something else entirely.
The removal happens before anything else, including before giving up, so
no exit path can leave one behind.

The retry is loud on purpose. A silent one turns a degrading upstream
into an unexplained slowdown, and hides exactly the signal that would
tell an operator the endpoint needs attention.
<!-- assembled-fragment: 1973-e2e-anvil-startup-retry.md sha256=5e4006df38d78c6950fbb7f74bd08f64598aced352cd83766ee25ddc3d63c867 -->

# Forfeited loan-initiation VPFI: the matcher's share is now stated

**Task:** #1980

Two places in the public documentation said that when a loan on the retired
VPFI fee path defaults or is liquidated, the VPFI held against its initiation
fee is forfeited **to treasury**. That is not where all of it goes. On a loan
that a matcher created, the matcher receives its configured share of that
amount first, and only the remainder reaches treasury. The share defaults to
1% and is governance-tunable up to a hard ceiling, so the omission was not a
rounding detail.

Both statements now describe the split. Nothing about the platform's behaviour
changed — this corrects what the documents claimed it was.

The correction is also an internal-consistency fix rather than a new
disclosure. The matcher's share of the loan-initiation fee flow was already
described in the whitepaper's participant and matching sections, and the
Advanced user guide already worded the illiquid-default case correctly. The
same guide then contradicted itself a few hundred lines later, which is the
sentence this changes.

Still outstanding on the card, and deliberately not folded in here: the nine
non-English user guides carry the same claim in the illiquid-default passage
and need the same correction, and a separate question about whether the fee
discount is time-weighted or point-in-time is filed as its own issue.
<!-- assembled-fragment: 1980-forfeited-lif-matcher-slice.md sha256=5c547237dcd0604202cce45393e5b1394db01c7c625025bb2e16973ca6f63919 -->
