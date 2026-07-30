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
| `bucket-coverage` | `bucket + releasedRemitStranded ≥ outstanding`, per chain (the stranded term applies only when BOTH the mesh config and the chain itself agree it is canonical — **on a stale snapshot the chain's own same-block claim decides alone**, since pairing an old snapshot with today's topology compares two points in time and pages a former canonical chain for its healthy pre-demotion state) | Reservation on arrival is **unclamped** — the mirror adds whatever Base instructed, bounded only by Base's model. This is the check that catches the model over-stating the bucket. |
| `bucket-composition` | `creditedRaw + relocated ≤ bucket + paidOut + releasedRemitStranded` (exact) **and** the reverse, `bucket + paidOut + stranded ≤ claimed + slack` | Every recycled credit lands in the bucket exactly once, so the lifetime cumulatives can never claim more than the bucket actually received. Sees a **B2-d5 custody exclusion** regression that mislabels or double-counts an arrival, in either direction — but NOT one that never labels it at all (that moves both sides equally; #1452). See below. |
| `reported-derivation` | `reported == max(creditedRaw, bucket + paidOut − relocated)` | The published lifetime-absorption figure is re-derived here from the raw slots at the same block. Catches the exclusion being dropped from the pre-upgrade floor branch, which binds on a Diamond refreshed over live pre-#1222 state. |
| `role-consistency` | The mesh config and the chain's own `isCanonicalRewardChain` agree | The two are independently mutable and nothing on-chain reconciles them. The flag decides whether `closeDay` writes locally or reports to Base, and it authorises the canonical-only remittance surface — so a mirror carrying it is a split-brain mesh that can close its own days and release remittances while Base still expects reports from it. |

**On bucket coverage applying to every chain (#1444).** This originally
shipped CRITICAL on mirrors and advisory on Base, because the canonical
chain had a legitimate path to a shortfall: releasing a verifiably-dead
remittance (`releaseRemitReservation` → `LibVpfiRecycle.restoreReleasedRemit`)
restores `outstandingCommitRecycled` in full while deliberately *not*
re-crediting `recycleBucket` — those tokens are locked in the CCIP pool,
genuinely outside Diamond custody. Paging on the contract's intended
conservative recovery state would have been a false alarm on correct
behaviour.

Rather than keep a role exception, the contract now **records what that
path moved** (`getRecycleCompositionPosition`), so the stranded total
enters the relation as backing that exists but is in transit. One rule
now covers both roles and the exception is gone rather than documented.

Two things the allowance deliberately is **not**:

- **Not the pre-clamp commitment restored.** A liability-clamped remit
  sends only part of its recycled commitment; the residual is retired
  without moving tokens, so it never left the bucket. Counting it would
  add `recycledFull − recycledSent` of backing that does not exist, and a
  later real shortfall could hide inside that slack. The stranded figure
  restores the relation *exactly* — the release lowered the bucket by
  precisely that amount.
- **Not applied unless BOTH statements of the canonical role agree.** Only
  the canonical chain can release, but the role is a **mutable admin
  setting** and the mesh's own view of which chain is canonical is
  separately configured. Requiring both closes a demoted Diamond
  inheriting an allowance in mirror mode *and* a mis-flagged mirror
  granting itself one. Disagreement is reported as `role-consistency`.

**Two tolerance knobs, and they are deliberately separate.**
`BUCKET_COVERAGE_TOLERANCE_WEI` governs bucket coverage;
`COMPOSITION_SLACK_TOLERANCE_WEI` governs the REVERSE composition bound
only. Both are declared in `wrangler.jsonc` and default to 1e15 wei
(0.001 VPFI). They are not one setting because raising the coverage value
for a chain with noisy dust must not widen a custody-exclusion blind spot.

**On the FORWARD composition bound being exact.** The
tolerance exists for one reachable case — `consume` flooring the bucket —
and that widens the *right* side of the composition bound, so correct
accounting cannot produce any positive excess there. Sharing the knob
would accept a custody-exclusion regression up to its value, and would
widen that blind spot whenever an operator raised the tolerance for a
noisy chain's coverage, a coupling they would have no reason to expect.

**When the composition view cannot be read** (a chain missed during a
facet refresh answers the older reads and reverts this one), it is fetched
separately so its failure costs only the checks that need it. Coverage
falls back to the pre-#1444 rule: strict on a mirror, and reported as a
coverage gap on the canonical chain, where a release legitimately produces
a shortfall and the term that would explain it is exactly what is missing.

Note the on-chain **funding gate** is deliberately *not* changed to match:
`fundable = bucket − outstanding` stays conservative, which is what makes
further funding on a source wait, open, until the recovery ceremony. "Is
this a fault?" and "may this fund another day?" are different questions
and keep different answers.

**On composition and the custody exclusion (#1446).**
`reportedCumulative` is produced by the same helper that builds a mirror's
outbound day-close report. If that helper stopped netting relocated custody
out, this chain's figure and Base's accepted copy of it would inflate
*together* and stay equal — `base-ahead-of-chain` would see two matching
numbers and every other check would stay green. The composition bound does
not compare the claim against another copy of the claim; it compares it
against where the tokens went. A relocated-custody credit that also
advanced the absorption cumulative raises the left side twice against a
right side that moved once.

**The allowance is a GROSS figure, and can overstate (#1461).** Once a
released message later executes, its tokens have reached the destination —
but `onRemitAckReceived` handles an ack for an already-released reservation
by emitting `RemitAckAfterRelease` and returning, and nothing decrements the
stranded cumulative anywhere in production code. So the canonical chain keeps
counting delivered tokens as its own in-transit backing, and this allowance
can mask a real shortfall up to that amount. Nothing fund-moving reads it —
the remit gate and `_recycleFundable` both use the raw bucket — so this is a
detection-quality defect rather than a spendable one, but do not read a
passing coverage check as proof of backing after a late ack. #1461 carries
the fix (a separate recovered cumulative, so composition keeps the gross
term).

**What it does not catch, stated plainly (#1452).** An arrival routed
through the ordinary recycled credit instead of the custody-relocation
one raises `creditedRaw` and `bucket` TOGETHER. Both composition bounds
compare those two sides, so both stay satisfied, and `reported-derivation`
agrees because it reads the same slots — while the receiving chain is now
reporting Base's own already-remitted top-up as its own local absorption
and Base will re-offer it as that chain's funding. `base-ahead-of-chain`
is directionally incapable here: Base's copy ratchets toward the chain's
claim from below, so an inflated mirror figure can never make Base the one
that reads ahead.

Nothing built from the receiving chain's own counters can see this — the
counters agree with each other precisely because both moved. It needs a
record the receiving chain does not author: what Base says it remitted.
That is #1452. Until it lands, treat the custody exclusion as verified
against mislabelling and double-counting, and NOT against omission.

The `reported-derivation` check is a deliberate **second implementation**
of `LibVpfiRecycle.creditedCumulative`. That independence is the point,
but it means a legitimate change to the library's derivation must be
mirrored in `invariants.ts` in the same change, or this check will alarm
on correct behaviour.

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

## How this is built, and why

Seven review rounds during B4-c produced ~48 findings (the programme total across B4-c and its #1448 follow-up is higher — see the completion plan). Roughly four were in the ledger
checks; the rest were in operational scaffolding, and they clustered into
six root causes that kept recurring in whichever call site had not been
looked at yet. Rather than keep patching paths, each cause is closed at
its source — so the class of bug becomes hard or impossible to write
again, not merely absent today.

| Module | Closes | How |
| --- | --- | --- |
| `errors.ts` | Secrets reaching a log, alert or response body (4 findings, 4 rounds) | Third-party error text is **classified, never forwarded**. Nothing a provider says is quoted, so a new call site has no secret to leak. Redaction survives as a second layer at the output boundary, no longer load-bearing. |
| `store.ts` | Storage failures discarding computed evidence (5 findings, 4 rounds) | The D1 binding is owned here and every method **returns** a failure instead of throwing. There is nothing to catch, so nothing to forget to catch. Writes are described as data and **built inside** the guard — construction outside it was the fifth escape. |
| `signal.ts` | Windowed-signal mistakes (6 findings, 4 rounds) | One abstraction owns the rules: an observation is `holds` / `clear` / **`unknown`**, and unknown never erases a run; the marker carries the observation's source; a non-counting observation cannot advance a window. |
| `finding.ts` | Colliding dedup keys and wrong fingerprints (6 findings, 4 rounds) | Identity is **required and separate from presentation**. Callers state a `variant` and the `identity` figures; key and fingerprint are derived. The rendered `detail` never participates, so a counter or an age in the body cannot defeat repeat-suppression. |
| `health.ts` | `ok` growing a conjunct per round (4 findings) | Health is a **list of preconditions**; adding one is a list entry, not an edit to a boolean expression. The tick reports *which* precondition failed, and the HTTP status is derived rather than restated. |
| Fresh-snapshot brand | A CRITICAL firing on healthy state | A local snapshot carries a **type brand**, and the only constructor that applies it **performs the age check itself** — a caller cannot skip validation, and a cross-chain check cannot be written against an unverified snapshot. Attempting it is a compile error. |

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

**Freshness gates comparisons ACROSS chains, not within one.** Bucket
coverage compares two figures read from a single pinned block, so it stays
valid however old that block is and runs on every snapshot. Only the
cross-chain comparisons require a validated one. The canonical chain is
gated the same way: an RPC stuck on an old head answers every call
happily, and Base merely trailing the mirrors is not a hard violation, so
nothing else would have noticed the watcher reading stale Base books.

**A stale RPC head is not a ledger fault.** Load-balanced RPC fleets
routinely serve a slightly old head, and when they do, Base legitimately
holds *newer* figures than the snapshot just read — which
`base-ahead-of-chain` would otherwise report as ledger corruption. A
chain whose latest block is older than `STALE_LOCAL_SECONDS` (default
300) is therefore treated exactly like an unreadable one: surfaced as a
coverage gap naming the age, and excluded from every cross-chain
comparison for that tick. The Base-side checks still run.

**One chain's failure does not blind the rest.** Chain reads are collected
independently, so a transient RPC error on one mirror leaves the others
evaluated and delivered, with the failed one surfaced as a coverage gap.

**Each endpoint is checked to BE the chain it is configured as** (#1445).
Every tick calls `eth_chainId` per target and compares it against the id
the `RPC_<chainId>` secret is named for. Without this, a secret pointing
at the wrong network was adopted silently and every figure read through
it was *labelled* with the configured id — and the dangerous outcome is
not the noisy one. If the Diamond address happens to carry compatible
code on the wrong network, every invariant is evaluated against an
unrelated chain's ledger and the Worker reports a clean tick: confident
silence, the worst output a watcher has.

A mismatch is reported as its own `chain-mismatch` gap, deliberately not
as `no-rpc` — the endpoint is reachable, so every reachability remedy is
the wrong one, and the detail names both the configured and the observed
chain so the fix is the secret. A mismatched **mirror** is excluded from
the tick entirely, the same treatment as a stale head and for the same
reason: comparing a wrong-network ledger against Base would emit a false
CRITICAL. A mismatched **canonical** chain aborts the tick instead —
every Base-side figure comes from that client, so a wrong canonical does
not degrade the tick, it invalidates it.

The verification is issued **concurrently** with a read each path already
makes — the canonical head read, and each mirror's own ledger read — so it
costs one request but no extra round trip. That concurrency is
load-bearing rather than incidental: awaiting it first serialises a round
trip onto every mirror on every tick and lengthens the critical path by
the slowest mirror's latency. The mirror path is a `Promise.allSettled`
over both, so a ledger read that throws cannot discard the identity
verdict, and the mismatch is reported in preference to `no-rpc` — a
wrong-network endpoint *explains* a failed or nonsense read, so it is the
more useful diagnosis.

The canonical mismatch is thrown as a **pre-classified** failure, not a
bare `Error`. `runTick` passes what it catches through `classify`, which
substring-matches the message — and the mismatch detail contains the words
"WRONG NETWORK", so the `network` marker matched and the operator was told
"the endpoint could not be reached", losing both chain ids and the name of
the secret to fix. `classify` now returns a `PreclassifiedFailure`'s
carried summary verbatim, ahead of any marker matching. Fixed there rather
than by re-wording the detail: the collision is structural, so any future
safe message would hit it again and re-wording only moves the landmine.

*Coverage boundary, stated because a partial claim here is worse than
none:* the unit tests cover `verifyChainIdentity` itself — detection, the
both-ids detail, the `no-rpc` distinction, secret redaction on an
`eth_chainId` failure, that it never throws — and the classifier
pass-through end to end against the real mismatch detail, including a test
asserting that a bare `Error` carrying the same text *would* have been
mangled, so that file cannot be green by accident. They do **not** cover
the wiring in `mesh.ts` (that both call sites invoke it, that a canonical
mismatch throws, that a mismatched mirror reaches neither `allLocals` nor
`freshLocals`, that the two reads actually overlap), because `observeMesh`
builds real clients from env and this Worker has no network-level test
harness. That wiring is reviewed, not tested.

**Secrets are redacted from everything that leaves the Worker.** viem
embeds the request URL in its error messages and providers put the API key
in the path or query, so a provider having a bad minute would otherwise
publish an `RPC_<chainId>` secret straight to the ops chat. Every error
string passes through a redactor before it reaches a finding, a log or an
alert: configured secrets become named placeholders (`<RPC_42161>`), and
*any* URL — including ones this Worker never configured — keeps its scheme
and host and loses its path, query and fragment.

**Storage failures degrade; they never discard evidence.** `deliver.ts`
states the contract once, because the same defect was found in four
different call sites across review: findings are computed from chain
reads that already succeeded, so storage only decides whether to
*suppress* a repeat — "we could not check" degrades to "send it", never
to "send nothing". Dedup and recording are both best-effort; a failure of
either is announced on the same channel and fails the tick, because a
frozen streak table leaves both windowed detectors below their thresholds
indefinitely while everything else looks fine. Every send is bounded, so
one hung request cannot block the alerts behind it.

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

The suite is **mutation-verified**: 65 mutations applied in turn, each
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

### Known limitations

**Endpoint identity — RESOLVED (#1445).** Every tick now calls
`eth_chainId` per target and compares it against the id the
`RPC_<chainId>` secret is named for, so a mis-set secret can no longer be
adopted silently. See *Each endpoint is checked to BE the chain it is
configured as* under Design notes for the handling, which differs by role.

**The `mesh.ts` wiring around it is reviewed, not tested** — see the
coverage boundary in that same section. That is the Worker's remaining
untested seam.

*(Resolved since the initial version: the custody-exclusion gap that was
tracked as **#1446** is now covered by `bucket-composition` +
`reported-derivation` above, and the canonical bucket-coverage gap tracked
as **#1444** is closed by the released-remit stranded cumulative. Neither needed
the event-stream scanning originally assumed — both are computable from
the raw stored slots at a pinned block.)*

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
   set -o pipefail
   curl -sS --fail-with-body -X POST \
     -H "Authorization: Bearer $WATCHER_RUN_TOKEN" \
     https://vaipakam-mesh-watcher.<subdomain>.workers.dev/run | jq
   ```

   `--fail-with-body` plus `pipefail` is deliberate: the endpoint returns
   **503** for an unhealthy tick and 500 for an internal failure, and a
   plain `curl … | jq` exits 0 on both — so the documented verification
   would have reported success for a run whose pager probe had just
   failed.

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
