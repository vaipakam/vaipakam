## Close the value-to-flagged sanctions enforcement gaps (#815 group A: #816–#820)

The #800 sanctions audit surfaced five places where a sanctions-flagged wallet
could still receive or benefit from value because the screen was missing or
applied only to the caller and not the actual beneficiary. All five are now
closed; behaviour for clean wallets is unchanged.

- **Discounted liquidation recipient (#816).** `triggerLiquidationDiscounted`
  delivers the bought collateral to a caller-chosen recipient. It screened the
  caller but not that recipient, so a clean liquidator could route seized
  collateral to a flagged address. The recipient is now screened too.
- **Default / liquidation auto-dispatch bonus (#817).** When an internal-match
  candidate exists, closing out a defaulting or under-water loan pays the caller
  a 1% matcher bonus. That caller was unscreened. The objective internal match
  now **still executes** for a flagged caller — skipping it would let a flagged
  caller degrade settlement by forcing the loan onto the external-swap /
  FallbackPending path — but the bonus is **denied**: the incentive is zeroed and
  folded into each lender's share, so the honest counterparty is made fully whole
  and no value reaches the flagged wallet.
- **Prepay collateral-sale listings (#818).** The manual fixed-price and Dutch
  "post" / "update" listing paths only checked position ownership, while the
  atomic and auto-list paths already screened sanctions. A flagged holder could
  therefore post or update a collateral-sale listing. The manual paths now
  screen the holder, matching the automated paths.
- **Keeper-driven obligation transfer & loan-sale listing (#819).** A keeper
  acting for a flagged position holder could route exiting collateral
  (obligation transfer) or list a lender position for sale on the flagged
  holder's behalf, because only the keeper (caller) was screened. Both
  initiation paths now screen the current position holder. Completion paths,
  where a counterparty may already be committed, are handled by the separate
  deferred-proceeds work (#821) so a flagged party can't strand an unflagged
  counterparty.
- **Collateral top-up (#820).** `addCollateral` screened only the stored
  borrower-of-record, not the payer / current position holder, so a sanctioned
  current holder could still top up. The payer is now screened. (Trade-off
  recorded: this prevents a flagged holder from strengthening their own
  position, which can let the loan proceed to liquidation — consistent with the
  policy that a flagged wallet cannot transact with the protocol.)

These close the value-out half of the gaps recorded in the #800 matrix's
*Open gaps* section and the matching `_CodeVsDocsAudit.md` findings. The
liveness-brick gap (a flagged recipient reverting a close-out) is tracked
separately under #821.

Part of #815. Closes #816, #817, #818, #819, #820.
