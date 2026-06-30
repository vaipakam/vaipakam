# Release Notes — 2026-06-30

Two strands landed this day. The first is a correctness fix to the loan
lifecycle: a partial liquidation or partial repayment can no longer move a
loan's maturity, collapse its grace window, or let a tiny post-maturity
payment roll the lender's deadline — achieved by decoupling the interest-
accrual clock from the loan's term so the term (and therefore the agreed
deadline and grace) stays fixed. The second is the close-out of the
value-to-flagged sanctions-enforcement cluster (#815/#821/#822/#831): every
path that could move protocol value to, or let value escape from, an
OFAC-flagged wallet now either blocks at the source, freezes the proceeds in
a locked vault for later release, or fails closed — while keeping innocent
counterparties and pre-flag secondary-market buyers whole.

## Thread — Partial liquidation / repayment no longer move a loan's deadline (PR #838)

A loan's term — its `startTime` plus whole-day `durationDays` — was doing
three jobs at once: it defined the **maturity** (`startTime + durationDays`),
the **grace window** that follows maturity (sized by tiers of `durationDays`),
and the **interest-accrual clock**. Whenever a partial liquidation or partial
repayment reduced the principal, the code reset `startTime` to "now" and shrank
`durationDays` so the reduced principal would accrue interest cleanly from that
moment. But because the same two fields also defined the maturity and grace,
that reset silently:

- pulled the loan's **maturity earlier** (the whole-day rounding dropped the
  sub-day remainder, so a partial part-way through a day matured the loan early,
  and repeated partials compounded it);
- **collapsed the grace window** — a deep or late partial shrank `durationDays`
  into a much smaller grace tier (e.g. a 90-day loan's 3-day grace toward the
  sub-7-day, 1-hour tier), so the borrower could be declared in default far
  sooner than their agreed term; and
- let a tiny **post-maturity partial repayment reset the grace clock**, so a
  borrower could roll the lender's recovery deadline indefinitely with small
  payments.

The fix separates the two concerns. The interest-accrual clock now lives in its
own pair of fields (`interestAccrualStart` and `interestRemainingDays`). A
partial re-stamps **those** — the reduced principal still accrues from the
moment of the partial over its remaining committed term, exactly as before — and
the loan's term tuple (`startTime` + `durationDays`) is left **completely
untouched**. Because the term never moves, the maturity and the grace window are
preserved exactly on **every** path that previously re-stamped the loan (partial
liquidation, partial repayment, and swap-to-repay), with no per-call-site
patching of the deadline gates. The interest arithmetic is unchanged — it's the
same reset, just recorded in dedicated fields — so settlement amounts are
identical; this was verified against the full settlement test surface (repay,
preclose, refinance, swap-to-repay, time-default, periodic interest, and both
liquidation routes).

Closes #641. Surfaced during the #395 partial-liquidation sizing review and
refined across several review rounds, which is what made the structural shape
clear: the bug was never in one re-stamp path, it was the term tuple being
overloaded. The loan now carries the two `interest*` fields; loans that predate
them fall back to `startTime` / `durationDays` (none exist — the platform is
pre-live). The loan-detail ABI swaps in the new fields; frontend and keeper ABI
bundles are re-exported in the same change. Grace remains fully
admin/governance-configurable — the schedule is still read live via
`gracePeriod`, now off the (immutable) `durationDays`.

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

## Sanctioned-recipient wind-down: vault-lock + freeze (#821)

Closing the repay / default / liquidation gaps the #800 sanctions audit surfaced.
(One audit item remains deferred: the **completion** paths where a buyer is
already committed — `completeLoanSale` / `completeOffset` — are tracked separately
as **#831** and are not part of this change.) Previously, if a loan party became
sanctions-flagged *after* a loan was struck, the wind-down close-outs (full
repayment, time-based default, HF-based liquidation, and the internal-match
settlement that liquidation/default try first) could **revert** — because
depositing that party's share routes through the receiving vault, which is
screened. A flagged lender could brick repayment; the unflagged counterparty
couldn't be made whole until the flag lifted.

The protocol now keeps these close-outs working **without ever handing spendable
value to a flagged wallet**, on the principle that *the wallet is sanctioned, not
the vault*:

- **In — the close-out completes.** The flagged recipient's share is deposited
  into their **own** per-user vault (an isolated, protocol-tracked balance) so
  the debt clears and the unflagged counterparty is made whole. Nothing is held
  in the shared protocol contract — no commingling of sanctioned-linked funds.
  This holds across **every** wind-down branch: the ERC-20 lender payment, the
  NFT-rental lender share, the fallback-cure collateral restore, the in-kind /
  NFT collateral transfer on default and liquidation, and the internal-match
  settlement. Where the close-out has to *withdraw* a flagged borrower's
  collateral out of their vault (the in-kind and internal-match paths), that
  withdrawal is permitted too — the flagged party is losing custody to the
  unflagged counterparty, not receiving — so the forced default/liquidation can
  never be bricked by flagging either party after the loan was struck.
- **Frozen at the source — positions can't move.** A position NFT (lender or
  borrower) can no longer be transferred **into or out of** a sanctions-flagged
  wallet. This is the primary freeze mechanism: it stops a flagged party from
  laundering its position to a clean wallet to escape the payout freeze, and it
  means a flagged wallet's position is simply frozen in place until the flag
  clears. (Minting, burning, and protocol-internal settlement use separate
  authorized paths, so a flagged party's loan can still be settled and its
  position burned at terminal — the close-out always completes.) A position
  transferred while both parties were clean — a legitimate secondary-market sale
  made *before* any later flag — is unaffected.
