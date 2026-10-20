## Keeper — sanctions settlement and chain-lapse notices (PR #2602)

The keeper's sanctions-hold pass now tells operators, on the ops Telegram chat,
about two events that previously left no trace outside the chain. When one of
the keeper's own owner settlements moves reward value, a single notice names
the wallet, the transaction, and the amounts set apart for the wallet and
forfeited. Those amounts are read from the transaction's own events, not
computed by the keeper, so the notice cannot state a figure the chain did not
record. When a held claimant's observation chain that the keeper was tending
restarts because an observation landed after its due time, a notice names when
the claimant was last observed, when the next observation was due, and when it
was actually observed, so the reset of the confirmation window is visible.

Both notices are best-effort and sent once per event. They cover only the
claimants the keeper touched in that run: a restart caused by another caller's
settlement is not reported, and a restart caused by a change of sanctions
oracle is not treated as a lapse. Part of #2515 (item 5); the pass still ships
with its arming flag unchanged.
