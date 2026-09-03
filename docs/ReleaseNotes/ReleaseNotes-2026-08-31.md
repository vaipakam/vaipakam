# Release Notes — 2026-08-31

Six entries, and four of them are the same kind of correction: a promise the
platform had already made in writing, kept in fewer places than the wording
implied.

Three concern what leaves a device or stays on it. A support report is a
pre-filled public issue, and both the report builder and the Privacy Policy
say a full wallet address never travels in one — an address arriving
percent-encoded passed the scrubber untouched, and a single decode recovered
it. "Delete my data" said the browser had been cleared while the wallet
libraries' own storage, where the live session actually lives, went untouched
— so the next page load reconnected the account the user had just been told
was signed out. And erasing then had to end the connection as well as remove
its traces, in every open tab, without destroying a session the person started
afterwards.

A fourth is about the tokenomics documentation rather than the code: the VPFI
fee discount had been described as an average over a loan's life for months
after it stopped being one, and the naming was the reason nobody noticed —
a reader checking the function name would have concluded the docs were right.

The remaining two are operational, and share a theme with the rest. A deploy
could silently delete the operator-tuned variables a Worker depends on unless
every invocation remembered a flag; that is now a property of each Worker's
configuration rather than something a future call site has to get right.

What unites them is worth stating: none was a feature that failed. Each was a
guarantee whose wording had outrun its reach, which is the harder kind to
notice, because everything keeps working and only the promise is wrong.

## Thread — Support reports no longer leak percent-encoded wallet addresses (PR #2026)

The Diagnostics drawer builds a support report as a pre-filled GitHub issue,
and everything in it passes through an address shortener first — the module
states the contract in its own header, and the Privacy Policy repeats it to
users: the full wallet address never leaves the device via a report. That
held for an address written plainly and did not hold for one that arrived
percent-encoded.

The page address the report carries is taken raw from the browser, and a
browser does not decode escapes in a query string. So a link carrying its
wallet parameter in encoded form presented no recognisable address to the
shortener, and the untouched escape sequence travelled to GitHub — where a
single decode recovers the full address, on a public issue tracker. The
scope is narrow, since it needs a user to arrive on such a link and then
open a report, but a redaction promise is exactly the kind that should hold
without qualification.

The shortener now finds those too. It decodes for the search only and keeps
a map back to the original text, so the shortening is applied to the span
the address occupied and everything around it keeps its exact spelling —
the rest of the link still reads as the user had it, which is part of what
makes a report useful to support. Decoding is done by hand rather than with
the browser's own decoder, which rejects malformed escapes by throwing: a
helper that runs inside the crash reporter must not become a crash source,
so a stray percent sign now passes through untouched instead of ending the
report.

A recorded error is whatever the failing code handed the browser, and a
provider can hand it several megabytes. The shortener now stops reading at
64 KB in every case — including the ordinary one where a message carries no
escapes at all, which had been quick enough per character to step around the
limit unnoticed — and marks the report truncated there, rather than scrubbing
the whole of a message the report keeps twelve hundred characters of — a few seconds
of a frozen drawer, immediately after the failure someone is trying to
report, is a poor way to ask for help. The cut is also moved back off anything that could be part of an address
before any shortening happens, so a report can never carry the front half of
an account. Getting there took six attempts at the opposite arrangement —
shorten first, then tidy up whatever the cut broke — and each one had to
decide, by appearance alone, whether a piece of text was the shortener's own
work or something the user had written. That is a question about text someone
else controls, and each answer was defeated by a slightly different way of
writing the same thing. Doing the two steps in the other order means the
question never arises. How far back that step reaches cannot be fixed in advance, which took one
more correction to see: a limit of a few dozen characters was set by how long
an address is, but an address written with escapes can be spelled at any
length, so a deeply escaped final digit simply ran past the limit and left the
rest of the account behind it. The step now goes back as far as the run of
address-like characters goes, and stops at the first character an address
cannot contain — a space, a newline, a colon — which ordinary text supplies
constantly. Two things are given up for that, both at the very end of a
message that is already being cut short: an address finishing exactly at the
cut is dropped rather than shortened, and a passage made of nothing but
address characters loses the whole run.

