## Local testing — a gas budget for every user action

A new gas suite measures one transaction for each user action. It covers 32 actions plus instant borrow at one, two, four and eight sources. The actions run from posting, changing and cancelling an offer, through accept, match, repay, collateral, claims, both liquidation routes, the in-kind fallback, the two lender sales (the listing route both when listed and when a buyer accepts it), preclose, refinance, NFT rental, vault deposit and withdrawal, Auto-lend slots and standing instructions. Each action runs as its own isolated transaction, so it starts cold the way a network transaction does. For each one the suite records the gas, the storage slots written and read, the calls the Diamond makes to itself, and the events.

`contracts/gas-suite/budgets.json` holds a budget and a stated reason for each action. The pre-deploy gate's full run now checks every measurement against its budget. An action over budget is a warning until the refactor pass ends, and a failure after it. A budget raised without a changed reason is always refused: every pull request checks this against its base, and the pre-deploy gate against the base branch. An action well under its budget gets a note asking for a lower budget, so the budgets follow the code.

The suite also checks the instant market's source rule from the design ruling on the instant borrow source cap. For a fill bound and the longest list of sources a borrow may carry, the rule adds three costs: the first fill, each further fill up to the bound, and a skip for every other source. The total must stay within 80% of the smallest per-transaction gas cap among the networks listed. It is checked for the bound the deploy sets, the code's default and the top of the range governance may set, with each guard read that prices an asset counted at its mainnet-shaped cost. The first measurement breaks it everywhere.

- One fill makes 72 calls to the price guard, 28 of which price an asset.
- Each of those reads is counted once, at the cost of a mainnet-shaped read: about 304 thousand gas on the most expensive path, through a pivot asset. The suite's own guard already charged about 19 thousand of that, so only the rest is added. One fill then needs about 14.9 million gas and each further fill about 15.1 million.
- A skipped source costs about 3.3 million gas.
- With the deploy's bound of two fills and one skip, a borrow can need about 33.8 million gas. That is over the 13.4 million allowed, which is 80% of Ethereum's cap of 2^24.

These are findings, which warn until the refactor pass ends. The deploy settings set the bound to 2.

The figures are for comparing one build with the next, not a network gas quote. Every price read runs the price guard's own code, from feeds the suite sets up, and each action records the guard calls it makes. Liquidity tiers and the swap venue are answered by test mocks. The health factor and the loan-to-value ratio are computed for real.

The suite needed one root fix to compile: a deploy library's frame was too deep once the gas tests pulled it in. Unchanged behaviour.

Closes #3915
