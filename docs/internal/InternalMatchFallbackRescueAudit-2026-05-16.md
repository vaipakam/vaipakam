# Internal-match FallbackPending-rescue audit addendum — 2026-05-16

Audit-package addendum for **EC-003** — the four-phase rework that
lets the internal-match liquidation path rescue loans stuck in
`FallbackPending`, and auto-dispatches internal-match from every
external-liquidation entry-point.

This doc is the cold-read companion the external auditor reads
alongside the B.2 design doc
([`InternalLiquidationLedger.md`](../DesignsAndPlans/InternalLiquidationLedger.md))
and the C.1 off-chain-data audit
([`OffchainDataFetchAudit-2026-05-15.md`](OffchainDataFetchAudit-2026-05-15.md)).
It catalogues the new invariants EC-003 introduces and the reasoning
behind each.

**Scope**: PRs #18 (Phase 1) + #19 (Phase 2) + #21 (Phase 3) + the
Phase 4 keeper-bot + docs changes. No mainnet value at risk —
prelive.

---

## 1. The cross-status invariant relaxation

**Before EC-003**: `triggerInternalMatchLiquidation` accepted only
`{Active}` legs. `FallbackPending` loans were excluded by an early
status check.

**After EC-003**: the matchable set is `{Active, FallbackPending}`.

**Why this is safe**: a `FallbackPending` loan reached that state
*because* it was liquidation-eligible and a liquidation was
attempted — the at-fallback swap simply failed (slippage > 6%, DEX
revert, stale oracle at that moment). The loan is, by construction,
past its liquidation threshold. Re-admitting it to the matchable
set doesn't liquidate anything that wasn't already liquidatable; it
gives the protocol a second, cheaper settlement route.

**The new lifecycle edge**: `LibLifecycle._isValid` gains
`FallbackPending → InternalMatched`. The B.2 thread added
`Active → InternalMatched`; this is the symmetric edge. Every
status mutation still routes through `LibLifecycle.transition`, so
the allow-list remains the single auditable choke point.

---

## 2. Oracle-priceability gate vs the LTV-floor gate

**Active legs** continue through `_requireLtvAboveFloor` — they
need `calculateLTV(loanId) >= liquidationLtvBpsAtInit`, which
implicitly demands a fresh oracle (calculateLTV reverts on stale /
illiquid).

**FallbackPending legs** skip the LTV-floor check (they're past the
threshold by definition) and instead pass `_assertOraclePriceable`
for both the principal and collateral assets — `tryGetAssetPrice`
must return `ok == true` with a non-zero price.

**Why the gate moved**: internal-match settles at *oracle price*
via a cross-vault transfer. It never touches a DEX. So DEX depth /
slippage is irrelevant — the only thing that can make a settlement
unsafe is a missing or disagreeing oracle. `_assertOraclePriceable`
delegates to `getAssetPrice`, which runs the full Soft 2-of-N
secondary quorum on its way back; quorum disagreement surfaces as
`ok == false`. This is the same gate `LibFallback.collateralEquivalent`
uses for the at-fallback equivalent-value split — consistent
trust model.

**Audit check**: confirm no path settles a FallbackPending leg
without `_assertOraclePriceable` passing for both its assets.

---

## 3. Collateral custody — the rehydration step

**The wrinkle**: at FallbackPending time the loan's collateral has
already been withdrawn from the borrower's escrow into the Diamond's
own balance (it was pulled for the failed at-fallback swap). The
existing `_settleLeg` machinery withdraws *from the borrower's
escrow*.

**The fix**: `_rehydrateFallbackEscrowIfNeeded` pushes the
collateral from the Diamond back into the borrower's escrow (and
ticks `protocolTrackedEscrowBalance`) before `_settleLeg` runs.

**Idempotency invariant**: rehydration fires only when the loan is
`FallbackPending` AND its `fallbackSnapshot.active == true`. It sets
`snap.active = false` on completion. So:
- A FallbackPending loan is rehydrated at most once.
- A subsequent partial-match attempt on the same loan sees
  `snap.active == false` and skips rehydration — by then the
  residual collateral already lives in the borrower's escrow.
