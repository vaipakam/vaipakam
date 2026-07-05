## Thread — every wallet prompt announced before it happens (offer flows)

Creating an offer asks for up to three wallet confirmations and
accepting one for up to four (sign the terms, approve the token —
twice when the wallet needs an old approval reset to zero first —
then submit) — and until now the app never said so: the whole sequence ran
behind one flat "Waiting for wallet…" spinner, so the second and third
prompts could read as something going wrong, or worse, something
suspicious.

The review screen now carries a roadmap before the first prompt:
"You'll confirm N times in your wallet, in this order", with each
step named in plain words — the free terms signature, the token
approval (including the honest "two confirmations" case where the
wallet requires an old approval reset to zero first), and the final
transaction. The count is live: an approval already in place drops
out of the list, down to "One wallet confirmation finishes this."
While the sequence runs, the button reports position — "Signing
terms… (1 of 3)", "Approving… (2 of 3)", "Submitting… (3 of 3)" —
instead of the undifferentiated wait.

This covers the offer post and accept flows the concern was raised
about; the rental, repayment, and VPFI surfaces follow under the same
card, and the deeper prompt-reduction path (signature-based approvals)
is tracked separately.
