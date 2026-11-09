## Thread — Hourly price checkpoints for the forced-sale floor

The keeper can now write the hourly price checkpoints that the tighter forced-sale floor (#3359) reads. That floor lets a forced sale of deep, calm collateral lose less than the full 6% to the market, and it counts a pair as calm only when its oracle rate now is close to its rate at both of the last two hourly checkpoints. Anyone may write a checkpoint, but until something does it every hour, every forced sale uses the full 6%.

Twice an hour, on each chain with a Diamond, the keeper takes the lending and collateral assets of the active loans whose two legs are both tokens. It checks at the latest block which of them have no checkpoint yet for that block's hour and have an oracle price that reads. It then records those, 25 to a transaction, simulated first. The second run in the hour is a retry: it sends only what the first run left, so a healthy hour costs one transaction per chain. An asset whose price does not read is not sent, because the contract would skip it too. A Diamond that does not carry the floor yet is skipped, and the run says so.

Each run line gives the hour, how many assets were already recorded, how many this run recorded, any filed under the next hour because the transaction landed after the hour turned, any another caller recorded first, and any left without a price. A missed hour can only send a sale back to the full 6% for the next two hours. It can never make a floor tighter. The checkpoint stores only the oracle's own reading and moves no value.

The pass ships disarmed behind its own flag, so it stays off until an owner arms it on the keeper machine.

Closes #3384
