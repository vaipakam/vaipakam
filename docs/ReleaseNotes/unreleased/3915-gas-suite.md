## Local testing — a gas budget for every user action

A new gas suite measures one transaction for each user action. It covers 31 actions plus instant borrow at one, two, four and eight sources. The actions run from posting, changing and cancelling an offer, through accept, match, repay, collateral, claims, both liquidation routes, the in-kind fallback, the two lender sales, preclose, refinance, NFT rental, vault deposit and withdrawal, Auto-lend slots and standing instructions. Each action runs as its own isolated transaction, so it starts cold the way a network transaction does. For each one the suite records the gas, the storage slots written and read, the calls the Diamond makes to itself, and the events.

`contracts/gas-suite/budgets.json` holds a budget and a stated reason for each action. The pre-deploy gate's full run now checks every measurement against its budget. An action over budget is a warning until the refactor pass ends, and a failure after it. A budget raised without a changed reason is always refused. An action well under its budget gets a note asking for a lower budget, so the budgets follow the code.

The suite also checks the instant market's source rule from the design ruling on the instant borrow source cap. For a fill bound and the longest list of sources a borrow may carry, the rule adds three costs: the first fill, each further fill up to the bound, and a skip for every other source. The total must stay within 80% of the smallest per-transaction gas cap among the networks listed. It is checked for the bound the deploy sets, the code's default and the top of the range governance may set, with each price-guard read counted at the full gas the guard is given. The first measurement breaks it everywhere.

- One fill makes 44 guard reads.
- At the full read budget, one fill needs about 28 million gas, over Ethereum's whole cap of 2^24.
- At the cost a read was measured at on Base Sepolia, one fill needs about 8.9 million gas and each further fill about 7.4 million.
- A skipped source costs about 64 thousand gas when it is refused early and about 1.6 million when it is refused at loan creation.

These are findings, which warn until the refactor pass ends. The deploy settings now set the bound to 2.

The figures are for comparing one build with the next, not a network gas quote. Prices, liquidity tiers and the swap venue are answered by test mocks, so an action that reads prices measures low by the cost of those reads. The health factor and the loan-to-value ratio are computed for real.

The suite needed one root fix to compile: a deploy library's frame was too deep once the gas tests pulled it in. Unchanged behaviour.

Closes #3915
