## Thread — alpha05 sends every transaction with the shared gas margin

Every transaction the new app sends now carries a gas limit 30% above a fresh estimate. This is the same margin every other sender in the project uses, including the connected app and the keeper. Before, the app left the limit to the wallet, which sends at the node's bare estimate.

A bare estimate is the least gas the call needed in the latest block, and the transaction lands in a later one. A call whose cost grows with time, such as an oracle read or interest that accrues per second, can then run out of gas. When that happens it fails with no reason given. The connected app met exactly this on a loan acceptance mined one block after its estimate. Unused gas is not charged, so the margin costs nothing when it is not needed.

The estimate is asked of the wallet's own provider first, then of the app's own endpoints. When the call would be refused, or nothing can estimate it, the app sets no limit. The wallet then estimates and shows the refusal as before. The claim-everything batch keeps its stricter estimate and now takes the margin from the same shared rule.

All writes go through one sender, and a lint rule stops a new one from skipping it. Two protection screens that another change is reworking move onto it once that change lands. Advances #3180.
