## Thread — T-092 follow-up: keeper auto-extend pass (#512)

Partial fold of T-092 follow-up #512. Wires the auto-extend executor into `apps/keeper` as a new cron pass. The sibling reference bot `vaipakam-keeper-bot` is tracked in its own repo and will land in a separate PR.

### What's new

**New `apps/keeper/src/autoLifecycle.ts`** — sixth Worker pass after watcher / daily oracle / matcher / liquidity confidence / liquidator. Per cron tick, per chain:

1. Read `AdminFacet.getAutoExtendEnabled()`. Skip the chain when the admin kill switch is off — every per-user consent flag stays intact but the executor is dormant.
2. `getActiveLoansCount` → short-circuit when zero.
3. Page `getActiveLoansPaginated` for the loan id list.
4. For each loanId, read both `getAutoExtendBorrowerCaps(loanId)` and `getAutoExtendLenderCaps(loanId)`. Each getter applies the staleness fence internally — a transferred NFT returns `enabled: false`.
5. When both sides are enabled, pick `newRateBps` at the lender's floor (most conservative for the borrower while still respecting the lender's minimum) and `newDurationDays` to fit inside `min(both maxNewExpiry)` — capped at 30 days per extension so a borrower's consent doesn't roll forward indefinitely without re-affirmation.
6. Submit `extendLoanInPlace`. The contract enforces every safety guard (sub-day-since-start, grace expired, sanctions, etc.) — failures bubble up here as logs and the pass continues to the next loan.

Soft per-tick cap of 5 extends so one rogue chain can't burn the keeper's gas budget; remainder rolled forward to the next tick.

### What's NOT in this PR

- **Auto-refinance** — requires composing the matcher's match path with refinance-tagged offers (create → accept → refinanceLoan). The existing `runMatcher` pass already drives matchOffers; combining them into a single auto-refinance pass is the next composition step.
- **Sibling repo** (`vaipakam-keeper-bot`) auto-extend detector — separate repo, separate PR. Filed as a card.

### Verification

- `pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit` clean.
- `apps/keeper/src/index.ts` updated to spawn `runAutoLifecycle(resolved)` alongside the existing five passes.
- ABI imports route through the shared `@vaipakam/contracts/abis` bundle (no Worker-specific export needed).

### Operator action

Once governance flips `setAutoExtendEnabled(true)` on a chain, the keeper begins scanning that chain's active loans on the next cron tick. No Cloudflare config changes; the pass reads the same `KEEPER_ENABLED` + `KEEPER_PRIVATE_KEY` secrets as the existing liquidator / matcher / liquidity-confidence passes.
