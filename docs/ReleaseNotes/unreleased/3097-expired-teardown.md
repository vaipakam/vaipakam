## Keeper — tears down expired listings and intents (PR #<n>)

Three permissionless teardowns had nothing driving them, so each waited for someone to make the call by hand. A prepay listing nobody filled keeps the borrower position locked, and the vault's approval to the listing conduit live, after its loan's grace window has ended. A lender's sale listing that has expired on a live loan, or still stands after the loan closed, keeps holding the borrower's partial repayment and collateral withdrawal and keeps the seller's position locked. A swap-to-repay intent past its order deadline and the borrower's cancel grace keeps the position locked, keeps the loan out of internal liquidation matching and auto-refinance, and leaves the vault's allowance to the limit-order protocol raised.

A new keeper duty, the expired teardown, backs all three, as the owner decided on #3097: every permissionless step gets a keeper backstop, and each ships switched off. Every quarter hour, on every chain, it reads one window of the active-loan list for prepay listings and intents, and a bounded walk of the open-offer book, starting somewhere new each run, for sale listings. Each is judged at one pinned block against that block's time, from the loan's own deadlines, the chain's intent cancel grace and the sale offer's own expiry. Each due item is simulated on the current state and sent only when the simulation succeeds, at most four per kind per chain per run. Prepay and sale teardowns go first because the protocol allows them while paused; the intent teardown is refused while paused and goes last.

The run line names each teardown from the protocol's own event in its receipt, and reports apart a call that landed without its event being read, an item someone else removed first, and an item the protocol says is not yet due at the current block.

A prepay listing is never touched during its loan's grace window: that window belongs to the grace auto-list duty, which moves a dead or overpriced listing to the floor, so the two never act on one listing. The duty also does not look for a Dutch prepay listing whose auction ended before grace began. The protocol allows that teardown, but the auction's end is recorded only on the listing's executor, which the Diamond does not expose, and the listing frees only the lister's own position, which the lister can cancel at any time.

The duty moves no value and pays only gas. It is armed by its own flag in addition to the master keeper switch, and ships unset. The record of what backs each permissionless step now names this duty for all three teardowns.

Advances #3097: this is the group of its three expired-listing and intent teardowns.

> Caveat: a sale listing whose offer has left the open-offer book while its link to the loan remains is not found by this duty.
> Caveat: a Dutch prepay listing whose auction ended before its loan's grace is left to its lister until grace begins.
