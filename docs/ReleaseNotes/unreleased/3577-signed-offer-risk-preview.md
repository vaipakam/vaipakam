## Thread — Risk-access preview for signed offers (PR #<n>)

An app reviewing a fill of a signed offer can now ask, before the taker signs
or approves anything, whether the risk-access gate would let the fill through.
The gate's existing previews are keyed on an on-chain offer, and a signed offer
becomes one only inside the transaction that fills it, so until now the review
could only say the gate's answer was unknown. With the gate on across the
testnets, a refused taker found out from the dry run after signing the terms
and approving the collateral.

The new read takes the signed offer and the taker. It reports the signer's
block and the taker's block separately, with the gate's usual reasons, and the
asset pair both are judged on, so the app can tell the taker exactly which
consent or acknowledgement to record, and on which pair. It applies the gate's
own rule for an ordinary offer, from one shared pair builder, so the preview
and the fill cannot judge the same terms differently. With the gate off it
reports no block.

Closes #3577. It ships with the signed-offer accept preview (#3552), so the
app's signed-offer fill review can read both before the first prompt.
