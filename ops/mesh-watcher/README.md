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
| `base-self-inert` | The per-chain COMMITMENT fields under the canonical chain's own id — `consumed`, `retired`, `released`, `outstanding` — are zero | Base is never a "local" funder in the commit split: its slice comes from the same bucket the global ledger governs, so it books no per-chain instruction against itself. Non-zero here means it double-booked, corrupting the global reservation *and* netting its own bucket twice. Note this is **not** every field — Base records its own chain in the ledger at day-close, so `reported`, `attributed` and `avail` are legitimately non-zero under its own id and are deliberately not checked. |
| `base-ahead-of-chain` | Base's accepted cumulatives never exceed the chain's own | Base accepts clamped, lagging copies. Trailing is normal; leading is impossible without a spoofed or replayed report. This is also what makes the B2-d5 custody exclusion observable — the chain's own reported figure nets relocated custody out, so Base reading higher means it folded its own remitted top-up back in as that chain's local absorption. |
| `consumed-cap` | `consumed − released ≤ reported`, per chain (governor §7 #6) | Base can never instruct a chain to fund more than it reported absorbing, net of what it released un-spent — `_mirrorAvailable` bounds every instruction, and `MeshLedger.invariant.t.sol` asserts it on-chain. Checked **separately** rather than inferred from the availability formula, because that formula saturates: if this bound broke, `expectedAvail` would floor to zero, the on-chain `avail` would agree, and every other check would stay green while over-instruction went completely invisible. |
| `bucket-coverage` | A chain's live bucket backs its own reservations | Reservation on arrival is **unclamped** — the mirror adds whatever Base instructed, bounded only by Base's model. This is the check that catches the model over-stating the bucket. **Mirrors only** — see below. |

**On bucket coverage being CRITICAL only on mirrors.** On a mirror the
relation is hard: `reserveMirrorCommit` raises the reservation, `consume`
and `releaseCommitment` lower it, nothing else touches either side. On the
**canonical** chain there is a legitimate path to a shortfall, so it is
reported as advisory there instead. Releasing a verifiably-dead
remittance (`releaseRemitReservation` → `LibVpfiRecycle.restoreReleasedRemit`)
restores `outstandingCommitRecycled` in full while deliberately *not*
re-crediting `recycleBucket` — those tokens are locked in the CCIP pool,
genuinely outside Diamond custody. Paging on the contract's intended
conservative recovery state would be a false alarm on correct behaviour.
The advisory names that cause and tells the operator to reconcile against
the released reservations before treating it as a fault.

**On the bucket-coverage tolerance.** The comparison allows
`BUCKET_COVERAGE_TOLERANCE_WEI` of slack (default 1e15 = 0.001 VPFI)
rather than being exact. `LibVpfiRecycle.consume` deliberately *floors*
the bucket at zero instead of reverting, because bounded cap-trim dust can
make a day's consumption exceed its recorded commitment by wei-scale
amounts, and a payout the claim math authorised must not brick on ledger
dust. An exact comparison would therefore fire on healthy rounding. Real
shortfalls are VPFI-scale, many orders of magnitude above the tolerance.

### ADVISORY — necessary, not sufficient

These are labelled and non-paging on purpose — and *actually* non-paging:
they are delivered with Telegram notifications suppressed, so they land in
the channel without buzzing anyone. A badge in the message text while the
phone buzzes identically is how a deliberately non-sufficient signal
trains an operator to mute the channel.

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

**Both halves come from the same ledger.** When the chain is reachable,
both the outstanding reservation and the retirement are read from *its
own* books: those move the instant it settles anything, independent of
whether a report reached Base. Mixing them — Base's outstanding against
the chain's own retirement — is a guaranteed false positive, because a
mirror that retires everything between day-closes zeroes its local
reservation immediately while Base's copy stays positive until the next
report lands. Reading Base's copy for *both* would instead conflate stuck
settlement with a stalled report pipeline, which is the separate signal
below.

When the chain is **unreachable**, both figures necessarily come from
Base and therefore move only when a report lands — so that fallback is
judged on the report-cycle window rather than the short one, for exactly
the reason `report-lag` is.

**`report-lag`** — any of Base's accepted cumulatives for a chain sits
below that chain's own *and has not moved* across the window. Its window
is far larger than the stuck-settlement one (default 130 ticks ≈ 32.5h,
against 6): these cumulatives travel only in the chain's **day-close
report**, so between reports Base is legitimately behind and frozen for a
whole day, and a window shorter than one report cycle would alarm daily on
a perfectly healthy chain. The floor is one day (86400s) plus the
finalization grace (14400s) plus CCIP delivery, divided by the cron
interval — **retune it if you change the cron**. Trailing
alone is normal (reports are periodic); trailing while frozen means the
report path stalled, which is what the B2-d2 zeroed-chain manual-budget
path exists to reconcile.

All three cumulatives a day-close report carries are watched, not
absorption alone: a quiet-but-settling chain whose claims and forfeits
advance while absorption stays flat would show Base level on `reported`
and the signal would never start, even though Base is missing newer
reports and its outstanding and availability books are stale. The stasis
marker is Base's side of all three — including the chain's figures would
reset the run every time the chain settled more, masking exactly the case
this exists for.

**`watcher-state-unavailable`** is the one CRITICAL finding that is not
about the ledgers: the alert-state database could not be read. It matters
because the hard invariants are computed *before* that read and are
stateless, so a database outage must never discard a real ledger violation
whose evidence is already in hand. On that path the windowed advisories are
skipped for the tick and repeat-suppression is bypassed, so criticals go
out unsuppressed rather than being lost.

**`coverage-gap`** — a chain in `getExpectedSourceChainIds()` that this
tick could not read (no committed deployment stanza, no RPC secret, or a
failed call), **or** a misconfigured source set. Always surfaced: a
watcher that quietly narrows its scope reports "all clear" for chains it
never looked at.

Two configuration cases ride this signal. An **empty** expected set means
`CANONICAL_CHAIN_ID` points at a mirror, or the set was never configured —
either way every per-chain check below it is vacuous. And a set that does
not **contain the canonical chain itself** is reported even though the
watcher still reads Base's books: `finalizeDay` sums the global
denominators over exactly that list, so a canonical id missing from it
silently drops Base's own activity out of every day's totals.

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

**Reads are pinned to one block per chain.** Related ledger fields are
written atomically on-chain but read over several RPC calls, so an
unpinned read can straddle a funding or retirement transaction and observe
an old `consumed` beside a newly-incremented `outstanding` — paging a
`commit-identity` violation that never existed. A false CRITICAL is the
worst thing this Worker can produce, so every related read shares a block.

**`POST /run` is authenticated and fail-closed.** A `workers.dev` URL is
public and a tick is not a read-only probe: it performs the whole RPC
fan-out, advances the D1 streak counters and sends Telegram. Without auth,
anyone could drain the dedicated RPC quota, or fire enough rapid requests
while ordinary commitments were outstanding to manufacture a
`stuck-settlement` advisory that is supposed to represent an hour and a
half of cron observations — forging the very evidence the operator acts
on. An unset `WATCHER_RUN_TOKEN` therefore **closes** the endpoint rather
than opening it.

**One chain's failure does not blind the rest.** Chain reads are collected
independently, so a transient RPC error on one mirror leaves the others
evaluated and delivered, with the failed one surfaced as a coverage gap.
The endpoint's *identity* is not yet verified, though — a misconfigured
`RPC_<chainId>` pointing at the wrong network would be labelled with the
configured id. Tracked as **#1445**.

**Secrets are redacted from everything that leaves the Worker.** viem
embeds the request URL in its error messages and providers put the API key
in the path or query, so a provider having a bad minute would otherwise
publish an `RPC_<chainId>` secret straight to the ops chat. Every error
string passes through a redactor before it reaches a finding, a log or an
alert: configured secrets become named placeholders (`<RPC_42161>`), and
*any* URL — including ones this Worker never configured — keeps its scheme
and host and loses its path, query and fragment.

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

The suite is **mutation-verified**: 51 mutations applied in turn, each
confirmed to turn only the test that targets it red — the floor in the
availability model, the direction of the identity comparison, the
tolerance boundary, the bucket-coverage severity split, the streak's
marker reset, each half of the report-lag and stuck-settlement markers,
the fail-closed auth (unset token, wrong scheme, correct prefix), the
fingerprint override, and both directions of the streak prune. The shared
fixture is a *healthy* mesh whose first test asserts zero findings, so a
fixture that drifted into violating something fails loudly instead of
making every other test pass for the wrong reason.

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
   wrangler secret put WATCHER_RUN_TOKEN    # bearer token for POST /run
   wrangler secret put RPC_84532            # canonical (Base Sepolia)
   wrangler secret put RPC_421614           # each mirror, keyed by chain id
   ```

   `WATCHER_RUN_TOKEN` is **required** to use `POST /run` at all — while
   it is unset the endpoint returns 401 and only the cron can drive a
   tick. Generate one with `openssl rand -hex 32`.

3. **Set the vars** in `wrangler.jsonc`: `TG_OPS_CHAT_ID` and
   `CANONICAL_CHAIN_ID` (84532 for Base Sepolia, 8453 for Base).

4. **Deploy and verify** before trusting the cron:

   ```bash
   npm run deploy
   curl -s -X POST \
     -H "Authorization: Bearer $WATCHER_RUN_TOKEN" \
     https://vaipakam-mesh-watcher.<subdomain>.workers.dev/run | jq
   ```

   `POST /run` executes one tick synchronously and returns its summary —
   `ok`, `deliveryConfigured`, `chainsObserved`, `critical`, `advisory`,
   `coverageGaps`, `sent`.

   The manual path **reads the windowed state but never advances it** —
   those windows are denominated in cron observations, so repeated manual
   runs must not be able to manufacture a run's worth of stasis. It also
   **sends a delivery probe** — you should see a message
   in the ops chat, and `deliveryVerified: true` in the response. That is
   the point of running it: `deliveryConfigured` only says a token and
   chat id are present, which is equally true of a malformed token, and a
   healthy tick with no findings never calls Telegram at all. Without the
   probe a green verification would certify a pager that cannot deliver.

   `ok` requires all of: no critical findings, a configured destination,
   no rejected sends, a probe that succeeded, **and zero coverage gaps** —
   a watcher not observing its full mesh is not healthy, however clean the
   chains it can see happen to be. `coverageGaps > 0`
   means a chain is wired on-chain but not readable (no RPC secret, no
   deployment stanza) or the source set is misconfigured — fix it before
   relying on the alerts, or the mesh is only partly watched.

The 15-minute cron slot is the one freed by retiring
`vaipakam-lz-watcher`, whose LayerZero surface the T-068 CCIP migration
and the #687-A securities excision had between them made entirely dead.
Retiring that Worker's *source tree* is tracked separately on **#1440**.
