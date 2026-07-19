## Thread — Fee-package spec supersession (M2 PR-1, docs-only) (PR #<n>)

Documents-only PR-1 of the M2 absorption-formula milestone (recycling
completion plan §M2; owner tariff decision D1 = the LIF·year dual-fee
package). It states the **intended** launch fee package across the
functional specs so later M2 code cards implement against a current
spec, not a superseded one. No behaviour changes here — the code still
runs the legacy rates; these edits describe where it is heading.

What the spec now says (intent, sourced from the ratified design docs,
never transcribed from code):

- **List fees freeze at `0.2%` Loan-Initiation Fee and `2%` yield fee**
  (double the legacy `0.1%` / `1%`), with a **grandfather resolver**: a
  fee-rate change must never reprice an already-open loan — each loan
  resolves its settlement fee from the rate in force at its origination,
  so a loan opened before the freeze keeps the legacy rate. (Pre-live,
  this relaxes to deployment sequencing: a fresh deploy simply starts at
  the new defaults.)
- **Two borrower fee modes replace the peg-custody VPFI path for new
  loans:** HoldOnly (tier discount as a direct reduction of the
  lending-asset fee — no VPFI moved) and Full (an optional per-party
  native-VPFI tariff paid into the recycle bucket for an extra own-side
  discount, capped). Loans already open on the legacy custody path are
  grandfathered.
- **The interaction-reward `500 VPFI/ETH` cap (#1008) gives way to a
  fee-linked loan-side cap plus the D1 share-of-pool cap**, cut over
  jointly — the share-of-pool rule never activates without the loan-side
  cap in force.
- The recycling governor design's older ETH·day tariff formula (option
  (a)) is marked **superseded** by the LIF·year package.

Supporting edits: `_CodeVsDocsAudit` records the three spec-ahead-of-code
divergences (each tagged as intentional, with the M2 code card that
closes it); the WebsiteReadme borrower-copy rules carry the
new-loan-model note and reaffirm the no-purchase-price / no-APR
discipline for the Full tariff. Closes #1350.