There are two situations the shortener cannot fully account for: a message
too large to read in full, and escapes nested too deeply to unwrap within a
sensible amount of work. In both it now discards the escaped material rather
than passing it on, and — this was the subtler half — discards any hex sitting
against it. Removing only the escapes had looked like the cautious choice and
was not: where just the leading `0x` of an address was escaped, taking the
escapes away left all forty of the remaining characters in place, and a reader
of the public issue is a fixed two-character prefix from the whole account. An
address can be broken at any point, so no leftover is safely short. The cost is
that a word spelled entirely in hexadecimal letters is discarded alongside a
neighbouring escape in those two cases, which is the right way round.

The same promise is made twice, and it was only being kept once. A support
message sent from the app's contact form goes to a service that shortens
addresses again on arrival, on the stated grounds that it cannot trust
whatever built the request — a point that covers a deliberately crafted one
and, more ordinarily, a browser still running yesterday's copy of the app.
That second check knew only how to recognise an address written plainly, so
an encoded one passed it and was stored and forwarded intact. Both sides now
share a single implementation of the rule rather than keeping their own
readings of it, which is also the only way a promise this detailed stays true
in two places as it changes.

The behaviour arrived with its first tests. Nothing had covered the
shortener before, which is how the gap survived unnoticed, and the new cases
are written against the contract rather than the code: what must never
survive a report, and what must survive it intact — a transaction hash stays
whole, and an encoded hash must not decode into a false match. Disabling the
new handling fails exactly the encoded cases and leaves the rest green, so
the tests pin the fix without freezing the parts that were already right.

Closes #2024.
<!-- assembled-fragment: 2024-redact-encoded-addresses.md sha256=1b7b8f183880280303f769efbbecb4fbbf0774a0a94dd84538cfcb56f69de901 -->

## Thread — "Delete my data" now reaches the wallet libraries' own storage (PR #2029)

The connected app's Data Rights page offers two controls: download what the
browser holds about you, and delete it. The delete control looked only for
storage under the names this app writes, and the wallet connection is not
written by this app — it is written by the wallet libraries the app uses, under
names of their own choosing, which no amount of searching this app's own source
would ever reveal. So the deletion passed over it and reported success.

Four such names are now covered: the wallet-connection library's own store and
three belonging to the two wallet transports the app offers.

**What that does and does not achieve differs by which wallet you use, so it is
worth being specific rather than summarising.** The wallet-connection library's
own record of which wallet you last used is removed for everyone. Beyond that:

- **Coinbase Wallet used by scanning a code from the phone** keeps its session
  identifier, secret and cached addresses in ordinary browser storage, and
  those are now removed.
- **Coinbase's smart-wallet mode** keeps its active key in a separate browser
  database this deletion does not open, so that key survives.
- **WalletConnect** likewise keeps its live session in that separate database,
  so a scanned-code session survives.
- **Any browser extension — MetaMask, or the Coinbase extension when it is
  installed** — holds the authorisation itself, outside anything this app can
  read or remove. The Coinbase extension belongs here rather than with the
  phone-scanning case above: when it is present the library talks to it
  directly and never writes the session material that case is about.
- **The app opened inside a Safe** takes its authorisation from the Safe it is
  embedded in, which is likewise untouched.

The app's in-memory connection is not dropped in any of those cases, so nobody
is signed out at the moment of deleting — and for the last two, nothing this
control can reach would sign them out at all.

An earlier draft of this note promised that you would at least be signed out
after reloading. That is not reliably true and the claim is withdrawn: the app
reconnects on load, and a wallet that still considers this site authorised will
simply reconnect. Closing that properly means asking the wallet libraries to
tear down, which is a different and asynchronous piece of work tracked as the
remaining half of #1862.

