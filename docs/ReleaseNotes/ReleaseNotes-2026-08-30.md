# Release Notes — 2026-08-30

A day of removing things that were not carrying their weight, and of making the
remaining claims exact. The orphaned `packages/ui` package is retired — its last
consumer went with `apps/defi`, leaving a package nothing imported and nothing
typechecked. The Privacy Policy is narrowed to collection that actually happens,
which is the rarer direction for a privacy document to move. The cron-slot gate
now constrains its authority instead of parsing Markdown, following the same
constrain-don't-parse reasoning that retired an earlier deploy check. And two
changes make user-facing records precise rather than approximate: terms
acceptance links the exact text it recorded, and smart-contract wallets can use
every signed control rather than the subset that happened to work.

## Thread — Retire the orphaned `packages/ui` component package (PR #2021)

`packages/ui` held five shared React primitives — a token icon, an info
tip, a chain picker, a copyable address and the picker they were built
on. The #1854 cutover deleted `apps/defi`, which had eleven importers and
was the package's last real consumer. Since then nothing imported it and,
more importantly, nothing compiled it: the package had no `tsconfig.json`
and no `typescript` dependency, and its `typecheck` script ran ESLint
only. A step named "typecheck" on a required CI job had stopped
typechecking anything, and ordinary type errors in that source could
reach `main` unopposed.

This retires the package rather than giving it real checking. The choice
turns on the fact that it shipped to nobody: adding a `tsc` pass would
have bought a genuine gate over code with no consumer, and paid for it
with a first run's worth of accumulated errors to triage plus ongoing
maintenance of a library nothing uses. The shipping surfaces confirm the
package was not load-bearing — `apps/app` and `apps/www` carry their own
pickers and never referenced these primitives; `apps/www` held only a
dependency entry it never imported from, which goes with it. The source
stays recoverable from git history if a surface ever wants those
primitives back.

Cleaning up after it reaches a few places worth naming, because each was
making a claim that is no longer true. The CI lint step and its
explanatory comment are gone. The connected-app vitest gate's
change-detector no longer watches a path that cannot exist. The
deployment runbook described `VITE_TOKEN_ICON_URL_TEMPLATE` as "inert
pending a consumer"; with its only reader deleted it is now simply dead,
and the runbook says so. The matching per-chain `tokenIconUrlTemplate`
field on the deployment type is kept — it is optional, no chain stanza
sets it, and removing a typed deployment field is a schema change that
deserves its own review — but it is now documented as having no reader.

Closes #1963. Two related dispositions are deliberately left open: the
`packages/defi-client` package that #1854 orphaned in the same way still
needs its own decision, and the now-readerless `tokenIconUrlTemplate`
field is a candidate for a later schema tidy.
<!-- assembled-fragment: 1963-retire-packages-ui.md sha256=aa842b35177719dac6c4e7400b96a022f815b839b7c510be935e80f9ae4a4634 -->

## Thread — Narrow the Privacy Policy to collection that actually happens (PR #2022)

The published Privacy Policy told every visitor that each UI error was
recorded on our servers with a per-event UUID, carrying their redacted
wallet, chain id, locale, theme, viewport and app version, and retained
for ninety days. No shipping client does any of that. The endpoint is
deployed and works, but its only client-side callers lived in the
connected app that #1854 retired, so no shipping frontend has sent it a
record since. That is deliberately narrower than "nothing has": the
deployment runbook carries a smoke test that posts a record and verifies
the row lands, so an operator exercising it does create one, and an audit
of recently created rows should expect that. The adjacent
paragraph was stale in the same way, describing a wallet-keyed "journey
log" in local storage; the current app keeps one slot in session storage
holding the most recent error, not keyed to any wallet, discarded when
the tab closes.

This is over-disclosure rather than under-disclosure, which is the safer
direction to be wrong in — but a privacy policy is a document whose whole
purpose is accuracy, and someone deciding whether to connect a wallet was
being told their errors and chain id were transmitted and retained when
they were not. It also degrades quietly: if capture is ever restored,
nobody re-reads a policy that already claims the behaviour.

The policy is now narrowed to what the app does. Device diagnostics are
described as device-only, including that the support report is a GitHub
issue pre-filled in the user's own browser which they choose whether to
submit. The server-side section is retitled to say plainly that the
current app does not send error records, while keeping the description of
what such a record contains — that text still governs anything captured
before the change, and it has to be accurate again before capture is
reinstated. The claim that the per-event UUID appears in filed GitHub
issues is removed outright: the issue builder emits no such identifier,
so the cross-reference it promised never existed. The erasure right is
kept and explicitly marked live regardless of the pause, because it is —
the app wires the erasure endpoints, and the control still reaches
records captured earlier.

