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

**Other tabs are asked to sign out too.** Being signed in is per-tab in the
same way per-tab storage is, so a second tab left open would have carried on
connected through an erasure that reported signing you out. It is now asked to
disconnect on the same signal that asks it to clear its own storage. Like that
one, it cannot report back — so the page confirms only the tab you are looking
at, and says the others were asked.

Both of those replace a success message that would otherwise have been true of
the storage and false of the session. Reporting "erased" over a live connection
is the same failure this page was built to avoid, one layer further along.

**One promise is deliberately not made.** A browser extension, or a Safe, keeps
its own record that you allowed this site, somewhere no page can reach. The
erase copy now says so, and says reconnecting there is still a single click.
Someone who deletes their data and finds one click restores the connection
should have been told that here, rather than discovering it.

The page also now shows that it is working. Disconnecting a wallet and waiting
for a wallet to answer takes real seconds, and a button that simply greys out
reads as broken rather than busy.
