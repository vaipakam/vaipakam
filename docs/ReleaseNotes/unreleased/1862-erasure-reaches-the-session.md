## Thread — "Delete my data" now signs you out and removes the wallet session (PR #<n>)

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

Giving up also no longer leaves a wallet free to act afterwards. A wallet asked
to disconnect can take longer than the page is willing to wait and then finish
anyway, minutes later, writing its state back into storage that had been
cleared in between — so the device ends up holding exactly what the user was
told had been removed. Anything that arrives late is now cleared up after it.
What is *reported* does not change: that report was fixed at the moment it was
made, it already says the wallet held out, and a message that quietly rewrites
itself later would be its own kind of untruth.

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
