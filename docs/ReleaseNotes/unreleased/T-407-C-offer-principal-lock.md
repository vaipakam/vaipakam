## Thread — Offer-principal lock: a lender's escrowed principal can't be withdrawn out from under a live offer (PR #580)

When a lender posts an ERC-20 lending offer, the platform escrows the
offer's full principal ceiling into the lender's own per-user vault at
create time — it sits there, ready, until the offer is filled. Until
this change that escrowed principal was only protected by bookkeeping:
nothing stopped the lender from separately withdrawing it back out of
their vault while the offer stayed open and discoverable, so a taker (or
the matching bot) could try to fill an offer whose principal had quietly
been pulled, and the fill would fail late and opaquely.

This thread closes that gap by marking the escrowed principal as
*encumbered* — the same protective ledger introduced for borrower
collateral — so the vault's withdrawal chokepoint refuses any withdrawal
that would dip into principal committed to a live offer. The lock is
kept exactly in step with the principal across the whole offer
lifecycle: it is placed when the offer is created, lifted in full when
the offer is accepted outright or cancelled, drawn down slice-by-slice
as a range offer is partially filled by the matching engine, and lifted
on the final dust-close. Crucially, an offer's own legitimate refunds —
cancelling, or a lender editing their offer's size downward — release
the relevant portion of the lock *before* the money moves, so an offer
can always pay itself back; only third-party / cross-purpose withdrawals
are blocked. Editing an offer's size upward grows the lock by exactly
the extra principal pulled in.

The protection is automatic and needs no new user action: the lock flows
through the same encumbrance aggregate the withdrawal guard already
consults, so a lender simply finds that the slice of their balance
backing an open offer is not withdrawable until that offer is closed or
trimmed. Sanctions, KYC and country-pair behaviour are unchanged. Closes
#573 (T-407-C). The companion borrower-collateral encumbrance audit
(holistic review of every escrow leg) remains tracked separately under
#574.
