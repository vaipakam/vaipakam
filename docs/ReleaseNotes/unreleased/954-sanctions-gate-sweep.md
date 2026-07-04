## Sanctions-gate coverage sweep — 4 entry points hardened (#921 item 2)

An earlier fix (#953) found that one reward-claim method had slipped through the
protocol's sanctions classification without its screen — proof that the
classification wasn't self-enforcing. This is the follow-up audit: **every**
external method that either creates protocol state or moves value was reviewed
against its intended sanctions posture, and the gaps were closed.

The protocol screens wallets against an on-chain sanctions oracle in two tiers:
**value-creating / value-receiving entry points** screen the acting wallet up
front, while **close-out paths** (repaying, default resolution, liquidation)
stay open so an honest counterparty can always be made whole even if the other
side is flagged — a flagged party's *proceeds* are frozen at the destination
rather than the transaction being blocked. The sweep confirmed the main entry
points were already screened correctly and found four that were not:

- **Backstop eligibility opt-in** — staging an offer for a protocol-treasury-
  backed fill now screens the wallet, so a party flagged after posting its offer
  can no longer line it up for treasury capital.
- **Partial collateral withdrawal** — pulling excess collateral back out of an
  active loan now screens the wallet (this is a discretionary withdrawal, not a
  close-out, so a flagged wallet is simply refused — the collateral stays
  backing the loan and no one is harmed).
- **Parallel-sale listing** — listing an offer's collateral for sale now screens
  both the lister and the sale's fee recipients, matching the equivalent
  per-loan listing flows (this surface had been missed entirely).
- **Swap-to-repay surplus** — when a borrower closes out by swapping collateral
  and the swap returns more than the debt, the surplus owed to a *flagged*
  current holder is now frozen (parked, not handed over) instead of sent straight
  to their wallet. The close-out itself still completes, so the honest lender is
  always made whole. The surplus is parked in the **stored borrower's** vault
  (which always exists, from the collateral posted at origination) rather than the
  current holder's — a freshly-transferred borrower position may belong to a
  wallet that never opened a vault, and the protocol refuses to open one for a
  flagged wallet, so parking it there would have reverted and *bricked* the
  must-complete close-out. It is recorded as its own claimable row so the holder
  can withdraw it through the normal borrower-claim path once they are delisted;
  without that row the frozen principal (a different asset from the loan's
  collateral, which already occupies the borrower's claim slot) would have been
  permanently stuck. If the surplus is VPFI it is also reserved against the
  unstake path until claimed, so the stored borrower can't drain a transferred
  position's proceeds. (Codex #981 P1/P2.)

A **coverage matrix** documenting the classification rule and every method's
verdict now lives at `docs/DesignsAndPlans/SanctionsGateCoverageMatrix.md`, and a
**regression guardrail** pins the fixed entry points so a future edit that drops
one of these screens fails the test suite.

## Close-out sweep completion + frozen-surplus escrow hardening (#981 / Codex #986)

The first pass hardened the swap-to-repay-full **surplus**, but review (#981)
found the same freeze-at-source treatment was missing on five sibling close-out
surfaces. All are now completed through a single shared helper so the
swap-to-repay family cannot drift:

- **Swap-to-repay lender leg** — a lender flagged after origination no longer
  bricks an honest borrower's swap-to-repay close: the lender proceeds are parked
  in the lender's own vault (frozen behind the claim gate) instead of reverting.
- **Collateral pull for a self-flagged borrower** — pulling a flagged borrower's
  own collateral out for the swap (and returning any unspent remainder) now runs
  under the same move-out exemption the other forced close-outs use, so it
  completes rather than bricking. The exemption is deliberately kept *narrow* —
  never open across the external swap.
- **Swap-to-repay partial** — this discretionary, loan-stays-open path now
  screens the direct payees (the current lender and borrower holders) and refuses
  a flagged one outright (a flagged party's must-complete escape is the full
  swap-to-repay, which freezes). Symmetric with ordinary partial repayment.
- **Fusion intent settlement** — the resolver-filled swap-to-repay terminal, which
  previously had no sanctions handling at all, now applies the identical freeze
  pattern (lender leg + surplus) and returns any residual collateral under a
  move-out window.
- **Backstop fill** — the offer creator is now re-screened at fill time, not only
  at eligibility opt-in, so a borrower flagged in the intervening window can't
  have a treasury-funded loan originated to them.

**Frozen-surplus escrow hardening.** Two subtler leaks in the parked-proceeds
model were closed. A frozen surplus is now reserved against the stored party's
spend path for **every** asset (not just VPFI), so a transferred position's
proceeds can't be consumed as offer/intent capital before the rightful holder
claims. Frozen **VPFI** owed to a delistable holder is now kept out of the vault
owner's fee-discount tier via a dedicated counter (scoped precisely so a user's
own pledged/listed VPFI is never wrongly excluded). A surplus-only close (all
collateral consumed) now keeps the loan open until the surplus is claimed, so the
delisted holder can always reach it. And the frozen-surplus lane is surfaced in
the claim read views (per-loan, by position NFT, and in the dashboard) with its
own claim event, so a holder can discover funds that would otherwise be invisible.

Closes #954. Addresses #981.
