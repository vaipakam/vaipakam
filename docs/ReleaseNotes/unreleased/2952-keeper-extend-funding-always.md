## Keeper — auto-extend always checks funding (PR #<n>)

The auto-extend pass now checks, for every loan, that the extension is funded before sending it. It used to ask each Diamond's loupe first whether the funding view existed and skipped the check on a Diamond deployed before it. Every testnet now runs a fresh Diamond that has the view, so that check and its fallback are gone. A loan whose funding cannot be read waits for the next run, as before. The keeper spec also states the funding rule, and drops the note about older testnets without the extension window read, which no longer exist.

Follows PR #2952.
