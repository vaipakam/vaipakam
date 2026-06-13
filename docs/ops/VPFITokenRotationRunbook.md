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

## Procedure (reduce inflow → drain → hard-freeze → re-verify under freeze → rotate → re-enable)

> **The guarantee is the re-verify under a hard freeze (step 5), not a perfect
> inflow list.** VPFI has many inflow surfaces and more may be added over time,
> so this runbook does not depend on enumerating every one. The inflow-reduction
> in step 1 just limits churn during the drain; the *authoritative* check is
> step 5 — re-confirming **zero** old-token exposure while the system is frozen,
> immediately before rotating. Anything a partial inflow-freeze missed is caught
> there.

1. **Reduce inflow (best-effort) — keep drain paths OPEN.** Pause the known
   VPFI *inflow* surfaces with whatever per-function / per-asset pause controls
   exist, while leaving the *outflow / drain* paths (withdraw, unstake, repay,
   settle, cancel, claim) open. Known inflow surfaces (**non-exhaustive** — the
   guarantee is step 5, not this list): offer-create, offer-accept; the VPFI
   vault-deposit surfaces (`depositVPFIToVault` / `depositVPFIToVaultWithPermit`);
   and, where fixed-rate VPFI sales are enabled, the buy surfaces
   (`buyVPFIWithETH`, `processBridgedBuy`). Each credits/stamps VPFI under the
   *current* token. Do **not** apply a blanket global pause here — it would also
   freeze the drain paths and deadlock the procedure (the hard freeze comes
   later, step 4, once the drain is done).
   **Caveat — no deposit-only pause.** The current Diamond does NOT expose a
   per-function deposit-only pause (you cannot freeze `depositVPFIToVault`
   while leaving withdraws open). Inflow-reduction here is therefore coarse:
   announce, and run the drain during a deliberate **low-activity window**. The
   only true inflow stop is the step-4 hard freeze; until then deposits/buys may
   still land. That residual race is acceptable pre-live (low volume) and is
   caught by the step-5 re-verify under freeze — but see **Known limitations**.
2. **Enumerate ALL old-token exposure.** Identify every:
   - open offer whose `lendingAsset`, `prepayAsset`, **or** `collateralAsset`
     == old token (a VPFI-lending offer holds pre-vaulted old-VPFI principal);
   - active loan whose `principalAsset`, `prepayAsset`, **or** `collateralAsset`
     == old token (NFT-rental loans can hold old VPFI in their prepay pool);
   - any non-zero VPFI encumbrance (`s.encumbered[user][oldToken][0]`);
   - **any non-zero `protocolTrackedVaultBalance[user][oldToken]`** — staked
     VPFI or deposited-but-uncommitted VPFI, **even with no active
     offer/loan/lien** (this is the class that strands after rotation — no
     public exit; see "Why a rotation needs care");
   - **VPFI held in the Diamond's own custody for the borrower-LIF rebate**
     (`borrowerLifRebate[loanId].vpfiHeld`) — a loan can hold this even when
     its principal/collateral are NOT VPFI, so it does not appear in the leg
     scans above; check the rebate ledger separately and let those loans reach
     terminal (settle/forfeit) so the held VPFI is released before rotating.
   Scan via the indexer or a full active-offer scan on `lendingAsset` +
   `prepayAsset` + `collateralAsset` == old token (NOT
   `MetricsFacet.getActiveOffersByAsset`, which keys on `lendingAsset` only and
   misses prepay/collateral offers), a full active-loan scan on all three legs,
   the encumbrance ledger, and the `protocolTrackedVaultBalance` ledger.
3. **Drain them ACTIVELY.** Don't rely on passive expiry/maturity. Actively
   cancel the offers (releasing pre-vaulted principal); settle / close / repay
   the loans so their liens release; have users unstake + withdraw (or migrate)
   their tracked old-token VPFI. Drive every old-token offer, loan, encumbrance,
   and tracked balance to zero by action.
