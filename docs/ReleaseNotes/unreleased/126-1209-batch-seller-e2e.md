## Thread — End-to-end specs for Repay all and seller claims

Two features that had only unit coverage now run end to end on the local
test chain in CI.

"Repay all" on Positions (#126) is driven on a borrower whose ranged
request was filled in two slices by two lenders, which gives two open
loans carrying the same offer. The spec checks the seed on chain, runs
the card's review and confirm, and requires both loans to read Repaid.

The seller's claim on Claims (#1209) is driven through a real sale: a loan
runs ten days, the lender lists it, a third wallet buys it, the borrower
repays, and the seller withdraws from Claims. The spec requires one
withdrawal event for that loan and seller, the same amount in the seller's
wallet, and nothing left waiting.

To make those checks independent of wording, the batch card and the
seller-claims card now publish where they stand as page attributes: the
batch card's stage, each loan's plan and outcome; the seller-claims list's
discovery state and each row's withdrawal verdict. One thing a user sees
changes: "Withdrawn to your wallet" is now stated by the seller-claims card
for each loan withdrawn this session, rather than inside the loan's row.
A withdrawal that empties an ended loan's claim removes its row on the next
read, which took the confirmation with it; the card now keeps it. The test indexer now serves the seller-claim activity kinds from
the chain's own logs, filed by the indexer's own actor rule.

Advances #126 and #1209.

> Caveat: the live drives on Base Sepolia for both features are still to run.
