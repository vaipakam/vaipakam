# Auto-extend reserve (#2814)

## The problem

An in-place extension settles the closing window's interest, plus any late
fee, by withdrawing it from the current borrower-position holder's vault. A
vault withdrawal releases only protocol-tracked, unencumbered balance. Before
this change no route let an ordinary borrower put free, tracked balance of the
loan's principal asset into their own vault:

- every vault deposit is internal to an offer, intent or VPFI flow, and each of
  those liens what it deposits;
- tokens sent straight to the vault are untracked stray balance;
- refunds and repay proceeds land in wallets or under someone else's claim.

So an extension of a loan with accrued interest reverted in the withdrawal. The
integration test reached it only by writing the tracked counter through a test
mutator.

## Owner decision (2026-10-28)

The fix is an explicit top-up. The borrower deposits the principal asset into
their own vault, recorded and earmarked for that loan's extension. It stays
withdrawable while unused and is shown in the app. Pulling the charge from the
borrower's wallet was ruled out: it would need a standing approval, the problem
#1558 removes.

## Shape

The design follows the standing lender-intent capital (#393), the existing
"deposit into your own vault under a named reservation" pattern:

- **Record.** Per loan and depositor: `extendReserve[loanId][depositor]`, in the
  loan's principal asset. It is held in the depositor's own vault and reserved
  in the shared encumbrance aggregate, so the withdraw guard treats it as not
  free. Only `LibEncumbrance.lienExtendReserve` / `unlienExtendReserve` write it.
- **Fund** (`fundExtendReserve(loanId, amount)`). The caller must be the current
  borrower-position holder, because an extension draws only on that holder's
  vault. The deposit goes through the vault chokepoint, which records the
  tracked balance and refuses a short arrival. Funding is refused while the loan
  could not be extended at all: the feature switched off, the loan not Active,
  not an ERC-20 loan, or on a periodic cadence. That way no deposit sits behind
  an extension that cannot run. It is Tier-1 sanctions-gated and refused for a
  paused asset.
- **Draw.** An extension's charge comes out of the current holder's reserve
  first, then out of their other free balance of the asset, as before. One
  event, `ExtendChargeDrawn`, states how much came from each and what is left
  reserved. The extension stays all-or-nothing: if the two together fall short,
  it reverts and takes nothing.
- **Withdraw** (`withdrawExtendReserve(loanId, amount)`). The depositor may take
  back unused reserve at any time: whatever the loan's state, and whether or not
  they still hold the position. It is Tier-1 sanctions-gated, like the intent
  capital exit.
- **View** (`getExtendFunding(loanId, holder)`). Returns the holder's reserve,
  their other free balance, and two charges: what an extension would charge
  now, and what it would charge at the end of the extension window (the grace
  end). The second is the most an extension of the current term can cost, so
  funding to it covers any moment the keeper might choose. Both charges come
  from `_extendChargeAt`, the same rule the executor charges by. They read 0 for
  a loan that cannot be extended.

## Rules worth stating

- **The reserve follows the depositor, not the position.** If the borrower
  position moves (a transfer or an obligation handover), the new holder funds
  their own reserve, and the old holder withdraws theirs. Moving a depositor's
  money to a new holder of the position would pay a stranger out of it.
- **Nothing else takes the reserve.** Repayment, default, liquidation and
  collateral release never touch it: it is not collateral, and the collateral
  lien is a separate entry. After any terminal the depositor withdraws what is
  left.
- **Fee-tier treatment** follows the intent-capital precedent. These are the
  depositor's own tokens, so the reserve is no fee-tier exclusion.

## Alternatives not taken

- **Pull from the wallet at extension time.** Ruled out by the owner: it would
  need a standing approval.
- **Reserve keyed by position (the NFT).** It moves money between people when
  the position trades, and the buyer did not deposit it.
- **Draw only the reserve.** This would refuse an extension that a holder's
  other free balance covers today. Drawing the reserve first and stating the
  split keeps the earmark meaningful without making the extension stricter
  than it was.
