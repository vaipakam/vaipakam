## Keeper — the matcher shares its previews across wallets, not offers (PR #<n>)

The keeper's matcher previews a bounded number of candidate pairs per run.
Until now it spent that budget in listing order: each lender walked every
borrower offer in its bucket before the next lender was looked at, and each
standing intent walked the whole borrower book. One wallet that posted
thousands of offers could therefore use up a run's previews on its own offers,
and the genuine matches behind them waited until the spam was gone.

The walk now goes round by round across pairs of counterparties. For the offer
match, a pair is one lender wallet and one borrower wallet in one bucket; for
the standing-intent fill, one intent and one borrower wallet. Each pair gets
one preview per round, so every pair is looked at once before any pair is
looked at twice, and the number of offers a wallet holds buys it no larger
share. The buckets and the wallet order start at a point that moves with each
run, so when a run's budget reaches only part of the first round, a different
part is first the next time. A wallet is still never paired with itself.

The rules that end a pair's walk are unchanged: a fully filled lender, a
lender or intent backed off after an uncertain submission, an intent refused
for a reason that holds for all its borrowers, and the solver capacity and
priority-credit handling. A borrower left in flight by an uncertain offer
match is now also passed over by the other lenders in the same run, not only
by the intent fill, so it cannot be matched twice while the first transaction
may still land.

This advances #3242 (part 2, matcher fairness). Parts 1 and 3, a minimum offer
size and the same bound on the indexer's signed-offer intake, are separate.

> Caveat: fairness is per wallet. A spammer who splits offers across many wallets gets a share per wallet, like anyone else; the minimum offer size (#3242 part 1) is what bounds that.
