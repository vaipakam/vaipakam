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
the build behind it had been made without any of the sixteen operator
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
`alpha01.vaipakam.com` pointed at, or explain that the hostname is
attached out-of-band as a Custom Domain rather than declared in the
Worker's own config. That mapping, the binding procedure, and the
deploy-before-merge ordering are now written down.

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