Downloading and deleting no longer look at the same set, deliberately. A
download is a file the person can keep and forward, and wallet session material
does not belong in one; leaving that material on the device, on the other hand,
is what made the deletion incomplete. So the download still carries what this
app stored about you, and the deletion reaches further.

Two things are stated in the code rather than left to be inferred. The first is
how each name was established: one was confirmed by reading the code that builds
it, and three were found only as fragments inside a shipped library bundle,
because the full names are assembled while the page runs. The second follows —
matching is deliberately generous, on the reasoning that this app has its
browser origin to itself and removing slightly too much is a better failure than
leaving an account connected.

Finally, the page's own arithmetic was corrected at both ends. It had counted
what remained using the same narrow rule the deletion used to use, so a name
that refused to be removed would not have been counted and the page would have
reported a clean success over storage still present. A check that cannot see
what the deletion aims at is not a check. The figure offered *before* the
confirmation had the same fault, with a stranger result: a browser holding only
wallet records was told nothing was stored, and then had those records deleted
when the person confirmed anyway — the page disagreeing with itself either side
of one click. Both figures now describe what the deletion actually reaches.

Two pieces of writing were corrected alongside it. The privacy policy described
the download as reaching no further than the deletion, which stopped being true
the moment the deletion reached further; it now says what the download leaves
out and why, rather than describing it by comparison. And the specification
still called being signed out an intended consequence of the deletion, which
this deletion does not do for any wallet.
<!-- assembled-fragment: 1862-erasure-reaches-connector-storage.md sha256=18c26141f61d27562241312c60c5c4c7bb21353f1f843345ae27d61c4ec2241e -->

## Thread — "Delete my data" now signs you out and removes the wallet session (PR #2034)

The first half of this work taught the deletion to look for the names the wallet
libraries write, and said plainly what it still could not reach: the live
session, and the connection itself. Both are now reached.

**The session was never in the place the deletion was looking.** The wallet
libraries keep their working state in a browser database, not in the ordinary
key-value storage the first half swept. So a person could delete their data,
see it succeed, reload, and find the same wallet connected — because the thing
that reconnects it had not been touched. The deletion now opens those databases
and empties what the wallet libraries keep there, and it closes the connection
first rather than leaving the app attached to a wallet whose session has just
been removed underneath it.

Reading the library to find the database name settled something the first half
had left as an assumption. That library moves anything it finds in the older
storage into the database and then deletes the older copy — which means the
names the first half matched on reach, at most, a leftover from before that
move. The material that mattered was always in the database.

**Emptying, not deleting.** The first attempt at this deleted the whole
database, and would have failed on nearly every real browser. A browser
refuses to delete a database while anything still has it open — and the thing
holding it open is this very page, through a handle the wallet libraries never
close. So the deletion would have waited on us, and the message it showed on
failure told the reader to close their *other* tabs: an ineffective control
with a remedy pointing away from the cause. The erase now empties the stored
session in place, which is an ordinary write and cannot be held up that way,
and which removes exactly the material the deletion was for.

**The order is still the mechanism.** Disconnect, then sweep, then clear.
Erasing while the wallet client is still running is a race — it can write its
session straight back — so closing the connection first is what ends it. The
sweep goes second because disconnecting writes on the way out: the wallet
library keeps a copy of its own state in browser storage, and closing a
connection changes that state.

**What happens when it does not work is the part worth reading.** Two things
can hold out, and they are not interchangeable, so they are never reported as
one:

- **The stored session would not clear.** The page says it may still be on the
  device and points at the browser's own site-data controls, which do work. It
  does not say the data was erased, and it no longer blames other tabs.
- **The wallet refused to disconnect.** Everything else is still removed — a
  wallet declining to let go must not stop the rest — but the page says the
  site is still connected and that you can disconnect from the wallet itself.

Neither waits forever. A wallet that never answers at all, rather than
refusing outright, would otherwise leave the page working indefinitely with
nothing erased, so both waits are bounded and running out of time counts as
holding out.

