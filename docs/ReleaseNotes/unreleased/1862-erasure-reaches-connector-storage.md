## Thread — "Delete my data" now reaches the wallet libraries' own storage (PR #<n>)

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

- **Coinbase Wallet's browser-extension and mobile linking mode** keeps its
  session identifier, secret and cached addresses in ordinary browser storage,
  and those are now removed.
- **Coinbase's smart-wallet mode** keeps its active key in a separate browser
  database this deletion does not open, so that key survives.
- **WalletConnect** likewise keeps its live session in that separate database,
  so a scanned-QR session survives.
- **A browser-extension wallet such as MetaMask** stays authorised in the
  extension itself, which this app cannot reach at all.

The app's in-memory connection is not dropped in any of those cases, so nobody
is signed out at the moment of deleting.

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

Finally, the page's own report was corrected. It had counted what remained using
the same narrow rule the deletion used to use, so a name that refused to be
removed would not have been counted and the page would have reported a clean
success over storage still present. A check that cannot see what the deletion
aims at is not a check.