Two further stale claims surfaced in the same document while checking
this one, and are corrected here rather than left for a second pass. The
"right to access" and "right to erasure" bullets both directed the reader
to buttons in the Diagnostics drawer, and described erasure as clearing
"every wallet-keyed journey-log entry". Those controls live on the app's
Data Rights page, the drawer states outright that it has nothing to
export, and there is no wallet-keyed journey log to clear. The rewritten
bullets name the right page and state two limits the old text left out:
that browser storage is per-origin, so clearing it does not reset the
marketing site, and that erasing server-held error-diagnostics records is
a separate signed request.

Review then caught the narrowing over-correcting, which is worth
recording because it is the mirror-image mistake of the one being fixed.
Saying flatly that no error record is transmitted was itself false: a
support ticket sent with the attach box ticked carries the same redacted
diagnostics block to our servers, on a shipping, user-consented path. The
claim is now scoped to *automatic* capture, with the consented path
disclosed beside it. Three other absolutes went the same way. The local
record is not kept whenever "something fails" — only a crashed screen or
a failed transaction reaches it. The pre-filled GitHub report is not
"exactly what the drawer showed": the drawer previews 300 characters and
no component trace, while the report carries up to 1,200 characters of
error text and 1,000 of trace, so the policy now tells the user to read
it before submitting. And the export is not browser-wide, because a
little data is per-tab — the app's own in-product copy already said so.

A second review round found three more, one of which changes what the
policy tells users about a moment that matters. The support report is a
GitHub issue opened through a pre-filled link, and the diagnostics travel
inside that link — so they reach GitHub when the form opens, not when the
issue is submitted. The policy had said the data left only on submission,
which misstated both the timing and the recipient; a user could read the
form, close the tab, and reasonably believe nothing had been sent. It now
says plainly that opening the form sends the details, and that the
remaining choice is whether to file an issue rather than whether GitHub
receives them. The other two: the local record covers write failures
generally, including a gasless offer that fails before anything reaches
the chain, not only submitted transactions; and cross-tab erasure is a
best-effort announcement, so a tab that cannot hear it keeps its own
session data until it closes.

Review also found a third surface, which is the reason this is worth
reading as more than a wording change. The Data Rights page carries its
own legal footer from the locale bundle, and it told visitors — in all
ten languages — that "we record every UI error event server-side with a
per-event UUID". Left alone, the site would have shipped two live pages
giving the same user opposite answers about whether their errors are
collected. That footer is corrected in every locale, and its final clause
now points readers at the policy for what a support report they choose to
send contains.

Both halves of the hand-maintained mirror move together — the canonical
policy document and the published page — and the policy goes to version 4
with today's effective date, since what it claims about collection has
materially changed. The functional spec gains the intent behind all of
this, including that a paused collection path should say so rather than
being deleted, and that the two mirror halves have no automated equality
guard and must be edited as a pair.

Closes #1975.
<!-- assembled-fragment: 1975-privacy-policy-narrowed.md sha256=7d2b2351edb5ec8e13e10a575741e7d41f2d96896bf3011e066920eab8bfd71f -->

## Thread — The cron-slot gate constrains its authority instead of parsing Markdown (PR #2025)

The gate that keeps the Cloudflare cron-slot count stated in exactly one
place had been slowly acquiring a Markdown implementation. Across roughly
thirty review rounds on #1978, two thirds of everything raised landed on
that one file, and the later rounds were almost entirely markup edge
cases — the indentation rule alone went through four iterations, each
correct about the example in front of it. Four more findings were deferred
together rather than fixed, because they were one question rather than four
bugs: how much of CommonMark should a gate whose job is to stop ten notes
disagreeing about a count of five actually implement?

The answer taken here is the one that already worked in this file once
before. An earlier round replaced about eighty lines of HTML-comment
tracking with a rule forbidding HTML comments in the authority outright,
and that closed three rounds of findings permanently. The same move applies
to three of the four deferred findings, so the authority may now no longer
use indented code blocks, block quotes, or a backslash before a table pipe.
Each rule is decidable by looking at a single line, and each was measured
against the document before being written — the file already satisfied all
three, so the constraint costs an editor nothing today.

The fourth finding is deliberately not closed this way and is left as a
documented approximation. It concerns brace depth when a JSON object opens
on the same line as its first key, in the Worker configuration files the
gate reads but does not own. There is no constraint to impose on an author
the project does not control, and the honest position is to say the config
scanner approximates rather than to pretend otherwise.

Two details worth recording. The rules are wired into both the offline and
the live entry points in the same commit, because the file already carries a
note observing that checks get written into one and forgotten in the other.
And the constraint caught its own documentation on the first run: the
section explaining the pipe rule originally spelled the escape sequences
out, and the gate rejected the file. The fix was the one its own diagnostic
recommends — reword so no escape is needed — which is reasonable evidence
the constraint is liveable rather than merely enforceable.

Closes #1990.
<!-- assembled-fragment: 1990-cron-slots-constrain-not-parse.md sha256=990fdbaf6b57a54e861859afff2a9a768536ae8b8da1f6b4ca61b35aee4a1c73 -->