Where the app can also *stop* the abandoned work, it now does. Giving up on
reading the wallet's own storage aborts that read and lets go of it, rather
than leaving it running: an abandoned operation is what a second attempt
queues behind, and the hold it keeps is exactly what blocks the browser's own
delete-site-data — the remedy the failure message sends you to. Giving up on a
*wallet* is not the same and cannot be: nothing here can cancel a request a
wallet has already accepted, which is why what happens when one finishes late
is described below rather than claimed away.

A wallet that finishes late is now usually cleared up after — with one
deliberate exception, stated here because it is a limit rather than an
oversight. A wallet asked to disconnect can take longer than the page is
willing to wait and then finish anyway, minutes later, writing its state back
into storage that had been cleared in between, so the device ends up holding
exactly what the user was told had been removed. That late write is now tidied
away **unless you have connected again in the meantime**: the tidying cannot
tell one wallet's records from another's, so where a newer session exists it is
skipped rather than risk deleting the session you are using. A wallet that
never finishes at all is never tidied either, for the plain reason that there
is nothing to tidy after. So the honest summary is that a late write is cleared
when clearing it cannot cost you anything, and a leftover connection record is
accepted when it could. What is *reported* does not change in either case: that
report was fixed at the moment it was made, it already says the wallet held
out, and a message that quietly rewrites itself later would be its own kind of
untruth.

**And the number it reports counts everything it removed.** The page had
learned to stop saying "nothing was stored" after clearing a wallet session,
but the sentence it switched to still counted only the ordinary storage — so
the same erasure went on to announce that it had erased nothing. The figure now
spans the same ground the sentence claims, in the partial report as well as the
successful one.

**The count offered before you press the button covers what pressing it will
remove.** It did not: it described the ordinary storage while the button
erased the wallet session too. So someone holding a session and one saved
preference was shown "1 item" and then told four were erased, and someone whose
ordinary storage happened to be empty was told nothing was stored at all,
moments before their wallet session was removed. A figure shown next to a
button is a promise about that button. Reading the wallet's own storage to
answer takes a moment, and where it cannot be read the page says it could not
look rather than presenting an incomplete total as a complete one.

**Every wallet, not the one in use.** Asking to be disconnected turned out to
disconnect a single wallet — the current one — and then quietly promote the
next in line, so someone with two wallets connected would be signed out of one
and told they were signed out. The one still attached is a running client, free
to write its session back into storage the erase had just emptied. Every live
connection is now ended, and the sign-out is claimed only if all of them let
go.

**Being signed out now survives a reload.** This was the sharpest thing the
review found, and the erase had done it to itself. Disconnecting leaves behind
a small note saying "do not reconnect on your own" — that note is what stops
the next visit from silently reattaching the wallet. The erase was deleting it,
along with everything else the wallet library had written. So the sequence was:
sign out, delete, reload, connected again. The note is now kept. It costs
nothing to keep: its entire content is the word "true", it names no wallet and
holds no session, and keeping it is what the person who pressed the button
actually asked for. A Safe was worse — it kept no such note at all, and had no
way to stay disconnected across a reload — so it is now configured to keep one.

**Other tabs are asked to sign out too.** Being signed in is per-tab in the
same way per-tab storage is, so a second tab left open would have carried on
connected through an erasure that reported signing you out. It is now asked to
disconnect on the same signal that asks it to clear its own storage. Like that
one, it cannot report back — so the page confirms only the tab you are looking
at, and says the others were asked. A tab that was *already* signed out is now
left alone: acting on the request writes, and a tab with nothing to disconnect
was writing back into storage the erasing tab had just cleared.

