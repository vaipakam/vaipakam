## Thread — Settlement sweep honors the lender Full stamp (M2 PR-6) (PR #<n>)

Adds the lender-side counterpart to the Full fee package the spec supersession
(#1350) described. Where the Full tariff (#1347) makes a lender *absorb* a
fee-native `C*` at loan origination, this card makes every lender-yield
settlement finally **honor** that opt-in: a lender who paid the Full tariff now
receives the promised **+10% own-side yield-fee discount** when the loan repays,
precloses, refinances, or auto-settles.

Concretely, the lender yield-fee discount at settlement becomes
`d = min(d_hold + d_tariff, 5000)` — the existing consent-gated hold-tier
discount `d_hold` **plus** a `d_tariff` of `+10%` whenever the loan's lender
absorbed the Full tariff (`lenderMode == Full`), all still capped at the uniform
50% ceiling. Two consequences fall out of the spec (formula §F2):

- **The Full opt-in is itself the consent.** A lender who paid `C*` but never
  toggled the separate hold-discount consent still gets the `+10%`: the hold
  slice `d_hold` stays `0` without consent, but the tariff slice does not require
  it. The settlement sites therefore attempt the discount whenever the lender has
  consent **or** absorbed Full (previously consent-only, which would have
  silently skipped a Full-no-consent lender — paying the tariff and getting
  nothing back).
- **Borrower Full never leaks into the lender's discount.** Only the lender's
  own hold tier and own Full stamp feed the lender `d`; a borrower's Full stamp
  is irrelevant to the yield fee.

The bump is delivered through **both** existing delivery modes with no call-site
duplication: the discount computation was centralised so the VPFI-payment path
(peg configured) and the Phase-1 direct-reduction path (peg unset) both charge
against the same Full-aware total. The four **primary** lender-yield settlement
facets — repay, preclose direct close, refinance, and the auto-lifecycle sweep —
pick up the change through the shared helper.

Because the VPFI-payment delivery **debits** the lender's vault, and settlement
consolidates `loan.lender` to the current position-NFT holder before quoting,
that path is gated on the charged party's own consent: an unsolicited transfer
of a Full-stamped lender position can never spend a non-consenting recipient's
VPFI. A Full lender without hold consent still receives the `+10%` — but only
through the no-token-move direct-reduction path, in every peg posture.

**Scope — still pending before `feeEntitlementEnabled` cut-over (hard blockers).**
Two tracked items remain, both enforced by the PR-9 (#1356) deploy-asserts so
the master switch cannot cut over while either is open:

- **#1383 — secondary settlement paths.** The `+10%` is not yet honored on
  swap-to-repay, preclose obligation-transfer (Option 2b) / offset (Option 3),
  rental-prepay, **partial repay** (`RepayFacet.repayPartial`),
  **periodic-interest** (`RepayPeriodicFacet`), or the **auto-lifecycle
  transferred-position** case (where the current holder ≠ the recorded lender).
  These apply neither the hold nor the Full discount today; extending them
  cleanly needs a size-reducing shared-helper refactor (preclose sits close to
  the EIP-170 limit) that also keys eligibility on the current holder.
- **#1384 — extension repricing.** `extendLoanInPlace` overwrites the loan term
  without restamping the fee entitlement, so an extended Full loan would keep
  the `+10%` (and the #1353 reward-cap budget) on unpriced added term until the
  entitlement is restamped/recharged for the new term.

No lender may pay `C*` while any settlement path they can be closed through
ignores the stamp, so both must close before the cut-over.

This ships **dark**: no loan carries a `Full` lender stamp until the Full opt-in
path (`feeEntitlementEnabled`) is enabled at the M2 joint cutover, so every
current settlement resolves to exactly the pre-existing consent-gated hold
discount — the change is a strict no-op today. PR-6 is itself a hard dependency
of that enablement (a lender must never be able to pay `C*` while settlement
still ignores the lender Full stamp), which this card removes. The frontend Full
quote / incidence copy remains a separate later card (PR-8 #1355). Closes #1354.
