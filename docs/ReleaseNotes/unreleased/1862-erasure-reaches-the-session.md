## Thread — "Delete my data" now signs you out and removes the wallet session (PR #<n>)

The first half of this work taught the deletion to look for the names the wallet
libraries write, and said plainly what it still could not reach: the live
session, and the connection itself. Both are now reached.

**The session was never in the place the deletion was looking.** The wallet
libraries keep their working state in a browser database, not in the ordinary
key-value storage the first half swept. So a person could delete their data,
see it succeed, reload, and find the same wallet connected — because the thing
that reconnects it had not been touched. The deletion now opens those databases
and removes them, and it closes the connection first rather than leaving the
app attached to a wallet whose session has just been deleted underneath it.

Reading the library to find the database name settled something the first half
had left as an assumption. That library moves anything it finds in the older
storage into the database and then deletes the older copy — which means the
names the first half matched on reach, at most, a leftover from before that
move. The material that mattered was always in the database.

**The order is the mechanism.** Disconnect, then sweep, then delete. A wallet
that is still running is the most likely reason a database cannot be deleted —
browsers refuse to delete a database anything still has open — so closing the
connection first is what gives the deletion a chance to succeed. The sweep goes
second because disconnecting writes on the way out — the wallet library keeps a
copy of its own state in browser storage, and closing a connection changes that
state — so a sweep placed first would leave the last few names behind.

That is a reason rather than a promise, and the difference is written into the
code: whether a particular wallet closes its database when asked to disconnect
is not something this app can guarantee. Which is exactly why the next part
exists.

**What happens when it does not work is the part worth reading.** Two things
can hold out, and they are not interchangeable, so they are never reported as
one:

- **Another tab of this site is holding the database open.** Browsers will not
  delete a database while anything has it open, and the request simply waits —
  possibly forever. So the wait is bounded, and when it runs out the page says
  the session database is still there and that closing your other tabs and
  trying again will fix it. It does not say the data was erased.
- **The wallet refused to disconnect.** Everything else is still removed — a
  wallet declining to let go must not stop the rest — but the page says the
  site is still connected and that you can disconnect from the wallet itself.

Both of those replace a success message that would otherwise have been true of
the storage and false of the session. Reporting "erased" over a live connection
is the same failure this page was built to avoid, one layer further along.

**One promise is deliberately not made.** A browser extension, or a Safe, keeps
its own record that you allowed this site, somewhere no page can reach. The
erase copy now says so, and says reconnecting there is still a single click.
Someone who deletes their data and finds one click restores the connection
should have been told that here, rather than discovering it.

The page also now shows that it is working. Disconnecting a wallet and waiting
out a held database takes real seconds, and a button that simply greys out
reads as broken rather than busy.
