## Thread — A shared, delayed registry for protocol endpoints (PR #TBD)

A new standalone contract, the protocol registry, now ships with every fresh deploy. It holds the endpoints that the Diamond and every user vault must agree on, outside the Diamond, so a faulty facet cannot change them. It starts empty. The standalone price guard (#3272) adds the first entry when it ships. The vault payout policy (#3205 part 2) then adds the treasury, the backstop, and the swap adapter and conduit sets, as data rather than code.

It holds two kinds of entry. A pointer is one address under a name; a set is a list of addresses under a name. Every change that adds trust waits: setting a pointer, adding a set member and lowering the delay are each proposed by the owner and applied by anyone once the delay has passed. The delay is never under three days, the same as the vault code delay, and never over thirty. Raising it applies at once. A change keeps the waiting time it was proposed with, whatever happens to the delay afterwards. Only one change can be pending per entry.

The guardian, the Pauser Safe after handover, can cancel any pending change. It and the owner can remove a set member at once, because a removal can only stop value moving. A pointer is never cleared, only replaced. Its consumers read it through a call that refuses an unset name, so no one treats an empty address as a real endpoint. The registry cannot be upgraded, and its ownership can never be renounced.

The deploy writes its address to the chain's deployment record, and the handover moves its ownership to the Timelock and its guardian to the Pauser Safe, like the VaultBeacon's. It advances #3272.
