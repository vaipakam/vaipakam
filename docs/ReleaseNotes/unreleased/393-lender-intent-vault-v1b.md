## Thread — LenderIntentVault v1-b: the standing-intent fill path (PR pending)

The second slice of the LenderIntentVault turns a registered standing lending
intent into actual loans. A solver (or any caller) can now **fill a lender's
standing intent** against an existing on-chain borrower offer: the protocol
constructs a one-time lender offer from the intent's bounds — the lender's rate
floor, the borrower offer's term (capped at the intent's maximum), and the
collateral the intent's maximum loan-to-value requires — funds it from the
lender's existing vault balance, and matches it through the same audited engine
the on-chain matcher uses. The solver earns the standard 1% matcher fee.

Because the loan is created through the normal matching path with the lender as
the offer's creator, the **depositing lender is the lender-of-record** on the
resulting loan: repayment claims, fee treatment, and the transferable lender
position all behave exactly as for a directly-created offer. Nothing about the
loan's lifecycle is special-cased for intents.

Each fill is bounded by the intent the lender signed up to: it can't be smaller
than the lender's minimum fill size, can't push the lender's total outstanding
principal on that asset-pair past their exposure cap, can't run a term longer
than the lender allowed, can't open below the collateral the lender's
maximum-LTV setting demands (if the protocol can't price that collateral, the
fill is refused rather than opened blind to the bound), and must carry the
lender's full-term-interest floor so a borrower can't escape the lender's
committed interest by repaying early.

The amount a lender has "live" in outstanding intent loans is tracked per
asset-pair against their exposure cap, by the **original fill amount** (so a
partially-repaid loan still releases its full reserved amount). The cap is
**freed when the lender claims the loan's proceeds** — the point at which the
principal returns to the lender's control — after which the lender can deploy it
again. The release is keyed to the loan's **originating** intent, so even if the
lender sells their position mid-loan, the original lender's cap is the one freed
(never the buyer's). Re-lending those proceeds back into the standing intent
*without any manual step* (true zero-gap auto-roll) is the next increment; this
slice delivers the fill path plus the exposure accounting that underpins it.

The whole fill path is governed by its own feature switch that stays off until
governance enables it after the testnet bake; while off, lenders can still
register and cancel intents, but no fill executes. Part of #393 (does not close
the umbrella). Next: the permissioned-solver authorization gate, then the
zero-gap keeper-claim auto-roll.
