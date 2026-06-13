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

**Liened VPFI collateral is never lost.** The encumbrance sub-ledger protects
every `(user, asset, tokenId)` lien independently of which token is "current":
old VPFI collateral remains encumbered under the *old* token key and the
standard vault-withdraw guard blocks draining it regardless of rotation.

**But un-liened, protocol-tracked old-token balances can get STUCK.** A user
may hold VPFI in their vault that is tracked by `protocolTrackedVaultBalance`
but is **not** under an active offer/loan/lien — e.g. staked VPFI for the fee
discount, or deposited-but-uncommitted VPFI. After a rotation:

- `VPFIDiscountFacet.withdrawVPFIFromVault` resolves `s.vpfiToken` to the
  **new** token, so it can no longer withdraw the user's **old**-token
  balance; and
- `recoverStuckERC20` only releases `balanceOf − protocolTrackedVaultBalance`
  (the *untracked* excess), so the old **tracked** balance has no public exit.

The funds are not permanently lost — governance can rotate back or add a
migration path — but they are stranded until then. **This is the reason the
drain step below must cover ALL protocol-tracked old-token balances, not just
offers/loans/encumbrances.** Provided the drain is complete, no funds are
stuck and the check mismatches reduce to a correctness/UX window. This is why
the chosen guard is this runbook + an on-chain audit event (`VPFITokenRotated`)
rather than per-offer/loan address snapshotting (which would not address the
staked/tracked-balance stranding anyway — see "Decision" below).

## Procedure (pause → drain → verify → rotate → re-enable)

1. **Announce + freeze inflow.** The safest freeze is a **global guardian
   pause** — it halts every VPFI-touching entry point at once. **Prefer it.**
   If you pause selectively instead, the freeze set MUST include not only
   offer-create and offer-accept but also the **VPFI vault-deposit surfaces**
   — `depositVPFIToVault` / `depositVPFIToVaultWithPermit` — because they
   stamp `protocolTrackedVaultBalance[user][oldToken]` under the *current*
   token. A deposit (or staking top-up) that lands after enumeration but
   before `setVPFIToken` would re-create exactly the stranded tracked balance
   this runbook guards against. Missing a surface re-opens the gap, which is
   why the global pause is recommended.
2. **Enumerate ALL old-token exposure.** Identify every:
   - open offer whose `prepayAsset` or `collateralAsset` == old token;
   - active loan whose `collateralAsset` == old token (VPFI collateral);
   - any non-zero VPFI encumbrance (`s.encumbered[user][oldToken][0]`);
   - **any non-zero `protocolTrackedVaultBalance[user][oldToken]`** — i.e.
     staked VPFI for the fee discount, or deposited-but-uncommitted VPFI —
     **even with no active offer/loan/lien.** This is the class that strands
     after rotation (no public exit; see "Why a rotation needs care"), so it
     MUST be in the drain set, not just offers/loans.
   Enumerate via the indexer or a **full** active-offer scan filtered on
   `collateralAsset` **and** `prepayAsset` == old token — NOT
   `MetricsFacet.getActiveOffersByAsset`, which keys on `lendingAsset` only
   and would MISS old-token prepay and collateral offers — plus a full active-
   loan scan (by `collateralAsset`) and the per-user
   `protocolTrackedVaultBalance` ledger for the old token.
3. **Drain them.** Cancel/let-expire the offers; settle/close/let-mature the
   loans so their collateral lien releases; have users unstake + withdraw
   their tracked old-token VPFI (or migrate it) so every
   `protocolTrackedVaultBalance[user][oldToken]` returns to zero. Goal: **zero**
   live references to the old token, zero old-token encumbrance, **and zero
   old-token protocol-tracked vault balance.**
4. **Verify zero exposure.** Re-scan step 2 — offers, loans, encumbrances, AND
   tracked vault balances — and confirm nothing remains under the old token.
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
Rationale: the exposure is low and recoverable. Liened collateral is never at
risk (the encumbrance sub-ledger protects each token's liens independently);
the one real stranding risk — un-liened protocol-tracked old-token balances
(staked VPFI) — is **governance-recoverable** and is fully eliminated by the
drain step above. Snapshotting (2) keys off offers/loans, so it would not even
address that staked/tracked-balance stranding, while adding a permanent
per-offer/loan struct-field + read-site cost — not justified for a rare,
pre-live, migration-class event. Option (1) needs a global "live VPFI
references" counter the protocol doesn't currently maintain. The runbook
(covering tracked balances) plus a detectable rotation event gives a
proportionate operational guardrail. If the protocol later expects routine
VPFI rotations with live state, revisit a fuller on-chain migration path
(balance migration + dual-token withdraw), which is the part snapshotting
alone would miss.
