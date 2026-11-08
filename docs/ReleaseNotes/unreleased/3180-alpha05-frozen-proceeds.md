# The next app states payouts frozen for a flagged wallet

When the sanctions screen flags a wallet, the protocol takes nothing it is owed and never stops a loan from closing. A repayment, a default or a liquidation still completes, and the other party receives what its side recovers. The flagged wallet's share is parked in a vault, locked, and released once the wallet is de-listed. The next app now says this wherever that money is.

Claims and the loan's page read the wallet's standing from the protocol's own views. That is whether a screen is configured here, what it answers for the wallet, and whether the wallet was confirmed flagged while the screen could be read. A flagged wallet sees "Frozen, awaiting de-listing", with a short note that nothing is taken and each payout stays locked, not lost. When the screen cannot be read and the wallet was confirmed flagged before, the page says a frozen payout stays locked until the screen answers again, and that an outage alone never freezes anyone. When the standing itself could not be read, the page says so rather than guessing.

Every claim refuses a flagged wallet in those same words, right after the protocol pause, and offers no button. A seller's withdrawal also waits during an outage for a wallet confirmed flagged, as the protocol checks it. A loan claim lets an outage through, so its dry run decides. When the dry run refuses a payout the protocol froze on that loan, the review says so in the same words. A change in the wallet's standing reopens a claim's review.

On a running loan, the page now states what the loan already paid that is reserved for the lender position, in the lender vault the loan records, until the lender's claim pays it. A payment made while the holder was flagged is one example. A repaid loan whose borrower surplus is still held says that surplus is one of the payouts left to collect before it settles.

The protocol keeps no view of which loan sides recorded a wallet as their frozen party, so the app cannot name an earlier holder frozen on a position bought later. It relies on the dry run there. That gap is filed as #3340.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-FROZEN. Epic #3180.