**And a second tab now catches up with itself, not just with its storage.** It
was clearing its data and letting go of its wallet while carrying on showing
the theme, the display mode and the language the erasure had just removed —
data the user had been told was gone, still on screen. The values only lived in
memory by then, which is not a distinction the promise makes. Everything a
second tab can reset, it now resets. All of it without writing: those resets
happen after the first tab has already cleared the shared storage, so anything
written lands in a store that was just emptied and simply stays there. Where the
ordinary way to change something saves it, the second tab removes what it
saved.

Each of those messages replaces a success that would have been true of the
storage and false of the session. Reporting "erased" over a live connection is
the same failure this page was built to avoid, one layer further along.

**Four things it still cannot promise, said here rather than discovered.**
Each is being tracked separately, and each is the kind of limit a person
would rather read than meet.

- **A wallet still signing itself back in may not be stopped.** If a saved
  connection is in the middle of being restored when you erase, the app can
  ask it to stop and cannot guarantee it hears — the restoring connection may
  finish afterwards and put its details back. The page does not claim
  otherwise: it reports that the wallet would not disconnect.
- **Coinbase Wallet on a phone reloads the page as it disconnects.** That is
  the wallet's own behaviour and nothing on the page can prevent it. The
  reload can arrive while the erasure is still running, so it may take away
  the confirmation, the remaining steps, or both — this is the one case where
  pressing the button may leave the work unfinished and say nothing about it.
- **In a language other than English, the confirmation can be lost too.**
  Erasing returns the app to English, and changing language rebuilds the
  screen — which can take the report with it. The data is erased either way.
- **With the app open in more than one tab, two things can go wrong, and this
  is the only limit here that can cost you something.** A second tab tidies up
  after signing itself out, and if that takes a long time — a wallet that is
  slow to answer — the tidying can arrive after you have gone back to using
  that tab, and remove a wallet session you started in the meantime. The other
  way round, a second tab can clear the wallet's stored session a moment
  before the tab you pressed the button in looks at it, so the count you are
  shown can read zero over records that were removed.

The third is the milder shape of the second: the erasure completes and the
*evidence* of it does not survive. On a page whose whole purpose is telling
you what happened, even that is a real gap rather than a cosmetic one, which
is why both are written down here instead of left to be found. The fourth is
listed last and is the one to read twice — it is the only case where erasing
can remove something you did **afterwards**, or report a number that is
wrong. Every other limit above leaves you with less reach than you wanted;
that one can leave you with less than you had.

**The guard against that first half no longer trusts the wallet's own
account of itself.** If you connect again while a slow sign-out is still
running, the page holds back its clean-up rather than removing the session you
just started. That guard used to work by asking the wallet library whether
anything was connected — and in this exact situation that is the one question
it answers wrongly: the abandoned sign-out finishes against a picture of the
world it took before you reconnected, and reports that nothing is connected.
The guard was asking the very thing that had just lost track of your new
session. It now keeps its own count of connections made, which a later
correction cannot take back, so a session you start after pressing the button
is recognised as yours whatever the wallet library thinks. The same limit
still applies to a SECOND tab tidying up, which is tracked separately.

**A message about a partly-checked erasure no longer blames the wallet for
everything it removed.** Where the browser refuses to let the app check its
ordinary storage afterwards, the page reports how much it erased — and that
figure covers preferences and cookies as well as any wallet session. It used
to describe all of it as coming from the wallet's session storage, which for
someone who had never connected a wallet was simply untrue. It now states the
number without claiming where it came from, in every language.

**One promise is deliberately not made.** A browser extension, or a Safe, keeps
its own record that you allowed this site, somewhere no page can reach. The
erase copy now says so, and says reconnecting there is still a single click.
Someone who deletes their data and finds one click restores the connection
should have been told that here, rather than discovering it.

The page also now shows that it is working. Waiting for a wallet to answer
takes real seconds, and a button that simply greys out reads as broken rather
than busy.
<!-- assembled-fragment: 1862-erasure-reaches-the-session.md sha256=057c99b0e2094a25d4694d91f8337df1154663d1e8f8f65509cbbb3612be15d8 -->

## Thread — The deploy guard now covers the agent, and says which Worker it means (PR #1995)

