## Risk disclosure — borrower's full-term interest commitment (#784)

The risk-acknowledgement shown before **creating** and before **accepting** an
offer now states, in plain language, the borrower's interest commitment for that
specific offer:

- For a **full-term-interest** offer (the default), it says the borrower agrees
  to pay the full-term interest amount for the entire agreed term **even if the
  loan is repaid early** — repaying early does not reduce the interest owed.
- For an offer that opted into **pro-rata** interest, it says interest accrues
  only for the time the loan is actually outstanding.

The wording is tailored to the actual interest mode of the offer in front of the
user (sourced from the offer's term-interest setting, not hardcoded), so the
create-offer flow reflects what the creator is setting and the accept-offer flow
reflects what that borrower is committing to. The line appears inside the existing
single combined Risk Disclosures + Terms acknowledgement (no new checkbox), and
is included in the English-original modal shown to non-English users. No change to
any on-chain behaviour, interest calculation, or settlement.
