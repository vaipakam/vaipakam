## Thread — Keeper backup releases held payouts

The keeper backup runner on Chainlink Automation now also releases a protected account's held payouts once their delay is over, when our own keeper has left them waiting longer than the runner's lag. Releasing a held payout was already open to anyone; until now only our keeper could find the ones that were due, because they were listed per account and the runner has no list of accounts.

The protocol now keeps one list of every payout still waiting, across all accounts. A payout joins it when it is held back and leaves it when it is released or cancelled, in the same places the per-account list changes. Two new reads, a count and a page of that list, let any keeper find matured payouts. The runner pages through the list the way it pages through active loans.

The protocol still decides what is due. A payout still in its delay, on a locked account, waiting for a co-signer or addressed to a screened-out recipient is not due, so the runner leaves it. The owner can still cancel a held payout during its delay as before. The new step ships switched off, like every other step.

The list starts empty on a Diamond that is refreshed in place, so payouts held before such a refresh are not on it. It reaches the testnets at the next fresh deploy. Position-NFT holder unlocks follow once the position token lists its pending unlocks.

Refs #3361
