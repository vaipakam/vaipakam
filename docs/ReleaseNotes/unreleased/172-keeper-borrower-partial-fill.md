## Thread — Apps/keeper matcher: lift the single-fill break + fan-out lender across borrowers (PR #<n>)

Closes [#172](https://github.com/vaipakam/vaipakam/issues/172). Tracks the contract change that landed in PR #174 (#102) on the keeper side: the matcher tick used to break the inner borrower-iteration loop on the first successful match — an implicit Phase 1 single-fill assumption that the comment said so explicitly. After #102 lifted that rule end-to-end on the contract, the keeper needs to fan-out instead.

### What this PR ships

A single edit to `apps/keeper/src/matcher.ts`'s `runOfferMatcherTickForChain`:

- The unconditional `break;` after a successful `submitMatch` is gone.
- The inner loop now `continue;`s by default — the same lender can match additional borrowers in the same tick (lender partial-fill fan-out), and the same borrower can match additional lenders in the same tick via the OUTER loop (borrower partial-fill fan-out).
- Early-exit ONLY when `preview.lenderRemainingPostMatch === 0n` (the lender is fully filled; nothing left to allocate).
- The `attempted` set already prevents re-trying the exact (L, B) pair within a tick, so no infinite loop.

### Why the small surface

The matcher was already mostly correct. It filtered out `accepted` offers during hydration (`hydrateOffers` line 198: `if (o && !o.accepted) out.push(o)`), and that filter just-works under #102 — partial-filled borrower offers have `accepted = false` until dust-close, so they stay in the candidate set automatically. The only remaining single-fill assumption was the post-submit `break`, which assumed the borrower offer was now terminal. Removing it lets the matcher fan-out.

### Behavior the matcher now exhibits

| Scenario | Pre-#172 | Post-#172 |
|---|---|---|
| Lender L matches borrower B1 ($X out of $Y range) | Breaks inner loop — L untouched, B1 NEVER tried again | Continues — L attempts B2, B3, ... in the same tick, fanning out remaining capacity |
| Same lender L matches multiple borrowers in one tick | One match max per tick per lender | Up to `MAX_SUBMITS_PER_TICK` matches per tick across the whole order book |
| Lender L is now fully filled after match | Implicit (the `break` happened to also catch this) | Explicit `if (lenderRemainingPostMatch === 0n) break;` |
| Borrower B matched once, has remaining capacity | NEVER matched again on this tick (single-fill assumption) | Available to be matched by the NEXT lender in the outer loop (different L, same B, new pairKey) |
| `partialFillEnabled` master flag off (contract reverts on attempted partial) | Same — `matchOffers` reverts; matcher logs once-per-chain, retries next tick | Same — graceful degradation, behaviour identical to pre-#172 when flag is off |

### What's NOT in this PR (filed as follow-ups if needed)

- **In-memory lender state tracking**: today the matcher rehydrates offers at tick START; mid-tick, a successful match changes lender's `amountFilled` on-chain but not in the local `OfferLite`. Subsequent `previewMatch` calls within the same tick read the LIVE on-chain state (correct). The local cache is stale but only as an optimization hint, not a correctness invariant. A future optimization could decrement local lender capacity to skip preview calls against now-exhausted lenders — but the contract's `previewMatch` already returns `AmountNoOverlap` for that case, so the optimization is cheap-to-skip.
- **Public reference keeper bot at `vaipakam/vaipakam-keeper-bot`** — separate sibling repo; needs the same single-line fix applied via the keeper-bot ABI sync flow. Tracked outside this PR (the public bot updates lag the production matcher by design).
- **Borrower-side dust-close handling**: when a borrower offer reaches dust-close (per #102), the contract auto-closes it and emits `OfferClosed`. The matcher's `hydrateOffers` filter (`accepted`) already excludes dust-closed offers on the NEXT tick. No matcher-side change needed.

### Round-1 Codex correction — wait for tx inclusion before continuing

Codex round-1 caught a P1 race: `submitMatch` used `writeContract` (which returns on BROADCAST), not waiting for inclusion. Without waiting, the loop continued to subsequent (L, B) pairs immediately; the next `previewMatch` read `latest` state which didn't include the broadcast tx's effects yet, so multiple matches got queued against the same lender's unconsumed capacity. The first match landed; the rest reverted when mined.

Fixed by mirroring the sibling pattern at `apps/keeper/src/dailyOracleSnapshot.ts:127`:

```ts
const hash = await ctx.wallet.writeContract({ ... });
const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
if (receipt.status !== 'success') return false;  // on-chain revert
```

Trade-off: tick wall-clock now includes block-time per match. Worst-case: `MAX_SUBMITS_PER_TICK (25) × block_time`. Acceptable; the next cron either overlaps via the Workers concurrency lock or starts fresh state. Far cheaper than burning gas on N-1 reverts every tick.

### Verification

- ✅ `pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit` clean (both pre- and post-fix)
- Manual: with `partialFillEnabled` on (true on every fresh Vaipakam deploy post-#102), a single matcher tick now consumes multiple slices of a borrower offer across compatible lenders; observable via `[matcher] submits=N` log line (N ≥ 2 on a busy book). Each match awaits receipt before the next is broadcast.

### Dependencies

- ✅ #102 (PR #174) — borrower partial-fill on the contract side; this PR is the keeper-side follow-up
- ✅ #163.A (PR #171) — ADR-0010 design lock that makes the matcher's behavior coherent
- Parallel-track sibling: [#165 / PR #175](https://github.com/vaipakam/vaipakam/pull/175) — frontend GTC UI

🤖 Generated with [Claude Code](https://claude.com/claude-code)
