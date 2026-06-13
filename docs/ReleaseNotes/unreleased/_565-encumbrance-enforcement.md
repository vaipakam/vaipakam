# Vault collateral encumbrance — enforcement (T-407-B, #565)

The platform now structurally guarantees that collateral backing a live loan
cannot leave a borrower's vault except through a protocol flow that first
accounts for it. A borrower who has pledged an ERC-20 asset (or an NFT) as
collateral can no longer drain that asset out of their vault through any
unrelated exit — the withdrawal chokepoint refuses to release more than the
borrower's free (un-pledged) balance, and every legitimate flow that moves
collateral (repayment, early repayment, refinance, liquidation, default,
partial collateral withdrawal, swap-to-repay, obligation transfer) adjusts the
running encumbrance first so it never blocks itself.

What a borrower sees in normal use is unchanged: repaying a loan returns their
collateral, withdrawing genuinely-excess collateral (above the health-factor
floor) still works, adding collateral still works. What changes is that an
attempt to pull pledged collateral out through a side door — most concretely,
unstaking VPFI that is simultaneously backing a live loan — is now refused
with a clear, specific error instead of silently under-collateralizing the
loan. This closes a real gap: VPFI is an eligible collateral asset (which is
safe in Vaipakam's peer-to-peer model, where the lender who accepts it prices
that risk), and the staking-unwind path previously had no awareness of
collateral commitments.

Two deliberate scoping decisions shape the behaviour:

- **NFT-rental prepayments are not encumbered.** For an NFT rental the
  borrower's "collateral" is the prepaid rental pool, which is designed to be
  drawn down continuously by the rental mechanism itself. Rather than track a
  lien that the rental flow would immediately fight, the platform leaves the
  rental pool unencumbered and instead forbids using the platform's own VPFI
  token as a rental prepayment asset (a rental prepayment must be a plain
  ERC-20 with no separate unstake door). This keeps the rental experience
  unchanged while removing the only way the prepay pool could have been
  drained out from under the lender.

- **Obligation transfer re-keys protection to the new borrower.** When a loan's
  obligation is transferred to a new borrower, the exiting borrower's
  collateral is released and the incoming borrower's collateral — already in
  their vault from their offer — is protected in its place, so the continuing
  loan is never left unprotected mid-transfer.

The enforcement also corrects an ordering issue in the internal-match
liquidation path so that opposing loans can be matched and settled without the
new chokepoint blocking the very settlement that is reducing the collateral,
and it ensures a loan that is cured back to active after a failed liquidation
has its protection reinstated.

This work supersedes the earlier incremental "wire each site as we find it"
attempt; it was re-built in one piece against a complete map of every place
collateral can move
(`docs/DesignsAndPlans/EncumbranceLifecycleMap.md`), so the protection is
applied uniformly rather than patched site by site.

## Review hardening — transferred borrower positions (Codex #572)

A second pass closed a class of edge cases that only appear once a
**borrower position has been sold or transferred** to a different holder.
A Vaipakam loan's collateral physically stays in the *original* borrower's
vault for the life of the loan — transferring the borrower-position NFT
moves the right to the position, not the vault contents. Every exit that
returns or moves that collateral now consistently takes it from the
original borrower's vault (where the protection is anchored) and delivers
it to whoever currently holds the position, so a transfer can never route
collateral to the wrong vault or leave the real collateral unprotected.

The most important refinement: on a normal close — repayment, early
close, or a swap-to-repay — the protection on the borrower's collateral is
now held until the borrower actually **claims** it back, released in the
same step as the claim, rather than the instant the loan closes. Returned
collateral sits in the borrower's vault as a pending claim between those
two moments; holding the protection across that gap means a borrower who
had already sold their position cannot drain the collateral out from under
the new position-holder before they claim it. For the ordinary case (the
same person closes and claims) nothing observable changes — they simply
claim and receive their collateral as before.

The same pass also protects collateral a borrower adds to a struggling
loan during its post-liquidation grace window, so a top-up made while a
loan is awaiting resolution can't be stranded under a stale lien if the
loan then defaults.

A companion improvement to refinancing — letting a refinance carry the
*same* collateral forward instead of requiring a fresh pledge and
returning the old — is captured as a dedicated follow-up, now that this
encumbrance ledger provides the accounting it needs.