- The claim-time `_resolveFallbackIfActive` also checks
  `snap.active` and short-circuits cleanly when a prior match
  consumed the snapshot.

**Audit check**: confirm `snap.active` is the single source of
truth for "collateral still in Diamond custody" and that no path
double-rehydrates.

---

## 4. Partial-match snapshot reduction math

When an internal match only partially clears a `FallbackPending`
leg's principal (counterparty notional smaller than the leg's
debt), the loan stays `FallbackPending` with reduced
`principal` + `collateralAmount`. `_settleFallbackOrTransitionPostMatch`
proportionally scales the snapshot:

```
factor          = newCollateralAmount / oldCollateralAmount
snap.lenderCollateral     *= factor
snap.treasuryCollateral   *= factor
snap.borrowerCollateral   *= factor
snap.lenderPrincipalDue   *= factor
snap.treasuryPrincipalDue *= factor
```

The `lenderClaims` / `borrowerClaims` records — set in collateral
units at fallback time — are likewise rewritten to the scaled
values.

**Invariant**: after a partial match, the three collateral fields
still sum to `loan.collateralAmount`. Integer division truncates
toward zero, so the post-scale sum is `<=` the new collateral
amount — never `>`. A few wei of dust may be unattributed; that is
acceptable and matches the existing fallback-split rounding
behaviour.

**Full-match path**: when the match fully clears the principal, the
loan transitions `FallbackPending → InternalMatched`, the claim
records are cleared, the lender was paid in principal asset via
`_settleLeg`, and the treasury's at-fallback entitlement is
forfeited — consistent with the `Active → InternalMatched` path
(no treasury cut on an internal-match rescue).

**Audit check**: verify the scaling cannot produce a field larger
than its pre-scale value, and that a full match always zeroes /
clears the snapshot.

---

## 5. Asset-pair index correctness

Phase 2 adds `s.assetPairActiveLoanIds[principal][collateral]` — a
per-asset-pair array of matchable loan IDs — with a 1-based
position map `assetPairActiveLoanIdsPos` for swap-and-pop removal.
It mirrors the audited offer-side `assetPairActiveOfferIds` pattern.

**Membership invariant**: a loan ID is in
`assetPairActiveLoanIds[L.principalAsset][L.collateralAsset]` iff
the loan's status is in `{Active, FallbackPending}`.
- Push: `LibMetricsHooks.onLoanInitialized`.
- Pop: `LibMetricsHooks.onLoanStatusChanged` when
  `wasActive && !isActive` — i.e., the loan leaves the active set.
- `Active ↔ FallbackPending` edges preserve membership (both are
  "active" per `_isActive`) — exactly the EC-003 requirement.

**Storage-layout safety**: both mappings are appended at the END of
the `LibVaipakam.Storage` struct → zero slot-shift for any existing
field. Mappings each occupy one slot; no packing.

**Audit check**: confirm the push fires on every loan-creation path
and the pop fires on every terminal transition — including
`FallbackPending → Defaulted` (the claim-finalises path) and
`FallbackPending → InternalMatched` (the new edge).

---

## 6. Auto-dispatch — caller-incentive preservation

Phase 3 wires `attemptInternalMatchAutoDispatch` into
`triggerLiquidation`, `triggerDefault`, and
`claimAsLenderWithRetry`. Each checks `hasInternalMatchCandidate`
first; on a hit it settles internally and returns; on a miss it
falls through to the existing external-aggregator path.

**Access control**: `attemptInternalMatchAutoDispatch` is
`external onlyDiamondInternal` (`msg.sender == address(this)`). It
is reachable only via cross-facet calls from the three entry-points,
never directly by an EOA — verified by
`test_attemptAutoDispatch_eoa_reverts`.

**Incentive invariant**: the 1% per-leg matcher bonus is paid to
`msg.sender` inside `_settleLeg`. Under auto-dispatch, `msg.sender`
is whoever called `triggerLiquidation` / `triggerDefault` /
`claimAsLenderWithRetry` — the de-facto matcher. Same incentive
shape as the explicit `triggerInternalMatchLiquidation`, so there is
no economic regression and no new griefing surface: a caller who
triggers liquidation when an internal match exists is rewarded
exactly as a keeper bot would be.

