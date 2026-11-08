## Thread — Keeper fee balance alert

The keeper can now warn the ops chat when its wallet on a chain could not pay for the liquidations it may have to send. The liquidation backstop costs gas, and gas prices jump in the same market crash that makes liquidations due, so a wallet that drains quietly would fail exactly when it is needed.

Every tick, on each chain with a Diamond, the keeper reads its wallet's native balance and the fee a send is prepared at right now. It compares the balance with a reserve: twenty liquidations by default, each assumed to need 2.5 million gas, which is a deliberate overestimate. Both figures are settings. Below the reserve it posts a low-balance alert; below the cost of a single liquidation it posts a critical alert straight away, without waiting out the low alert's interval. Either repeats every six hours while it holds.

Each message gives the balance, how many liquidations it pays for, the fee and the assumptions behind the reserve, and on an OP-stack chain it says that the L1 data fee and operator fee are not counted. Once the balance is back above 120% of the reserve, one recovery message is posted and the alert closes. The margin stops a balance sitting on the line from flipping between low and recovered every tick. A balance or fee that cannot be read changes nothing and is noted in the run log.

The check is read-only and sends no transaction. It ships disarmed behind its own flag, so it stays off until an owner arms it on the keeper machine.

Closes #3365
