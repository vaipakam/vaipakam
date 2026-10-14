## Thread — The keeper's transactions on one network go out one at a time (PR #2495)

Every signing duty of the keeper (matching, liquidation, lifecycle upkeep, the grace-period close-out, reward remittance and acknowledgement, commitment reports, the liquidity-confidence write and the daily oracle snapshot) signs with the same key, and each runs as its own task. Two of them sending on the same network in the same tick could both read the same pending transaction number, so one was refused or replaced the other even when they acted on different loans.

Every send now goes through one queue per network and key. A send waits for the previous one to be broadcast or to fail, then reads the pending number fresh. The queue also remembers the number after the last broadcast the network accepted, for one minute, so a load-balanced RPC that has not yet seen that broadcast cannot hand out the same number again. A send that fails before it is broadcast, such as one whose gas estimate reverts because someone else already closed the loan, records nothing. That is why viem's built-in nonce manager was not used: it reserves a number before estimating, so a reverted estimate would leave a gap that stalls every later keeper transaction on the network.

The queue lives in one running copy of the keeper. Two copies overlapping, which at a one-minute schedule needs a run still sending a minute after it started, are not ordered by it; one send would then be refused and retried on a later run. The grace-period close-out keeps the same request cap: the nonce read replaces the one viem would otherwise have made.

Closes #2486.
