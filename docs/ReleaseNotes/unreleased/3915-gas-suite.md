## Local testing — a gas budget for every user action

A new gas suite measures one transaction for each user action. It covers 31 actions plus instant borrow at one, two, four and eight sources. The actions run from posting, changing and cancelling an offer, through accept, match, repay, collateral, claims, both liquidation routes, the in-kind fallback, the two lender sales, preclose, refinance, NFT rental, vault deposit and withdrawal, Auto-lend slots and standing instructions. Each action runs as its own isolated transaction, so it starts cold the way a network transaction does. For each one the suite records the gas, the storage slots written and read, the calls the Diamond makes to itself, and the events.

`contracts/gas-suite/budgets.json` holds a budget and a stated reason for each action. The pre-deploy gate's full run now checks every measurement against its budget. An action over budget is a warning until the refactor pass ends, and a failure after it. A budget raised without a changed reason is always refused. An action well under its budget gets a note asking for a lower budget, so the budgets follow the code.

The suite also computes how many sources one instant borrow may take: the largest count that stays within 80% of the smallest per-transaction gas cap among the networks listed. The first measurement is a finding for the instant market. One source costs about 6.4 million gas, two cost about 11.2 million, and four cost about 20.7 million. Under Ethereum's per-transaction cap of 2^24 gas, the count the app and the contracts may offer is two.

The figures are for comparing one build with the next, not a network gas quote. Prices, liquidity tiers and the swap venue are answered by test mocks, so an action that reads prices measures low by the cost of those reads. The health factor and the loan-to-value ratio are computed for real.

The suite needed one root fix to compile: a deploy library's frame was too deep once the gas tests pulled it in. Unchanged behaviour.

Closes #3915
