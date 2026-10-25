## Keeper — reward remittances fund one day per send (PR #2823)

After any delay the keeper's reward-remittance pass used to fund every owed day for a mirror in a single send. A multi-day send lands on the mirror as one delivery listing all of those days, and the mirror holds that delivery back while more than one of its days is still open. A day closes only once every reward entry covering it has claimed past it. So an entry covering two of the delivery's days needs the delivery to claim the first day, and needs that claim to free the delivery. It can never be paid on the mirror, and any loan open across the batch has such an entry. The backlog cases (a late commitment report, a paused keeper, the delivery gate opening) are exactly the ones that built such batches.

Each send now funds one day. A backlog drains one funded day per mirror per run, oldest first, and the days still owed keep being reported as owed. A day that only closes, moving no tokens, still travels with it. The cost is one cross-chain fee per day, which is already the steady-state cost. The keeper applies this whatever its configuration. Whether the contracts should also refuse or split a multi-day send is still an open owner decision on #2821.

Refs #2821.
