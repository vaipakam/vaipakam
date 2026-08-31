## Thread — "Delete my data" now reaches the wallet libraries' own storage (PR #<n>)

The connected app's Data Rights page offers two controls: download what the
browser holds about you, and delete it. The delete control looked only for
storage under the names this app writes, and the wallet connection is not
written by this app — it is written by the wallet libraries the app uses, under
names of their own choosing, which no amount of searching this app's own source
would ever reveal. So the deletion passed over it and reported success.

Four such names are now covered: the wallet-connection library's own store and
three belonging to the two wallet transports the app offers.

**What that does and does not achieve, stated precisely, because the honest
extent is narrower than the change first appears.** The wallet-connection
library keeps its record of which wallet you last used in ordinary browser
storage, and that is now removed. The two wallet transports keep their live
session somewhere this deletion does not look — a separate browser database —
and the app's in-memory connection is not dropped either. So a person using
those transports is still connected after deleting, and may still be connected
after reloading. Closing that requires asking the wallet libraries themselves to
tear down, which is a different and asynchronous piece of work, tracked as the
remaining half of #1862 and deliberately not claimed here.

There is a smaller consequence that does land now and is worth expecting: for
the wallet types whose record was removed, the app stays connected in the
current tab and is signed out after a reload. The page does not yet say so,
because saying it well means saying it in ten languages, and doing that against
half the behaviour would mean writing it twice.

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

Finally, the page's own report was corrected. It had counted what remained using
the same narrow rule the deletion used to use, so a name that refused to be
removed would not have been counted and the page would have reported a clean
success over storage still present. A check that cannot see what the deletion
aims at is not a check.
