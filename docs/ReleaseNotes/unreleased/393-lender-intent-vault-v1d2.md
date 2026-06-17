## Thread — LenderIntentVault v1-d.2: zero-gap auto-roll

A lender's standing intent can now **redeploy its own returns automatically**.
When a loan made from an intent is repaid, an authorized keeper (or the lender)
can roll it: the proceeds — principal **and** interest — are re-committed
straight back into the intent's working capital instead of being paid out to a
wallet. The next match then lends that compounded capital again, with no manual
claim-and-refund round-trip in between. This closes the last idle gap in the
set-and-forget supply loop.

**Compounding.** The full repaid amount is rolled back in, so interest builds
the capital base over time rather than sitting idle. The lender's existing
maximum-exposure setting still caps how much can be on loan at once; capital
beyond that simply waits in the pool until it can be deployed.

**Authorization.** Rolling is gated by a new dedicated keeper permission —
"auto-roll this lender's repaid intent loans" — that the lender grants through
the same per-user keeper-approval mechanism used for the other keeper actions.
A lender can always roll their own loans; a keeper needs the explicit grant.
This is deliberately separate from the "fill my intent" permission, so a lender
can opt into automated redeployment independently of who may open new loans for
them.

**Two safety guards.** First, only a cleanly fully-repaid loan can roll —
defaulted, liquidated, or fallback loans go through the normal claim, because
their proceeds may be collateral rather than re-lendable principal. Second, and
most important: if the lender **sold their loan position** before it repaid, the
roll is refused. The buyer of that position is the one owed the proceeds and
collects them the normal way; auto-roll can never divert a sold position's
returns into the original lender's intent. The proceeds are re-committed as
capital and the claim that would have paid a wallet is consumed in the same
step, so a rolled loan's funds are never both claimable and re-lent.

Part of #393 (does not close the umbrella). With the working-capital lifecycle
(v1-d.1) and this auto-roll, the standing-intent supply side is feature-complete:
fund an intent, let solvers fill it, let it compound and redeploy itself, and
withdraw the un-lent remainder whenever you choose.
