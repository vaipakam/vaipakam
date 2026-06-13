## Thread — Borrower-offer collateral lock: pledged collateral can't be drained before a lender accepts (PR #PLACEHOLDER)

When a borrower posts a borrow offer, they escrow the collateral they're
pledging into their own vault up front — it sits there until a lender
accepts and the loan is created. Until this change that escrowed
collateral was only protected once the loan existed; in the window
between posting the offer and a lender accepting it, the collateral was
freely withdrawable. For most assets there was no withdrawal door in that
window, but VPFI had one (the staking-unwind path): a borrower could post
an offer pledging VPFI as collateral, quietly unstake it back out, and
then let a lender accept — minting a loan that was under-collateralized
from birth.

This thread closes that gap. It is the borrower-side mirror of the
lender-side offer-principal lock: the pledged collateral is now marked as
*encumbered* the moment the offer is created, in the same protective
ledger the loan's own collateral uses, so the vault's withdrawal
chokepoint refuses any withdrawal that would dip into collateral
committed to a live offer. The VPFI staking-unwind path consults that
same ledger, so it now refuses to release pledged collateral with no
extra code. The lock is kept exactly in step with the collateral across
the offer's life: placed at create, drawn down slice-by-slice as a range
offer is partially filled, and — the new piece relative to the lender
side — *handed off* to the loan's own collateral protection at the moment
of acceptance (the collateral never moves; it simply transitions from
"committed to an open offer" to "backing a live loan"). An offer's own
legitimate refunds — cancelling, trimming the offer's collateral size
down, or the unused-collateral refund at acceptance — release the
relevant portion before the funds move, so an offer can always pay itself
back; only third-party / cross-purpose withdrawals are blocked.

The protection is automatic and needs no new user action, and it applies
only to ERC-20 collateral on ERC-20 borrow offers — NFT collateral is
held in custody (the token itself sits in the vault, with no fungible
drain door) and is out of scope. Sanctions, KYC and country-pair
behaviour are unchanged. Closes #573. With both the lender-principal lock
(#566) and this borrower-collateral lock landed, every creator-side offer
escrow is now protected end-to-end.
