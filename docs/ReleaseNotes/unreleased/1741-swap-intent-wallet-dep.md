# A swap-to-repay panel kept using the wallet you had connected when it loaded

The panel that tracks a swap-to-repay intent refreshes itself every fifteen
seconds so a fill or a cancellation shows up without a reload. When the indexer
is unavailable it falls back to reading the chain directly and fills in the
missing pieces itself, including stamping the record with whoever is connected.

The refresh did not name the connected wallet among the things it watches. It
kept working anyway, because switching accounts replaces the handle the panel
uses to talk to the contract, and that handle *was* named — so the refresh
restarted, and the stamp was rewritten with the new account.

So this is not a fix for something users were seeing. It is the refresh now
naming the thing it actually reads, instead of relying on a second value that
happens to change at the same moment. Two separate reviews were needed to
establish that, and the first two accounts of it — including one in this very
note — described a staleness that the indirect route had already prevented.

Nothing displays that stamp or decides anything from it today either. Recorded
plainly because the alternative is a changelog claiming a fix for a problem
nobody had.
