# `vaipakam-mesh-watcher`

Internal-only Cloudflare Worker that watches the **VPFI recycling mesh**
— #1222 M3 B4-c of the
[recycling completion programme](../../docs/DesignsAndPlans/VpfiRecyclingCompletionPlan.md).

Every 15 minutes it reads the per-chain recycled ledger from the canonical
reward chain, and each mirror's own bucket and reservation counters from
that mirror's own Diamond, then checks the accounting relations that hold
those two views together. Detection only — it moves no funds, pauses
nothing, and holds no signing key.

---

## Why a watcher at all

The mesh's per-chain books are the one part of the recycling design that
**no single-chain test can verify**. Base decides how much recycled budget
a mirror may fund from its own bucket, using Base's *model* of that
mirror's availability; the mirror then reserves against its *actual*
bucket. Those two numbers live on different chains, are updated by
different transactions, and reconcile only through periodic day-close
reports. A test can prove each side correct in isolation. Only an
observer reading both at once can prove they still agree.

---

## What it checks

### CRITICAL — relations that cannot legitimately break

Each of these is maintained by construction in the contracts. A violation
is a bug, a spoofed report, or storage corruption — never ordinary
operation. These page.

| Check | Relation | Why it cannot legitimately break |
| --- | --- | --- |
| `commit-identity` | `outstanding + retired == consumed`, per chain | Two writers maintain it together — `LibMeshFunding` increments the instruction cumulative and the reservation ledger in the same step, `recordChainCommitRetirement` moves the retirement delta from one to the other. A mismatch means one ran without the other. |
| `clamp-chain` | `released ≤ retired ≤ consumed` | Base trusts a mirror for *timing* only, never magnitude: both cumulatives are clamped against Base-local state on ingest. The second clamp chained onto the first is what forces `avail ≤ reported`. |
| `attribution-ceiling` | `attributed ≤ reported` | Day credits beyond the reported cumulative would feed the `Ā` absorption average with absorption that never happened, and Base would size real reward budget against it. |
| `availability-formula` | `avail == reported − max(0, consumed − released)` | The operator view and the funding pass call one shared helper precisely so they cannot drift. Re-deriving it off-chain catches a deployed implementation that is no longer the function the plan and specs assume. |
| `base-self-inert` | Every per-chain figure under the canonical chain's own id is zero | Base is never a "local" funder in the commit split — its slice comes from the same bucket the global ledger governs. Non-zero here means Base double-booked itself, corrupting the global reservation *and* netting its own bucket twice. |
| `base-ahead-of-chain` | Base's accepted cumulatives never exceed the chain's own | Base accepts clamped, lagging copies. Trailing is normal; leading is impossible without a spoofed or replayed report. This is also what makes the B2-d5 custody exclusion observable — the chain's own reported figure nets relocated custody out, so Base reading higher means it folded its own remitted top-up back in as that chain's local absorption. |
| `bucket-coverage` | A chain's live bucket backs its own reservations | Reservation on arrival is **unclamped** — the mirror adds whatever Base instructed, bounded only by Base's model. This is the check that catches the model over-stating the bucket. |

**On the bucket-coverage tolerance.** The comparison allows
`BUCKET_COVERAGE_TOLERANCE_WEI` of slack (default 1e15 = 0.001 VPFI)
rather than being exact. `LibVpfiRecycle.consume` deliberately *floors*
the bucket at zero instead of reverting, because bounded cap-trim dust can
make a day's consumption exceed its recorded commitment by wei-scale
amounts, and a payout the claim math authorised must not brick on ledger
dust. An exact comparison would therefore fire on healthy rounding. Real
shortfalls are VPFI-scale, many orders of magnitude above the tolerance.

### ADVISORY — necessary, not sufficient

These are labelled and non-paging on purpose.

**`stuck-settlement`** — a chain has recycled commitments outstanding
while retirement stays flat across the window.

This condition was settled over three review rounds on #1439 and the
plan's §M7 records it. Three things it deliberately is **not**:

- **Not `consumed − released`.** A healthy mirror that pays claims and
  simply has no forfeits or expiries keeps that positive with `released`
  flat forever, so an alert keyed on it fires continuously on normal paid
  settlement. Retirement distinguishes settling from stuck; releases
  quantify how much capacity settlement gave back. (Only releases restore
  availability — a claim that *consumes* its commitment advances
  retirement while availability stays exactly as low, because those tokens
  really left the bucket.)
- **Not "outstanding is growing".** Growth stops on its own once Base
  exhausts the chain's reported capacity and has nothing left to instruct.
  A growth-keyed alert would clear precisely when the condition became
  permanent.
- **Not sufficient.** A chain with no claims, forfeits or expiries falling
  due in the window satisfies both halves legitimately — commitments stay
  reserved until a user or horizon event retires them. The
  settlement-EXPECTED qualifier that would make this pageable is open
  design work on **#1442**. Shipping it as a pager today would train the
  operator to ignore it.

Retirement is read from the **chain's own** ledger when the chain is
reachable, because that moves the instant the chain retires anything —
independent of whether its report reached Base. Reading Base's copy
instead would conflate stuck settlement with a stalled report pipeline,
which is the separate signal below.