A guard added earlier this year fails the build on any deploy command anywhere
in the repository that would wipe the keeper Worker's dashboard-managed
settings. It only ever knew about the keeper. The agent has the identical
hazard — its code reads two settings that its own configuration does not
declare, so a plain deploy switches recipient-token validation off and resets
how far the OpenSea integration will page — and review had already found nine
places, across runbooks and the deploy scripts themselves, telling operators to
deploy it that way. The guard could not see any of them.

It now covers both Workers, and its report names the one at fault: the right
package to deploy with, and the specific settings that deploy would have erased.
A keeper-worded remedy standing next to an agent problem sends the reader to the
wrong configuration file.

Widening it turned up one live instruction to fix — a deployment-runbook step
that told an operator to redeploy the agent plainly — and six places that merely
quote the unsafe command while explaining or recording it, which are exempted by
name with a stated reason. Two of those sit on a single line of the follow-up
list, which recorded the same completed action twice; exemptions now compose, so
a line carrying two of them is cleared, while a line carrying an exemption and a
real command is still caught.

The two operations Workers that had never been audited were audited, and
**neither belongs in scope**. One declares everything it reads. The other looks
unsafe at a glance — its configuration declares no settings at all while its
code reads five — but three of them are secrets, which a deploy never touches,
and the other two are set by writing them into the committed configuration,
where every deploy re-applies them. Its own documentation says
plainly that it needs no flags, and that documentation is correct; adding it
would have contradicted a true statement on the strength of a wrong reading. The
finding, and the evidence for it, is recorded in the guard itself so the next
person does not repeat the audit.

Scope here is deliberately evidence-led rather than cautious. Every Worker added
makes prose that quotes the unsafe command fail until someone exempts it by
hand, which is a real cost, and one worth paying only where the danger is real.

Refs #1933.
<!-- assembled-fragment: 1933-deploy-guard-covers-agent.md sha256=bb464f38183f65905e4bb853758661e4ea9d3098f641861803770951eb3aed8e -->

## Thread — Worker vars now survive a deploy by configuration, not by remembering a flag (PR #1995)

The keeper and the agent both read tuning values that live only in the
Cloudflare dashboard: liquidation thresholds and confidence windows for the
keeper, recipient-token validation and marketplace pagination for the agent. A
plain deployment wipes those, because Wrangler treats the checked-in
configuration as the source of truth and deletes anything not in it before
setting what is. The consequence is not cosmetic — it reverts live risk
behaviour to defaults at the moment it starts mattering, silently.

Until now the defence was to remember a preservation flag on every command
that deploys, and a repository-wide checker that hunted for commands missing
it. That defence is unbounded by construction: a deployment can be spelled
through a package script, an alias in a manifest, a Makefile variable, a
sourced helper, a shell function, a shell alias, a build-matrix value, a
reusable-workflow input, a Windows shim, an eval, or a marketplace action.
Review found two hundred and forty-two distinct spellings across this work and
was still finding more, because each fix taught the reviewer where to look
next. The checker was correct and getting steadily better at an endless task.

The preservation is now declared once per Worker, in the Worker's own
configuration, which is where Wrangler reads it for both immediate deploys and
staged version uploads. Every route to a deployment becomes safe at the same
moment, including routes nobody has written yet, and the five Workers that
carry operator-managed values all declare it. A small test asserts that
declaration, which is a bounded and complete check in a way that searching for
command spellings can never be.

The repository-wide checker is kept, and it now reads the same declaration
Wrangler does. That makes it defence in depth that switches itself off: while a
Worker declares preservation nothing is reported for it, and if the declaration
is ever removed the full command-level scrutiny returns for that Worker
automatically. The trade this accepts is deliberate and worth stating — a
deployment can no longer delete an operator-managed value, so removing one is
now an explicit action in the dashboard rather than a side effect of shipping
code.

