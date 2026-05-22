# Dashboard.tsx Hook Migration Plan

**Status:** Draft, awaiting sign-off
**Scope:** Replace the per-feature read hooks on the Dashboard
page with the bundled `MetricsDashboardFacet` reader hooks
landed by §A.1.
**Out of scope:** any change to non-Dashboard surfaces, the
public stats page, the offer book, the activity feed.

## 1. Why a planned refactor

`Dashboard.tsx` (798 lines) currently coordinates 6+ user-domain
hooks for the first paint:

| Hook | Reads issued today |
|---|---|
| `useUserLoans` | 1 indexer fetch + 1×`getLoanDetails` multicall + 1×`ownerOf` multicall |
| `useIndexedLoansForWallet` | 1 indexer fetch (parallel lender + borrower) |
| `useLoanRisks` | 1×`calculateLTV` multicall + 1×`calculateHealthFactor` multicall |
| `useMyOffers` | 1 indexer fetch (`/offers/by-creator`) + multicall fallback |
| `useClaimables` | up to N+1 reads per loan (×ownerOf, ×getClaimable, ×getBorrowerLifRebate) |
| `useStakingRewards` + `useInteractionRewards` + `useUserVPFI` + `useVPFIDiscountConsent` | 4–9 single-purpose reads |

Total on a happy-path cold load: **~13 RPC calls** (or ~18 on
indexer fallback) — exactly the gap §A.1 / D1–D4 was built to
close.

Naively swapping in the new hooks risks behaviour regressions in
loan-row sorting, page-state, claim-button availability, and the
filter chips. A staged migration with explicit checkpoints keeps
the diff reviewable.

## 2. Target hook layering (post-migration)

```
Dashboard.tsx
├── useDashboardSnapshot(address)          — scalar headline
│      → header counters, rewards cards, VPFI tier indicator,
│        consent toggle preconditions
├── useDashboardLoans(address, side, off, lim)
│      → "My Loans (Lender)" + "My Loans (Borrower)" panels
│        — replaces useUserLoans + useIndexedLoansForWallet +
│        useLoanRisks for these surfaces
├── useDashboardOffers(address, filledOnly, off, lim)
│      → "My Offers (Open)" + "My Offers (History)" panels
│        — replaces useMyOffers
└── useDashboardClaimables(address, side, off, lim)
       → "Claimable" panel — replaces useClaimables
```

Hooks that stay: `useRescanCooldown`, `useDiamondContract`
(write client), `useDiamondPublicClient`, `useWallet`,
`useTranslation`. None of them touch the per-user read surface.

## 3. Migration stages

Each stage is one PR / commit, independently reviewable + revertable.

### Stage 1 — Headline cards (LOW risk)
- Wire `useDashboardSnapshot` into the page-top counter row.
- Replace the staking + interaction reward cards' read sources
  with the snapshot's `stakingRewardsPending` /
  `interactionRewardsPending`.
- Replace the VPFI consent gate's read with the snapshot's
  `vpfiDiscountConsented`.
- KEEP every existing hook in place — Stage 1 only ADDS the new
  hook for the cards above. The two read paths run side-by-side
  for one commit so a bad payload shape can be detected without
  losing the live UI.

**Acceptance:** `tsc -b --noEmit` clean; existing tests untouched;
manual smoke test on a wallet with active loans.

### Stage 2 — Loans table (MEDIUM risk)
- Replace `useUserLoans` + `useIndexedLoansForWallet` +
  `useLoanRisks` with `useDashboardLoans` (one call per side).
- Update the sort/filter/page-state shapes — the new hook
  returns rows already enriched with `ltvBps` + `healthFactor`,
  so the `useLoanRisks` join logic disappears.
- Track per-side pagination state separately (the hook is
  side-keyed already).

**Risk:** sort comparators currently expect a `LoanSummary` shape
slightly different from the bundled `Loan` struct. Map at the
hook boundary or extend the contract type.

**Acceptance:** sorting + filtering + pagination remain pixel-
identical; manual test of all six column headers.

### Stage 3 — Offers table (LOW–MEDIUM risk)
- Replace `useMyOffers` with `useDashboardOffers`.
- Keep `MyOffersTable` component contract; map the new hook's
  shape at the page boundary if needed.

**Acceptance:** open-vs-filled toggle still works; the per-status
counts come from the snapshot, the rows from the paginated hook.

### Stage 4 — Claimables panel (MEDIUM risk)
- Replace `useClaimables` with `useDashboardClaimables`.
- Important: the existing hook resolved per-row `lifRebate`
  amounts via separate reads. The bundled getter doesn't include
  the rebate amount — only the underlying claim's amount. If
  the rebate is needed for the row UI, either:
    (a) add a `borrowerLifRebate.rebateAmount` slot to the
        getter's return shape (contract change, ~5 LOC + test),
    (b) leave a separate `useBorrowerLifRebate(loanId)` mini-hook
        for the per-row lazy fetch.
- Recommendation: (a) — keeps Dashboard.tsx in single-call
  territory.

**Acceptance:** every claim row renders the correct amount + asset
+ NFT-gated claim button state.

### Stage 5 — Cleanup
- Delete `useUserLoans`, `useMyOffers`, `useClaimables`,
  `useIndexedLoansForWallet`, `useLoanRisks` import sites in
  Dashboard.tsx.
- If no other consumer remains, delete the hooks themselves +
  their indexer-client helpers.
- Search for `useStakingRewards` / `useInteractionRewards` /
  `useUserVPFI` / `useVPFIDiscountConsent` import sites — the
  snapshot supersedes them on this page; if they're used
  elsewhere keep them, otherwise remove.

**Acceptance:** repo-wide grep confirms no orphaned imports;
`tsc -b --noEmit` clean.

## 4. Open questions

1. **Does the snapshot need to surface raw `userStakedVPFI`?**
   The current `useStakingRewards` returns it; only the rewards
   card's "you have X staked" subtitle reads it. If yes, add to
   the contract's `DashboardScalars`. If no, drop the subtitle.
2. **Where does `borrowerLifRebate` rendering live today?**
   Confirm before Stage 4 so we know whether to extend the
   getter (recommended) or keep a per-row hook.
3. **Should the `MyOffersTable` component own the new hook itself?**
   If yes, Dashboard.tsx becomes thinner; tests against the
   table component change. Cleaner long-term.
4. **Pagination footprint** — the contract caps `limit ≤ 100`.
   Current Dashboard's per-page size is 10 for the loans table
   and 20 for offers. Keep current values or unify to 20?

## 5. Estimated effort

| Stage | Effort |
|---|---|
| 1 | ~1 hour |
| 2 | ~2 hours |
| 3 | ~1 hour |
| 4 | ~1.5 hours (longer if extending getter for LIF rebate) |
| 5 | ~30 min cleanup + grep sweep |

Total: **~6 hours** of focused work, spread across 5 commits for
clean review.

## 6. What this plan does NOT do

- Touch `PublicDashboard` or any non-user surface.
- Migrate Activity / VaultAssets / OfferBook (different hooks,
  different scope).
- Wire `useHistoricalAssetPrice` into the historical-TVL chart
  (separate refactor — see §A.4 ship-now note).
- Modify the existing watcher D1 indexer surfaces.

---

**Awaiting sign-off** on:
- Stage breakdown above (any reordering / merging?).
- Open questions §4.1–4.4.
- Whether Stage 1 should land first as a standalone commit
  (recommended) or fold into Stage 2.