## Terms acceptance now links the exact text it records (PR #2010)

The app's Terms gate records a wallet's acceptance against a specific
version and a fingerprint of that version's exact text. But the link it
offered — "read the Terms" — pointed at one mutable page. During a
Terms rollout the new text is published before the on-chain version
flips, so for that whole window the page showed the NEW terms while the
gate recorded acceptance of the OLD ones: a user could read one
document and sign for another, and nothing anywhere could notice.

The marketing site now keeps every published Terms version at its own
permanent address, frozen forever, with the current version still at
the familiar unversioned address. The gate links the pinned address for
the exact version it is asking the wallet to accept, so the text read
and the text recorded are the same document even mid-rollout — and an
acceptance recorded years ago stays one click from the text it bound.

The page now renders the canonical Terms document itself — the exact
bytes its published fingerprint covers — rather than a hand-maintained
copy of it; review of the first draft found the old copy had already
drifted from the document it claimed to mirror, which is precisely the
class of silent divergence this whole change exists to end. An older
version announces that a newer one has been published and points at it,
worded carefully: during a rollout the version being accepted can lag
the newest published text, and the old page may be exactly the document
a pending acceptance records. Each version's page publishes a
fingerprint of its canonical source, checked automatically against that
source on every build — including builds triggered by edits to the
canonical document alone. And a pinned address for a version the site
has not published yet says so honestly — telling the reader not to
accept text they cannot see — instead of failing as a bare error page.
Archived versions are kept out of search indexes so the unversioned
address remains the one search results carry.

Closes #1998.
<!-- assembled-fragment: 1998-version-pinned-terms.md sha256=2828980aa2ce1b15c754169f0b9fe8eccd930f12dd0ef2471ced6d1801e5a4ea -->

## Smart-contract wallets can now use every signed control (PR #2013)

Every signed request the support service accepts — the diagnostics
erasure and its retention check, linking and unlinking Telegram
alerts, the test alert, muting due-date reminders — used to be
verifiable only for an ordinary wallet: the service recovered a plain
signature and required it to match. A smart-contract wallet account —
a Safe, a smart wallet, deployed or not yet deployed — signs
differently, by having its own on-chain account approve the message,
and every one of its requests ended in failure. The erasure card
worked around it by detecting such wallets and pointing them at
email; the alert controls did not even do that.

The service now verifies those signatures properly, against the
network the account lives on, through one shared verifier used by the
whole family. An ordinary wallet's signature still verifies instantly
with no network call; a smart account's is checked with the network
the signed request names — any network the service can talk to,
whether or not Vaipakam is deployed there, since the check needs
only the account's own contract — or, for the erasure requests, whose frozen
wording predates the idea of naming a network, the network the app
sends alongside, which chooses only where the check runs and never
what it proves. The detection workaround in the erasure card is gone:
every account type gets the signature controls.

One distinction is kept deliberately honest. When the service cannot
REACH the account's network to check a signature, it says so — a
dedicated "could not verify right now" answer, with its own message
in the app — rather than calling the signature invalid, which it has
no grounds to say and which would send the user into retries that
cannot succeed. That honesty is defended in depth: the service makes
the verification call itself, so a network refusing or failing that
call reaches it as exactly that — never disguised as a wrong
signature; a network must prove it is the network the request named
before either answer counts; and when a request names no network,
the number the service will consult is capped — with the capped case
also reported as "could not fully check", never as a rejection a
skipped network might have contradicted.

The on-chain checks also cost the service calls to networks it pays
for, on requests nobody has yet proven anything about — so they are
metered per caller, the way the service's other abusable surfaces
already are. An ordinary wallet's instant verification is never
charged against that budget.

Authority proven by one network's account contract stays scoped to
that network. A smart account can have different controllers on
different networks, so a signature its Base contract approved must
not disturb what its Arbitrum contract governs: unlinking Telegram
alerts under such a signature disconnects that network's alerts
only, and an erasure request erases that network's records only —
with the signed wording, the service's confirmation, and the app's
message all saying that scope plainly, so nobody reads a one-network
action as a wallet-wide one. The confirmation NAMES the network the
service says it covered — never "the network you are connected to",
because the wallet can be on a different network by the time the
message renders. An ordinary wallet's signature proves
the one keyholder everywhere and keeps the wallet-wide behaviour.
The retention check still answers for the wallet as a whole: legal
holds have no per-network granularity for the answer to narrow to.

The admin-only legal-hold endpoint keeps its ordinary-wallet-only
verification by design: that flow derives WHO is calling from the
signature itself, which only ordinary signatures can do, and the
protocol admin is an ordinary wallet.

Closes #2009.
<!-- assembled-fragment: 2009-erc1271-signed-endpoints.md sha256=6fe1b98a9001f8c329702b6b5a4e432b437cdc8db78bd885d951a3a9de824251 -->