**`report-lag`** — Base's accepted cumulative for a chain sits below that
chain's own *and has not moved* across the window. Trailing alone is
normal (reports are periodic); trailing while frozen means the report path
stalled, which is what the B2-d2 zeroed-chain manual-budget path exists to
reconcile.

**`coverage-gap`** — a chain in `getExpectedSourceChainIds()` that this
tick could not read (no committed deployment stanza, no RPC secret, or a
failed call). Always surfaced: a watcher that quietly narrows its scope
reports "all clear" for chains it never looked at.

---

## Design notes

**The chain set comes from the contract, not from config.** Every tick
reads `getExpectedSourceChainIds()` from the canonical Diamond. A mirror
wired on-chain is watched as soon as it is wired; the only operator step
is its RPC secret, and its absence is a reported coverage gap rather than
a silent skip. The canonical chain's own id is included deliberately — its
per-chain books must be inert, and `base-self-inert` is what proves it.

**ABIs are compiled, not hand-typed.** `src/abi.ts` imports the exported
`RewardAggregatorFacet.json` relatively, so the Solidity compiler stays the
single source of truth for every decode shape (CLAUDE.md, *Worker ABI
consumption*). `ops/lz-watcher` hand-wrote its signatures with `parseAbi`,
correctly — it read the LayerZero standard surface, none of which is in the
Diamond ABI. This Worker reads only the Diamond, where that shortcut is
exactly the 2026-05-05 offer-decode-drift failure mode.

A JSON import cannot be `as const`, so viem's return types degrade to
`unknown` and this module labels the tuple positions by hand. **That**
could drift, so `assertAbiShape()` runs before any read each tick and
throws unless every watched view still has the exact output arity, order,
names and types the readers assume. A facet re-export that changes a shape
fails the first tick with a precise message instead of quietly mislabelling
a ledger figure — and the CI job below catches it before deploy.

**Its own D1, its own Telegram bot.** `vaipakam-mesh-alerts-db`, not the
shared `vaipakam-archive`; `TG_OPS_BOT_TOKEN`, not the user-facing
`TG_BOT_TOKEN`. Same trust-boundary reasoning that gave `ops/lz-watcher`
its own database: internal ops alerting must not co-locate with
user-facing data, and splitting the bots bounds the blast radius of a
token leak in either direction. Consequently CLAUDE.md's rule that all
schema changes land under `apps/indexer/migrations/` does **not** apply
here — that rule owns the shared archive; `migrations/` in this directory
owns this database.

---

## Tests

```bash
npm ci --ignore-scripts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
```

The suite is **mutation-verified**: every check has been removed or
subtly broken in turn, and each mutation was confirmed to turn the
specific test that targets it red — including the floor in the
availability model, the direction of the identity comparison, the
tolerance boundary, the streak's marker-reset, and each half of the
report-lag and stuck-settlement markers. The shared fixture is a
*healthy* mesh whose first test asserts zero findings, so a fixture that
drifted into violating something fails loudly instead of making every
other test pass for the wrong reason.

CI runs both steps via the `ops/mesh-watcher (typecheck + tests)` job in
`.github/workflows/ci.yml`, triggered by changes under this directory
**or** under `packages/contracts/src/abis/`. It is not a required check —
this Worker is detection-only, so a red here informs rather than blocks a
contracts merge.

---

## Deploying — operator steps

Nothing below has been run yet; the Worker is code-complete and
undeployed.

1. **Create the database** and paste its id into `wrangler.jsonc`:

   ```bash
   cd ops/mesh-watcher
   wrangler d1 create vaipakam-mesh-alerts-db
   # → copy `database_id` into the d1_databases block
   npm run db:migrate
   ```

2. **Set the secrets** — never commit these:

   ```bash
   wrangler secret put TG_OPS_BOT_TOKEN     # the OPS bot, not TG_BOT_TOKEN
   wrangler secret put RPC_84532            # canonical (Base Sepolia)
   wrangler secret put RPC_421614           # each mirror, keyed by chain id
   ```

3. **Set the vars** in `wrangler.jsonc`: `TG_OPS_CHAT_ID` and
   `CANONICAL_CHAIN_ID` (84532 for Base Sepolia, 8453 for Base).

4. **Deploy and verify** before trusting the cron:

   ```bash
   npm run deploy
   curl -s https://vaipakam-mesh-watcher.<subdomain>.workers.dev/run | jq
   ```

   `GET /run` executes one tick synchronously and returns its summary —
   `chainsObserved`, `critical`, `advisory`, `coverageGaps`, `sent`. A
   first run showing `coverageGaps > 0` means a mirror is wired on-chain
   but has no RPC secret yet; fix that before relying on the alerts, or
   the mesh is only partly watched.

The 15-minute cron slot is the one freed by retiring
`vaipakam-lz-watcher`, whose LayerZero surface the T-068 CCIP migration
and the #687-A securities excision had between them made entirely dead.
Retiring that Worker's *source tree* is tracked separately on **#1440**.