4. **Hard-freeze for the rotate window.** Now that the drain is complete, apply
   a hard freeze — a global guardian pause is appropriate **here** (the drain is
   done, so it can't deadlock anything). This stops every inflow surface at once
   for the brief rotate window, including any the partial step-1 freeze missed.
5. **Re-verify ZERO under the freeze — comprehensive total-balance check.**
   With the system frozen, confirm the protocol holds **zero recoverable
   old-token VPFI anywhere it tracks or custodies it**. Do NOT rely on
   re-walking the named step-2 surfaces alone — the authoritative test is a
   TOTAL: account for the entire old-token VPFI supply the protocol controls.
   That includes the step-2 classes (offers, loans, encumbrances, tracked
   vault balances, borrower-LIF custody) **and** every place the protocol can
   hold VPFI directly — the **Diamond's own reserve balance** (fixed-rate-buy
   reserve, staking / interaction-reward pools) and any other VPFI-custodying
   contract (e.g. the cross-chain buy receiver). Concretely: sum
   `IERC20(oldToken).balanceOf(...)` across the Diamond, every user vault, and
   every custodying contract, and reconcile it to zero (or to amounts that are
   explicitly migration-handled). If anything remains, UNFREEZE, drain / migrate
   it (step 3), re-freeze (step 4), and re-verify. **This total-balance check is
   the real backstop** — it makes the procedure correct regardless of whether
   any individual surface was named in steps 1–2.
6. **Rotate — and update EVERY VPFI pointer, not just the Diamond's.**
   `VPFITokenFacet.setVPFIToken(newToken)` (ADMIN_ROLE / timelock), under the
   freeze, updates only the Diamond's `s.vpfiToken` and emits both
   `VPFITokenSet` and — because `previous != 0` — `VPFITokenRotated(previous,
   newToken)`. But other contracts carry their **own** VPFI token reference and
   must be repointed in the same window — notably the cross-chain fixed-rate
   **buy receiver** (and any buy adapter), which would otherwise keep
   minting/crediting the OLD token. Enumerate all such pointers and update them
   atomically-enough that no inbound flow lands on a stale token.
7. **Confirm the audit event.** Ops/indexer must observe `VPFITokenRotated` and
   record that the drain + zero-verification (steps 2–5) preceded it. The event
   is the on-chain breadcrumb; it does not by itself prove the drain.
8. **Re-enable.** Unfreeze / unpause. Verify new VPFI offers/loans key off the
   new token.

## Known limitations & residual risk

A fully-clean rotation with live state is genuinely a **migration-class**
operation, and this manual runbook has real limits — stated plainly so an
operator does not over-trust it:

- **No per-function deposit pause.** The Diamond cannot freeze deposits/buys
  while keeping withdraws open, so the pre-freeze drain (steps 1–3) has an
  inherent race: new old-token state can land while you drain. Mitigated by a
  low-activity window + the step-4 hard freeze + the step-5 re-verify, and
  acceptable pre-live (low volume), but not eliminated.
- **Many VPFI touch-points.** Old-token VPFI can live as offer
  principal/prepay/collateral, loan principal/prepay/collateral, encumbrances,
  staked balances, uncommitted deposits, and the borrower-LIF rebate custody —
  the step-2 list is the known set but is explicitly **non-exhaustive**; the
  step-5 under-freeze re-verify is what makes the procedure correct regardless
  of any surface the list omits.
- **Multi-pointer.** `setVPFIToken` repoints only the Diamond; the cross-chain
  buy receiver / adapter (and any future VPFI-aware contract) carry their own
  pointer and must be updated in the same window.

**For routine rotations with live state, do not rely on this manual
procedure** — build a comprehensive on-chain migration mechanism (per-position
token snapshot + tracked-balance migration + dual-token withdraw + a single
multi-pointer repoint). That is the robust answer; this runbook is the
proportionate one for a *rare, pre-live* event, paired with the
`VPFITokenRotated` audit event so any rotation is at least detectable.

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
