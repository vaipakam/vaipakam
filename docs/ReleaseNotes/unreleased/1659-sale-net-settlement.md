# Selling a lender position no longer asks the seller for wallet liquidity they were never told to hold

**Task:** #1659

Selling a live lender position through a **resting listing** — where the seller
publishes an asking rate and a buyer takes it later — could not complete at all
once any interest had accrued on the underlying loan.

When a position sells, the interest earned so far is **forfeited** by the seller:
it is applied to any rate shortfall the buyer's terms create, and whatever is
left over goes to the treasury. That part was right. What was wrong was where the
money came from. Completion tried to collect the forfeited amount from the
seller's **wallet**, which requires the seller to have granted the platform
standing permission to take that asset. On the *direct* sale that is fine — the
seller is the one submitting the transaction, so the permission and the sale
happen together. On a resting listing it is impossible: the **buyer** submits the
transaction, and a seller cannot grant permission inside someone else's
transaction. The sale simply failed, and the buyer's acceptance failed with it.

Sales now settle **net**, exactly as the platform's own specification calls for:
the buyer's payment is held by the protocol for the moment it takes to settle,
the forfeited interest and any shortfall are deducted from it, and the seller
receives the remainder. Nobody is asked to source separate funds for money they
already owed out of the proceeds they are being paid. The seller's economics are
unchanged — they bear the same forfeit as before, and still receive the full sale
price minus what they owed.

This also removes a real divergence between the two sale routes. The direct sale
already settled net; the listing route had reimplemented the same arithmetic and
reached the opposite conclusion about who funds the forfeit. Both now follow one
rule, so they cannot drift apart again.

Two related notes:

- The extreme case where a seller's obligations would exceed the sale proceeds
  is refused up front with a clear reason, rather than failing deep inside a
  token transfer.
- The manual completion route, used only for recovery and driven by the seller
  themselves, is unchanged.

**Why it went unnoticed:** the shortfall is skipped entirely when no interest has
accrued yet, which is the case whenever a listing and its acceptance happen at
the same moment — true of every automated simulation and of the whole in-process
test suite, which additionally grants every participant unlimited standing
permission. A regression test now removes both of those crutches: it lets real
time pass and revokes the seller's standing permission before the buyer accepts.
