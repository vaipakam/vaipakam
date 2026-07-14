## Thread — NFT-rental buffer is now fixed when the offer is posted, not re-derived from live config (PR #1193)

An NFT-rental offer locks a prepayment equal to the rental fee plus a safety
buffer (5% by default). Until now every place that touched that buffer — the
prepay pulled when an offer is accepted, the refund paid when an offer is
cancelled, the delta settled when an offer is modified, the buffer recorded on
the loan at origination, and the buffer reset when a rental obligation is
transferred to a new borrower — re-computed it from the *current* governance
config rather than the value in force when the offer was created. That was safe
only as long as the buffer percentage never changed. If governance retuned it
between an offer's creation and one of those later steps, the numbers no longer
matched what was actually vaulted: a raise could make a cancel try to refund
more than the vault held (bricking the cancel) or record a loan buffer larger
than the borrower ever funded (defeating the guarantee that a rental's late fee
can always be covered by its buffer, which had previously caused close-out
failures); a cut could strand part of the prepay in the vault.

This change snapshots the buffer percentage on the offer at creation and reads
that snapshot everywhere downstream. Accept, cancel, modify, loan origination,
and the Option-2 obligation transfer all now fund, refund, and record the exact
buffer the offer committed to when it was posted, regardless of any later
governance change. The rate is fixed at create; modifying an offer's amount
re-scales the buffer at that same fixed rate, so the vaulted total always stays
consistent for a later refund. Offers created before this change carry no
snapshot and transparently fall back to the live config, exactly as before.

This mirrors the snapshot-at-origination discipline the protocol already applies
to interest-rate terms, fee percentages, and liquidation thresholds: an offer's
economics are set when it is posted and a governance retune only affects offers
created after it. No behaviour changes when the buffer config is left untouched.
Closes #1193 (Pass-2 conformance umbrella #1196).
