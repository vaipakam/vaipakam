# Release Notes — 2026-08-29

Four user-facing threads landed today, all in the connected app's
orbit: the Data Rights page returns (download or erase what the app
keeps in the browser), a Terms acceptance made in one tab now closes
the prompt in every open tab instead of inviting a second paid
acceptance, alert preference saves stopped posting the whole
record — a fresh device can no longer overwrite choices made
elsewhere by saving its own assumptions — and the Data Rights page
gained the in-app signed request for erasing the error reports
support keeps, the control the Privacy Policy had promised. Alongside
the alerts change, the functional spec now records the deliberate
posture that Terms enforcement for notification settings lives in
the app (#1999).

## Connected app — you can take your data with you, or remove it

The connected app now has a Data Rights page: one button to download
everything it keeps in your browser, another to erase it. Reachable from
Settings, under "Your data".

This is a control being put back rather than a new idea. The old
connected app had one, and it went out with that app. The main
vaipakam.com site still has its own version, which is easy to mistake
for covering this — it does not, and cannot. A browser keeps each site's
data in its own compartment, so the buttons on one site genuinely have
no way to read or clear what another site stored. Two sites, two sets of
data, two pages. There was no way around that; the page had to be built
here.

**The download** is a single file you can keep or read: display
preferences, alert settings, which notifications you have already seen,
and markers for anything you started and did not finish. It is written
in plain JSON, so it is readable without any special tool.

**The erase** removes the same set from the device you are on. The page
tells you how many items are stored before you confirm, and how many
were removed afterwards — not just "done". That distinction matters more
than it sounds: some browsers, particularly private windows and
locked-down privacy settings, refuse to let a site clear its own
storage. Reporting that as success would be a false assurance about a
legal right, so a refusal says so plainly and points at the browser's
own settings, which do work. A download taken while part of the storage
refuses to be read carries the warning inside the file itself, naming
what is missing — the file travels away from the page, so the page's
warning travels with it.

Just as important is what the page says it **cannot** do, stated as
prominently as what it can:

- **Anything on the blockchain.** Every transaction you have signed is
  public and permanent. Nobody can erase them, this protocol included,
  and a page implying otherwise would be misleading about the one thing
  people most want to hear. Your wallet address is the one exception the
  page names: where you saved per-wallet settings it is part of what
  this browser stores — and so part of the download, which says so
  itself, so the file can be judged before it is shared. Erasing removes
  those local copies; nothing on the chain changes.
- **Alerts.** If you linked Telegram, that link is held by the alerts
  service, not your browser. Unlinking in Settings is what removes it.
- **The main site's own data**, which has its own controls there.
- **Error reports held by support** — beyond the local controls'
  reach, but not beyond the page's: later the same day the page
  gained its own signed erasure request for them (the fourth thread,
  below), with email remaining the fallback route.

Two shared-domain preferences sit in this browser and are disclosed in
the download and removed by the erase: the language, which both sites
genuinely read, and the main site's own theme, which this app never
uses — this app's theme is stored separately and is not shared.
Erasing fully resets this app but not the main site, which keeps its
own copies and restores them on your next visit; removing those is
what its own data controls are for. All of it is said on the page
rather than left as a surprise.

One deliberate choice worth naming: the page does not reload after
erasing. The old version did, which meant the confirmation vanished
before anyone could read it — you were returned to a blank-slate page
with no word of what had happened, on the one screen where being told
what happened is the entire point.

Accepting the Terms of Service is never required to reach any of this.
A right you can be locked out of until you accept a legal document is
not a right, so this page stays open whatever the terms say.
<!-- assembled-fragment: 1960-data-rights-connected-app.md sha256=50a084244fe5d0de261f0bd74c20f72c7ad9632cdba77a16e32187863ce9ad42 -->

## Alert saves carry only what the user changed (PR #2005)

Saving an alert preference used to post the whole preferences record —
the three health-factor bands always travelled, whatever the save was
about. Those bands are how the "risky loan" lane's state is expressed
(real bands mean on, floor bands mean off), so a device that had never
seen the wallet's preferences would, on its very first save of anything
— a due-date opt-out, say — also write its own default lane state over
an opt-out the user had made on another device. The client could not
tell "the user wants risky alerts on" from "this device was never told
otherwise", because both read as the defaults.

The wire contract now matches the rule the due-date field already
carried: a save sends only what the user changed in it. The alerts
service accepts a request with the band fields absent — as a set, all
three or none — and preserves the stored values, writing the standard
defaults only for a wallet with no record at all (for whom the default
state is genuinely the current state). The connected app sends the
bands only on a save that touched the risky lane: the toggle itself,
or the advanced band numbers behind it. A first save from a fresh
device therefore writes nothing the user did not touch, which also
closes the known residual noted in the Terms-gate work: a held user's
first opt-out no longer ships the untouched lane's bands to a channel
the wallet linked elsewhere.

Deployment order: the alerts service should deploy BEFORE the
connected app, since the old service refuses the new app's slimmer
saves. The app also carries a rollout shim for the out-of-order
window: a slimmed save the old service refuses is retried once in the
previous full-record shape — no worse than every save before this
change — so nothing breaks either way; the shim never fires once both
sides are current.

Closes #2000. The sibling question — whether the alerts service should
verify Terms acceptance itself — was settled the same day: #1999 recorded
the client-side posture in the functional spec as the deliberate position
for the alerts surface (PR #2006).
<!-- assembled-fragment: 2000-alert-saves-post-only-changes.md sha256=8fe5e82f44d69685fa71af7a6c2accdde1fcb62e03947c56eb594e8461b8f3bb -->

## A Terms acceptance now closes the prompt in every open tab (#2001)

Accepting the Terms of Service costs a transaction, and the protocol
happily accepts a second one from the same wallet — it changes nothing
but a timestamp and still charges gas. The app already made sure the
tab you accepted in could not offer that second transaction; a second
open tab, holding the same wallet, could. It still showed its own
prompt with a working Accept button until its next background refresh,
and the moments right after accepting in one tab are exactly when
someone is most likely to click in the other.

Now the tab that accepts tells every other open tab, the instant the
transaction is confirmed. In the ordinary case the others close their
prompt and allow the wallet's next action without asking again — and
they take on the same safeguards the accepting tab has, for the same
bounded time, expiring at the same moment everywhere: an acceptance
undone by a chain reorganisation is not believed anywhere for longer
than in the tab that made it. An acceptance that took unusually long
to confirm — congestion can hold a transaction pending past that
bounded window — is announced as a signal to re-check instead: the
other tabs verify against the chain at once and close their prompt on
what they read, rather than taking the late news on trust. A tab that has meanwhile learned of a newer terms
version is deliberately left prompting: an acceptance of older text
never opens the gate on newer text.
<!-- assembled-fragment: 2001-cross-tab-acceptance.md sha256=06a212962430d0663ebc184b2ecdec23864b60a0c2fd060524bba4607c78b45f -->

## The promised in-app erasure of support's error reports now exists (#2008)

The Privacy Policy tells users, as a statement of legal right, that the
error-diagnostics records associated with their wallet can be erased
"by signing an erasure request with that wallet in the app". The
service behind that promise has existed for months; the app control had
not. A user who went looking for it found only the Data Rights page's
honest admission that error reports held by support were out of its
reach.

The control now exists, on that same page. Connect the wallet, sign a
free message — not a transaction, no gas — and the request goes to the
service, which erases the records keyed to that wallet. A companion
check asks whether anything was retained. One timing note for
operators: this ships the APP side of the promise. The erasure
service's deployment itself remains gated on the recorded
crypto/privacy-lawyer sign-off, and a build not configured with the
service's address says so honestly and offers the email route — the
page never pretends at a control the deployment does not yet serve.

The interface is deliberately as reticent as the service it talks to.
The service's confirmation is uniform by design: it never says whether
any records existed, because records can be under a legal retention
order the service is forbidden to mention, and one wallet's answer must
not read differently from another's. The page says exactly that, in the
same words to everyone, rather than dressing the confirmation up as
"deleted N records". The retention check reports something only where
the law permits saying so, and its quiet answer is phrased as "none are
reported" — never "none exist", which the page cannot know.

The signed message itself now lives in one shared module imported by
both the app and the service — the two must produce byte-identical
text, or every request would be rejected, and a second hand-written
copy was the likeliest way this feature could have shipped broken.
The two operations sign different messages, each saying what it
authorises: the words a user signs to look at their records can never
be replayed as authority to delete them.

A signed request is only valid for ten minutes, and the wallet's
approval prompt has no such clock — so an approval given too late to
reach the service in time, or stamped by a computer whose clock
disagrees with the service's, is reported as "expired, try again"
rather than as a failure the user can't interpret. A signature that
visibly aged out while the prompt was open is never sent at all; the
clock-skew case can only be seen by the service, whose rejection is
translated into the same actionable answer.

One honest limit, stated where it applies: a smart-contract wallet's
signatures cannot be verified by the support service yet, so a
deployed one is shown the working email route instead of a prompt
that could only fail. Verifying those signatures properly, across
every signed request the service accepts, is tracked as its own
follow-up (#2009).

Closes #2002.
<!-- assembled-fragment: 2002-in-app-signed-erasure.md sha256=8802c566160282bafbdbbec7d8b8c7c785425b5e66c69d6d351261edc553dd67 -->
