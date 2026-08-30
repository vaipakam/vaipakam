## Thread — Narrow the Privacy Policy to collection that actually happens (PR #<n>)

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

Both halves of the hand-maintained mirror move together — the canonical
policy document and the published page — and the policy goes to version 4
with today's effective date, since what it claims about collection has
materially changed. The functional spec gains the intent behind all of
this, including that a paused collection path should say so rather than
being deleted, and that the two mirror halves have no automated equality
guard and must be edited as a pair.

Closes #1975.
