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
than the lender allowed, and can't open below the collateral the lender's
maximum-LTV setting demands (if the protocol can't price that collateral, the
fill is refused rather than opened blind to the bound). The amount a lender has
"live" in outstanding intent loans is tracked per asset-pair and **released when
the loan's principal returns to the lender's vault** at claim time — so as loans
repay, the lender's exposure frees up and the same standing intent becomes
fillable again, closing the between-loans idle gap without any new action from
the lender. The release is tied to the **originating** intent, so even if the
lender sells their position mid-loan, the original lender's exposure is the one
that frees up (never the buyer's).

The whole fill path is governed by its own feature switch that stays off until
governance enables it after the testnet bake; while off, lenders can still
register and cancel intents, but no fill executes. Part of #393 (does not close
the umbrella). Next: the permissioned-solver authorization gate, then the
zero-gap keeper-claim auto-roll.