Refs #1933.
<!-- assembled-fragment: 1933-keep-vars-at-source.md sha256=64e0cb77738b91739d7554a0b2bae5ad66c70c8dc37956b8750409d7487aab2f -->

## Thread — What the VPFI fee discount actually measures, said correctly (PR #2032)

Holding VPFI reduces the fees you pay. How that reduction is worked out was
described wrongly in several places: the documentation said your discount was
averaged across the life of each loan you were in. That averaging was removed
some time ago, and nothing in the fee calculation had used it since. The
documents kept describing it anyway.

**The promise those documents made is still true; only the explanation was
wrong.** They all said the same thing in the end — that topping up your
balance shortly before a loan closes gains you nothing. It does not, and under
the rule actually in force it gains you even less than the old explanation
implied.

Here is what really decides your rate. Your tier is a time-weighted average of
what you held over a recent window of at most thirty days, with the latest days
counting for more. That window never reaches back past the start of your
current run of holding — the day your balance first rose above zero and stayed
there. Adding to a balance you already have does not move that starting day, so
a top-up neither wipes your earlier days from the average nor resets anything.

The average is then pushed down to the lowest tier you dropped to at any point
since that run began, using each day's low rather than its closing figure, so a
dip counts even if you top back up before the day ends. This is a separate
look-back of up to thirty days, not the averaging window just described.

None of it applies at all until you have held a balance above zero, without
interruption, for a minimum number of days. That clock starts when your balance
first goes above zero and restarts only if it returns to zero, so adding to an
existing holding neither resets it nor has to serve it again. Both the window
and that minimum are settings the protocol can adjust within fixed bounds, and
the rate is read at the moment a fee is charged.

Those two look-backs come apart whenever the averaging window is set shorter
than thirty days: the lowest-tier rule is not tied to it, so a dip can still
hold your tier down after it has left the average.

Against the thing both designs were guarding — a deposit made shortly before a
loan settles — this is the stricter arrangement. An average over a loan can be
dragged upward by a large late deposit; a lowest-value rule cannot be dragged
anywhere. Anyone who reads the corrected text and concludes that particular
move is now easier has read it backwards.

It would be wrong to say the new rule is stricter in every way, and an earlier
draft of this note did say so. Because the lowest-tier look-back reaches back
at most thirty days, a long loan's early low-tier months eventually stop
counting, where an average across the whole loan would have kept them. The
change strengthened the defence against a late top-up and shortened the
memory.

**Where the wording was wrong, and where it was right.** Most references to
time-weighting in the documentation are correct — the tier genuinely is
time-weighted — and only the claim that the weighting ran across a loan's own
duration was false. Correcting this therefore could not be done by replacing a
phrase; each occurrence had to be read where it stood. Corrected: the project's
own contributor handbook, the whitepaper's section on the accumulator, the
overview page and the advanced user guide in all ten languages, and the
glossary. Left alone: the basic guide, which never made the claim, and the
administrative reference, which was accurate.

The architecture decision record that chose the original design keeps its text
and gains a note saying what superseded it. Release notes, archived documents
and past findings are likewise untouched. Those are records of what was decided
or observed at the time, and editing them to match today would be falsifying
them rather than correcting them.

Two internal function names that claimed to perform the removed averaging were
renamed to say what they do. This changes nothing observable — the names are
not part of any published interface — but they are the likeliest reason the
error survived as long as it did: a reader checking the name rather than the
body would have concluded the documentation was right.

Finally, worth recording because it is the encouraging part: the functional
specification, which is the document that defines what the platform is
*intended* to do, never carried the error. It said all along that the discount
applied must equal the rate in force at the moment the fee is charged, and that
figures captured when a loan opens must not drive it. The specification was
right and the material derived from it drifted — the opposite of the failure
that process is usually guarding against.
<!-- assembled-fragment: 1981-discount-not-averaged-over-a-loan.md sha256=888acb58aaad1776b3d19fa7e86642e53d377f96885335d785aaae7a0c2c6c03 -->
