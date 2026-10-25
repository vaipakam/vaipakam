## Thread — liquidations and defaults sell only what the debt needs (PR #TBD)

A Health-Factor liquidation (single route and split route) and the liquid
branch of a time-based default now sell only as much collateral as settling
the loan needs, the same rule the periodic auto-liquidation adopted in #2795.
The sale offers the least collateral whose worst-case proceeds cover what the
borrower owes plus the 2% handling charge and the largest caller incentive,
both now taken on that debt rather than on the proceeds. The lender is paid
first and in full whenever the sale covers the debt; the handling charge comes
only after the lender. The collateral that was not sold stays pledged in the
borrower's vault and is taken with the borrower's claim, and any proceeds
beyond the debt and the charges are held there with it. When even all the
collateral cannot cover the debt, the sale sells all of it, pays the lender
first, and says so in its settlement event. When every route fails, the whole
collateral still goes into the in-kind fallback exactly as before.

Whoever triggers a forced sale now names the amount of collateral it is
selling, because every route is an exact-input swap. The protocol publishes
the plan first: the least covering amount and the most it accepts, which is
up to 2% above that amount while the debt can be covered (the debt accrues
and prices move between the quote and the block), or exactly all the
collateral when it cannot. Any other amount is refused before anything moves.
The liquidation, default and periodic-settlement calls each gained that one
argument; on the split route the amount is the sum of the legs. Keepers must
read the plan and quote within it before these contracts reach a chain.

Partial liquidation keeps the keeper's choice of how much to sell, but its
incentive and handling charge are now shares of the amount repaid rather than
of the proceeds taken alongside it, so the lender receives every unit the
charges do not. A sanctioned caller of a time-based default still triggers it
but earns no incentive. All forced sales now publish the same settlement event
with every figure. Fresh deploys only; nothing reaches a testnet until the
remaining work waves are done. The 2% quote margin is the owner's decision.
Closes #2796.
