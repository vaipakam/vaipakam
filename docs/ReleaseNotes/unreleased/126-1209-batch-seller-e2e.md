## Thread — End-to-end spec for seller claims; test markers for Repay all

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

> Caveat: "Repay all" (#126) has no end-to-end spec yet. The only way a
> borrower gets two loans from one offer is a ranged request filled in
> slices, and that seed is held on a contract issue found while writing
> the spec; the spec lands with the fix. The live drive on Base Sepolia
> for seller claims is still to run.
