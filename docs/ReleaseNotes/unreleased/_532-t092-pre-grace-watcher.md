## Thread — T-092-C: pre-grace notification + manual-fallback CTA (#532)

Closes the "auto-refinance is best-effort, not a guarantee" UX gap. A borrower who enables refinance caps and assumes the protocol will guarantee a successful refinance gets a warning when their loan approaches the grace boundary AND no compatible offer has been matched yet.

### What's new

**New `apps/keeper/src/preGraceWatcher.ts` pass** — seventh `apps/keeper` cron pass (after watcher / daily oracle / matcher / liquidity confidence / liquidator / auto-lifecycle). Per chain:

1. Walk active loans via `MetricsFacet.getActiveLoansPaginated`.
2. For each loan: read `AutoLifecycleFacet.getAutoRefinanceCaps`. Skip if disabled.
3. Read `LoanFacet.getLoanDetails`. Skip non-Active loans.
4. Compute `endTime = startTime + durationDays * 86400`. Skip if more than 24h away OR already past endTime.
5. Resolve the borrower-NFT owner via `ERC721.ownerOf`.
6. Look up their TG / push subscription in the existing `user_thresholds` table (no separate opt-in surface needed — borrowers who subscribed for HF alerts get the pre-grace warning automatically).
7. Throttle to 1 warning per 12 hours via the new `pre_grace_notify_state` D1 table.
8. Dispatch a stark warning explaining auto-refinance is best-effort and listing three concrete actions (review terms, tighten caps, repay manually).

**New D1 table** `pre_grace_notify_state` ([apps/indexer/migrations/0023_pre_grace_notify_state.sql](apps/indexer/migrations/0023_pre_grace_notify_state.sql)) — separate from `notify_state` (HF band hysteresis) so the two concerns can't trip over each other.

**New db helpers** `getPreGraceNotifyState` / `putPreGraceNotifyState` in [apps/keeper/src/db.ts](apps/keeper/src/db.ts).

**index.ts wired** — pass slotted in after `runAutoLifecycle`. Same `try/catch` per-pass safety net the rest of the scheduled handler uses.

### Why a separate pass and not folded into runWatcher

The HF watcher iterates the user's active loans via `getUserActiveLoans` (subscribed-user subset, HF-band-driven hysteresis). The pre-grace watcher cares about ALL active loans on the chain (auto-refinance caps can be set on any loan, by any borrower) and triggers on time-to-grace, not HF band. Mixing the two would muddy `notify_state.last_band` hysteresis. Splitting keeps each pass's invariant simple.

### Out of scope

- **"No compatible offer exists" check** — the v1 warning fires on any loan approaching grace with caps enabled, regardless of whether the matcher has a viable counterparty. Adding the offer-book scan is a refinement for v2 — the existing matcher's read surface (`MetricsFacet.getMatchEligibleLoans` + `OfferMatchFacet.previewMatch`) can be queried but adds cost per loan. v1 over-warns conservatively.
- **Auto-subscribe on cap-set** — today a borrower who sets refinance caps but hasn't subscribed for HF alerts gets no pre-grace warning. Future enhancement: prompt subscription in the dapp's per-loan caps editor.
- **Loan Details dapp surface** — the warning also belongs on the dapp page as an inline banner. Separate dapp PR.
- **Atomic accept-and-refinance** ([#539](https://github.com/vaipakam/vaipakam/issues/539)) — eliminates the race condition between accept and refinance entirely. Pairs naturally with this pass.

### Verification

- `pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit` clean.
- ABI imports route through the shared `@vaipakam/contracts/abis` bundle.

### Operator action

- Apply migration `0023_pre_grace_notify_state.sql` from `apps/indexer/` (per CLAUDE.md schema discipline):

  ```bash
  cd apps/indexer/
  wrangler d1 migrations apply vaipakam-archive --remote
  ```

- No new secrets needed — reuses existing `TG_BOT_TOKEN` + `PUSH_CHANNEL_PK` + `DB` bindings.