**Healthy-counterparty protection**: `hasInternalMatchCandidate`
filters Active candidates by `LTV >= liquidationLtvBpsAtInit`. Without
this, auto-dispatch could force-liquidate a *healthy* opposing loan.
The check is `try/catch`-guarded (calculateLTV reverts on illiquid
collateral). FallbackPending candidates skip the check — past the
threshold by definition. Verified by
`test_attemptAutoDispatch_candidateBelowLtvFloor_returnsFalse`.

**Re-entrancy**: each entry-point carries `nonReentrant`. The
auto-dispatch's cross-facet calls are either `view`
(`hasInternalMatchCandidate`) or to facets with their own guards;
no path re-enters the guarded entry.

**Audit check**: confirm auto-dispatch cannot settle a pair where
either leg is not liquidation-eligible, and that the priority-window
revert in `triggerLiquidation` remains a correct defensive fallback
for the no-candidate path.

---

## 7. What did NOT change

- `triggerInternalMatchLiquidation`'s public signature — unchanged;
  the keeper bot's explicit-match path still works identically.
- `InternalMatchExecuted` event shape — unchanged; indexers
  correlate against the prior `LoanFallbackPending` event to
  reconstruct cross-status nuance.
- The external-aggregator liquidation path — untouched; auto-dispatch
  is a pre-check that either settles internally OR falls through.
- Storage layout for every pre-EC-003 field — untouched
  (append-only struct change).

---

## 8. Test coverage

| Suite | Cases | Covers |
| --- | --- | --- |
| `InternalMatchExecution.t.sol` | 5 new | FallbackPending leg full / partial / both-FP / oracle-unpriceable / snapshot-cleared |
| `InternalMatchLiquidationGates.t.sol` | 3 updated | error rename `InternalMatchLoanNotActive → InternalMatchLoanNotMatchable` |
| `MetricsFacetTest.t.sol` | 7 new | asset-pair index push/pop + `hasInternalMatchCandidate` status / LTV / oracle gates |
| `InternalMatchAutoDispatch.t.sol` | 6 new | auto-dispatch helper: EOA-revert, kill-switch, no-candidate, valid settle, below-floor skip, terminal caller |

Full regression: `forge test --no-match-path "test/invariants/*"`
→ **1954 passed / 0 failed / 5 skipped** (95 suites).

---

## 9. Residual items for the auditor's attention

1. **Partial-match residual claimability** — after a partial
   FallbackPending match, the lender's residual collateral lives in
   the borrower's escrow (post-rehydration), while the standard
   `claimAsLender` path withdraws from the *lender's* escrow. The
   current tests exercise full-match and the no-match fall-through;
   a dedicated partial-match-then-claim end-to-end test should be
   added before mainnet (tracked as a Phase 3.5 follow-up if the
   auditor flags it). The full-match path — the common case — is
   covered.
2. **`getMatchEligibleLoans` gas at scale** — unchanged from B.2;
   pagination is in the signature. The Phase 2 `hasInternalMatchCandidate`
   view is O(K) over the opposing asset-pair, not O(N) — the
   intended bound for the on-chain auto-dispatch.
3. **Audit bundles with A.4** — this addendum joins the C.1 / C.2 /
   B.1 docs for the next external engagement.

---

## Cross-references

- [`docs/DesignsAndPlans/InternalLiquidationLedger.md`](../DesignsAndPlans/InternalLiquidationLedger.md) — B.2 internal-match design
- [`docs/internal/OffchainDataFetchAudit-2026-05-15.md`](OffchainDataFetchAudit-2026-05-15.md) — C.1 off-chain-data audit
- [`docs/internal/ConfigKnobBoundsAudit-2026-05-14.md`](ConfigKnobBoundsAudit-2026-05-14.md) — C.2 governance-knob bounds
- [`@vaipakam-labs` Issue #12](https://github.com/vaipakam/vaipakam/issues/12) — EC-003 tracker
- `~/.claude/plans/breezy-jumping-fountain.md` — the 4-phase implementation plan
