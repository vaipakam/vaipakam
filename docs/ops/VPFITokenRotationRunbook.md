# VPFI Token Rotation Runbook

**Scope:** Safely changing the VPFI token address registered on the Diamond
(`VPFITokenFacet.setVPFIToken`) **after** it has already been set — i.e. a
*rotation* (one non-zero address → a different one), as opposed to the
one-time initial registration (`address(0)` → token) done at deploy.

**Issue:** #575. **Risk class:** low / operational. A rotation is a rare,
migration-class event (e.g. replacing the VPFI proxy during a token
migration). No production state exists pre-live, so this is a *defensive*
procedure, not a response to a live bug.

## Why a rotation needs care

Two checks read the **live** `s.vpfiToken` rather than a per-offer/loan
snapshot:

- **D-2** (`OfferAcceptFacet`) — VPFI is forbidden as an NFT-rental *prepay*
  asset. The check compares `offer.prepayAsset` against the current
  `s.vpfiToken` **at accept time**.
- **F-1** (`VPFIDiscountFacet.withdrawVPFIFromVault`) — the VPFI-collateral
  encumbrance consult keys off the current `s.vpfiToken`.

If `s.vpfiToken` is rotated while offers/loans created under the **old**
token are still in flight, those checks evaluate against the **new** token —
a mismatch window. Observable effects: a previously-valid offer can become
un-acceptable; the F-1 consult reads the new token while a live loan's
collateral sits under the old one.

**There is no fund-loss path.** The encumbrance sub-ledger protects every
`(user, asset, tokenId)` lien independently of which token is "current": old
VPFI collateral remains encumbered under the *old* token key and the standard
vault-withdraw guard blocks draining it regardless of rotation. The mismatch
is a correctness/UX concern on the checks, not a drain. This is why the
chosen guard is this runbook + an on-chain audit event (`VPFITokenRotated`)
rather than per-offer/loan address snapshotting (see "Decision" below).

## Procedure (pause → drain → verify → rotate → re-enable)

1. **Announce + freeze inflow.** Pause the VPFI-touching entry points (or
   globally pause via the guardian) so no *new* offers/loans can reference
   the old token while you drain. At minimum: offer-create, offer-accept.
2. **Enumerate live old-token references.** Identify every:
   - open offer whose `prepayAsset` or `collateralAsset` == old token;
   - active loan whose `collateralAsset` == old token (VPFI collateral);
   - any non-zero VPFI encumbrance (`s.encumbered[user][oldToken][0]`).
   Use the indexer / `getActiveOffersByAsset` + loan enumeration.
3. **Drain them.** Cancel/let-expire the offers; settle/close/let-mature the
   loans so their collateral lien releases. Goal: **zero** live references to
   the old token and zero old-token encumbrance.
4. **Verify zero exposure.** Re-scan step 2 and confirm nothing remains.
5. **Rotate.** `VPFITokenFacet.setVPFIToken(newToken)` (ADMIN_ROLE /
   timelock). This emits both `VPFITokenSet` and — because `previous != 0` —
   `VPFITokenRotated(previous, newToken)`.
6. **Confirm the audit event.** Ops/indexer must observe `VPFITokenRotated`
   and record that steps 1–4 were completed before it fired. (The event is
   the on-chain breadcrumb that a rotation happened; it does not by itself
   prove the drain — that is this runbook's responsibility.)
7. **Re-enable.** Unpause the entry points. Verify new VPFI offers/loans key
   off the new token.

## Decision (recorded for #575)

Options weighed (per the issue): (1) block rotation while live references
exist, (2) snapshot the VPFI address onto each offer/loan and have D-2/F-1
read the snapshot, (3) this operational runbook.

**Chosen: (3) runbook + an on-chain `VPFITokenRotated` audit event.**
Rationale: the exposure is low with no identified fund-loss path (the
encumbrance sub-ledger already protects each token's liens independently), so
the permanent per-offer/loan struct-field + read-site cost of snapshotting
(2) is not justified for a rare, pre-live, migration-class event. Option (1)
needs a global "live VPFI references" counter the protocol doesn't currently
maintain. The runbook plus a detectable rotation event gives a proportionate
operational guardrail. If the protocol later expects routine VPFI rotations
with live state, revisit (2).
