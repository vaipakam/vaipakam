## Thread — A frozen address no longer holds a loan hostage

A token whose issuer can freeze an address could stop a loan from settling.
If the lending asset froze the lender's vault, the borrower's repayment
reverted, so the loan ran past grace and defaulted on the borrower's
collateral through no fault of theirs. If the collateral asset froze the
borrower's vault, the in-kind default reverted and the loan never closed.

Now, when the token refuses to move a repayment or a defaulted loan's
collateral to the lender side, that leg stays in the payer's own vault,
liened for the lender side, and the loan still becomes Repaid or Defaulted.
The lender's claim moves the leg into the lender's vault once the token
allows it; while the token still refuses, the claim fails and stays open
for a later try. Nothing waits in the protocol's own contract.

A leg is held this way only when the payer holds all of it, so a token that
has rebased below the tracked amount still fails visibly. Each attempt is
given a fixed amount of gas, and the step refuses when less is available, so
a caller cannot starve a deliverable payment into the held path.

This covers full repayment, the in-kind default, and the lender's share of a
forced sale (the liquid default and liquidations), which waits in the
borrower's vault. Partial repayment, preclose, swap-to-repay and periodic
interest still refuse, because a refusal there holds no one else hostage:
the borrower can still repay in full.

A frozen treasury no longer stops a repayment or default either: the
treasury's share waits in the payer's vault, and anyone can send it on to
the treasury once the token allows it. A keeper pass for that release is
planned and will ship switched off. The design is in
`docs/DesignsAndPlans/RefusedSettlementLegDesign.md`.

Advances #3669.

> Caveat: the indexer records the loan's terminal state as before but does not yet show the held leg; the app reads it from the contract.
