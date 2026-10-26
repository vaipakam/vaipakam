## Thread — Lender intents may lend VPFI (PR #2914)

A lender's standing intent now accepts the platform's own VPFI as its lending
asset. Registering, funding, filling, previewing and withdrawing a VPFI intent
all work like any other priced ERC-20. The refusal existed because the vault
paths an intent uses did not refresh the lender's fee-discount tier when VPFI
moved; since the tier record is refreshed inside every vault balance write
(#1820), VPFI an intent holds counts toward the lender's tier while it sits in
their vault and leaves it when a fill lends it out or the lender withdraws it,
exactly as an offer's escrowed VPFI already did. The owner decided to lift the
refusal on 2026-10-26.

Auto-roll still refuses a loan whose lending asset is VPFI, now with its own
named refusal. A VPFI repayment's proceeds are reserved for the lender
position's holder until claimed, and a roll cannot release that reservation,
so such a loan settles through the normal claim. The fill preview's error list
keeps its numbering: the code that used to mean "VPFI lending unsupported" is
retired and never returned, so solvers that key on the numbers need no change.
The treasury-funded backstop still refuses VPFI as backstop capital; that is a
separate treasury decision this change does not take.

Closes #2860.
