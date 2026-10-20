## Keeper — sanctions settlement and chain-lapse notices (PR #2602)

The keeper's sanctions-hold pass now tells operators, on the ops Telegram chat,
about two kinds of event that previously left no trace outside the chain.

When one of the keeper's own settlements or staging resolutions moves reward
value, a notice names the wallet, the transaction, and what moved: the amount
set apart for the wallet, any amount paid to its wallet or vault, a staged
payout of the wallet's that was forfeited, and the transaction's whole
forfeited-reward credit to the recycle bucket. Every figure is read from the
transaction's own events, not computed by the keeper, and each says whose it
is. The recycle credit names no wallet on chain, so it is reported as the
transaction's, and where part of a forfeited staged payout sits inside it the
notice says the two figures overlap instead of letting them read as two moves.
A transaction whose receipt arrives after the keeper stopped waiting is checked
again, all at once and within a short bound, before the alerts and notices go
out. A late receipt counts exactly as one seen in time: a late revert is
reported as a failure, a late successful settlement can clear a failure alert
the run had open, and a transaction whose outcome is still unknown is said to be unknown rather
than left untold.

When one of the keeper's own transactions restarts a held claimant's observation
chain, a notice names the wallet and when the new chain began, read from that
transaction's own event. The cause is stated only as far as the contract's state
proves it. A chain that had already lapsed when the run first read it is reported
as lapsed, with the gap given only as more than the maximum observation gap,
because the contract no longer reports its last observation. A chain that was
live at that read but lapsed while the transaction waited to be included is
reported with its last observation and the exact gap. Any other restart is
reported as one whose cause the run's reads do not determine. A transaction
whose broadcast got no answer may still have reached the chain, so it is now
treated as unknown and its receipt is looked up, instead of being counted as a
failure that moved nothing.

All of a run's notices go out as one post per chain, after the pass's standing
alerts, so a burst of them can never use up the time those alerts need. Each
notice is also written to the keeper journal, which names any the post could
not fit. They are best-effort and cover only the claimants the keeper touched in
that run. Part of #2515 (item 5); the pass still ships with its arming flag
unchanged.
