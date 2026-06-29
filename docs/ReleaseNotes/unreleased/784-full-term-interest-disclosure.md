## Risk disclosure — borrower's full-term interest commitment (#784)

The risk-acknowledgement shown before **creating** and before **accepting** an
offer now states, in plain language, the borrower's interest commitment for that
specific offer:

- For a **full-term-interest** offer (the default), it says the borrower agrees
  to pay the full-term interest amount for the entire agreed term **even if the
  loan is repaid early** — repaying early does not reduce the interest owed.
- For an offer that opted into **pro-rata** interest, it says interest accrues
  only for the time the loan is actually outstanding.
- For a full-term offer that **also allows partial repayment**, the wording is
  qualified: paying down principal early does lower the future interest on the
  reduced balance, while the full-term amount still applies to whatever principal
  remains — so borrowers aren't told early repayment can never reduce interest
  when partial repay is enabled.

The same disclosure now also appears on the borrower-initiated **preclose-offset**
flow, which creates a replacement lender offer inheriting the loan's interest mode
(that replacement offer is always non-partial-repay, so its wording reflects that).

The line is shown only for interest-bearing **ERC-20** loans — **NFT-rental**
offers settle prepaid rental fees rather than APR interest, so it's omitted there.
On the create-offer form, if a disclosure-driving field (interest mode,
partial-repay, or asset type) changes after the user has ticked the consent box,
the acknowledgement is cleared so they re-confirm against the updated wording.

The wording is tailored to the actual interest mode of the offer in front of the
user (sourced from the offer's term-interest setting, not hardcoded), so the
create-offer flow reflects what the creator is setting and the accept-offer flow
reflects what that borrower is committing to. The line appears inside the existing
single combined Risk Disclosures + Terms acknowledgement (no new checkbox), and
is included in the English-original modal shown to non-English users. No change to
any on-chain behaviour, interest calculation, or settlement.