- **Frozen on payout — nothing leaves the flagged vault.** With the position
  pinned in place, a flagged wallet that holds its own position can't extract the
  payout either: the claim paths screen the live recipient, and the proceeds sit
  vault-locked behind that screen until the flag clears.
- When the sanction is lifted, the preserved proceeds become claimable as normal.
- A new on-chain event records each time a close-out parks locked proceeds, so
  operators can reconcile them when a flag clears.
- The **NFT Verifier** warns when a position's current owner is sanctions-flagged
  — meaning the position is frozen (the owner can neither claim it nor transfer
  it) and can't be bought or claimed until the owner is delisted. (A stale
  original loan party is *not* flagged as frozen: a transfer made before any
  later flag is a legitimate secondary-market sale that settles normally.)
- Cancelling an unfilled offer is intentionally left to revert for a flagged
  creator: that refund returns the creator's *own* escrowed funds, so with no
  counterparty to protect, the revert is simply the freeze — the escrow stays put
  until the flag clears.

No behaviour changes for unflagged users: their close-outs and claims work
exactly as before.

Closes #821.

## Terms-of-Service gate now fails CLOSED on a read failure (#822)

The connected-app Terms-of-Service gate is a dapp-side routing gate over the
on-chain acceptance record — it has no per-action on-chain backstop, so if the
UI lets a non-accepting wallet through, nothing else stops it.

Previously the gate could be bypassed: while the on-chain acceptance read was
still loading it rendered the app through, and if that read *failed* (e.g. an RPC
outage) the code treated the unread default version (0) as the genuine
"gate disabled" state and also let the app through. With the gate enabled, a
simple read failure therefore opened the gated routes.

The gate now **fails closed**:

- The acceptance hook only reports "accepted" after a read has actually
  succeeded; a still-loading or errored read is never mistaken for the
  gate-disabled state.
- While the read is in flight the app shows a neutral "verifying" state rather
  than the gated content.
- If the read fails, the app shows a "couldn't verify — retry" state and holds
  the gated routes closed until the read resolves.

The genuine gate-disabled state (no Terms version published on-chain) and the
already-accepted state still pass through immediately once the read succeeds, so
there's no change for the normal case — only the loading / read-failure bypass is
closed. This is the surface the #800 sanctions & Terms-gate matrix flagged as a
confirmed divergence; it is now resolved.

Closes #822.

## Sanctioned-buyer loan-sale completion: vault-lock (#831)

The final follow-up to the #821 sanctions wind-down work. #821 made the
direct close-outs (repay / default / liquidation) complete-and-freeze when a
loan party is sanctions-flagged. This closes the matching gap on the
**completion** path of a loan sale, where a buyer is already committed.

If a buyer of a lender position became sanctions-flagged **after** committing to
the purchase but before the sale was finalised, completing the sale used to
**revert** — because the buyer's share is paid into their own vault, which is
screened. That would have stranded the committed seller (and everyone else in
the trade) on something outside their control.

Now the completion finishes regardless: the buyer's share is deposited into
their **own** vault, frozen behind the same protections as #821 (the buyer can
neither move the acquired position out of their wallet nor claim its payout
while flagged), and an on-chain event records the parked proceeds for operator
reconciliation. A buyer who is not flagged is unaffected.

The offset-completion path was reviewed in the same pass and needed no change —
it only records the parties' claims and transitions the loan; the actual
proceeds move later at claim time, which #821 already handles.

Closes #831.
