## Thread — "Delete my data" now clears the wallet connection too (PR #<n>)

The connected app's Data Rights page offers two controls: download what the
browser holds about you, and delete it. The delete control reported success
while leaving the wallet connection in place, so reloading the page could
reconnect the same account. Wallet-linked state surviving a deletion is the
particular failure that page exists to prevent, and a control that says it
deleted when it did not is worse than one that admits its limits.

The cause is that the deletion looked for storage under the prefixes this app
writes, and the connection is not written by this app. It is written by the
wallet libraries the app uses, under names of their own choosing, which no
amount of searching this app's own source would ever reveal. Four such names
are now covered — the wallet-connection library itself and three belonging to
the two wallet transports the app offers.

Downloading and deleting no longer look at the same set, deliberately. A
download is a file the person can keep and forward, and wallet session material
does not belong in one; leaving that material on the device, on the other hand,
is exactly what made the deletion incomplete. So the download still carries
what this app stored about you, and the deletion reaches further.

Two things are stated plainly in the code rather than left to be inferred. The
first is how each name was established: one was confirmed by reading the code
that builds it, and three were found only as fragments inside a shipped library
bundle, because the full names are assembled while the page runs. The second
follows from that — matching is deliberately generous, on the reasoning that
this app has its browser origin to itself and removing slightly too much is a
better failure than leaving an account connected.

What this does not yet do is prove the list is complete. It cannot be proved by
reading dependencies; it needs each wallet type connected in a browser and the
stored names compared before and after. That check, and a structure that can
carry a name no source scan can find, are the remaining half of #1862.
