# `vaipakam-mesh-watcher`

Internal-only Cloudflare Worker that watches the **VPFI recycling mesh**
— #1222 M3 B4-c of the
[recycling completion programme](../../docs/DesignsAndPlans/VpfiRecyclingCompletionPlan.md).

Every 5 minutes it reads the canonical reward chain and ONE chain of the
mesh in rotation: Base's per-chain recycled ledger row for that chain, and
that chain's own bucket and reservation counters from its own Diamond. It
then checks the accounting relations that hold those two views together.
With three chains, each chain comes round every 15 minutes (see
*One chain per tick* below). Detection only — it moves no funds, pauses
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
| `base-ahead-of-chain` | Base's accepted cumulatives never exceed the chain's own | Base accepts clamped, lagging copies. Trailing is normal; leading is impossible without a spoofed or replayed report. The `relocated` leg (#1452) compares Base's acknowledged recycled share with the chain's relocated custody: leading there means an arrival was credited as absorption instead of relocated. This is also what makes the B2-d5 custody exclusion observable — the chain's own reported figure never includes relocated custody, so Base reading higher means it folded its own remitted top-up back in as that chain's local absorption. |
| `consumed-cap` | `consumed − released ≤ reported`, per chain (governor §7 #6) | Base can never instruct a chain to fund more than it reported absorbing, net of what it released un-spent — `_mirrorAvailable` bounds every instruction, and `MeshLedger.invariant.t.sol` asserts it on-chain. Checked **separately** rather than inferred from the availability formula, because that formula saturates: if this bound broke, `expectedAvail` would floor to zero, the on-chain `avail` would agree, and every other check would stay green while over-instruction went completely invisible. |
| `bucket-coverage` | `bucket + releasedRemitStranded ≥ outstanding`, per chain (the stranded term applies only when BOTH the mesh config and the chain itself agree it is canonical — **on a stale snapshot the chain's own same-block claim decides alone**, since pairing an old snapshot with today's topology compares two points in time and pages a former canonical chain for its healthy pre-demotion state) | Reservation on arrival is **unclamped** — the mirror adds whatever Base instructed, bounded only by Base's model. This is the check that catches the model over-stating the bucket. |
| `bucket-composition` | `credited + relocated + reattributedIn ≤ bucket + paidOut + releasedRemitStranded + repatriatedOut + reattributedOut` (exact) **and** the reverse, `destinations ≤ claimed + slack` — the two reattribution terms are a reclassification's (#1566 closure 2 cutover PR 2). Always CRITICAL: every chain is a fresh deploy, so no bucket legitimately lacks a counter behind it (#2875 retired the un-seeded advisory) | Every recycled credit lands in the bucket exactly once, so the lifetime cumulatives can never claim more than the bucket actually received. Sees a **B2-d5 custody exclusion** regression that mislabels or double-counts an arrival, in either direction — but NOT one that never labels it at all (that moves both sides equally; #1452). See below. |
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

**The allowance is NET of what resolved (#1662, #1461).** The stranded
cumulative stays GROSS (composition depends on it); the allowance subtracts
the resolved cumulative, which a recovery settlement, a recorded terminal
loss, and — since #1461 — a LATE CREDIT all feed: when a released message
executes after all and the destination CREDITS it, the destination's ack
resolves that remittance's stranded share, once (the reservation keeps its own
record, so two routes never resolve the same remittance twice; a held or
contradicted delivery resolves nothing and is left to the recovery or loss
record), and the keeper's ack pass sends that ack for any release whose
delivery has landed. A late delivery nobody
acks stays counted until someone does; nothing fund-moving reads the
allowance — the remit gate and `_recycleFundable` use the raw bucket.

**What it does not catch, stated plainly (#1452).** An arrival routed
through the ordinary recycled credit instead of the custody-relocation
one raises `credited` and `bucket` TOGETHER. Both composition bounds
compare those two sides, so both stay satisfied — while the receiving chain is now
reporting Base's own already-remitted top-up as its own local absorption
and Base will re-offer it as that chain's funding. `base-ahead-of-chain`
is directionally incapable here: Base's copy ratchets toward the chain's
claim from below, so an inflated mirror figure can never make Base the one
that reads ahead.

Nothing built from the receiving chain's own counters can see this — the
counters agree with each other precisely because both moved. It needs a
record the receiving chain does not author: what Base says it delivered.
#1452 adds it: Base records, per destination, the recycled share of every
remittance the destination acknowledged CREDITING, once each
(`getChainRemittedRecycled`; held or provisional acks book nothing, forced
finalizations apart), and `base-ahead-of-chain`'s `relocated` leg pages when
that exceeds the chain's relocated custody. The acknowledgement follows the
delivery's credit, so Base's figure trails the chain's like every other leg
of that check; leading it means an arrival was credited as absorption.

**`reported-derivation` is retired (#2875).** It re-derived the published
cumulative from a pre-upgrade floor (`max(credited, bucket + paidOut + … −
relocated − …)`) to catch the relocation subtraction being dropped from that
floor. Every chain is a fresh deploy, so the floor is gone: the published
cumulative IS the stored counter, both views read the same slot, and the
check would compare one number with itself. The relocation exclusion stays
covered by `bucket-composition`.

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
finalization grace (14400s) plus CCIP delivery, divided by the per-chain
cycle (chains in the mesh × the 5-minute step) — **retune it if you change
the cron or the number of chains**. Trailing
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

### EVENTS — sanctions-list and timelock changes (#3239 item 3, #3237)

**Off unless `EVENT_ALERTS_ENABLED` is exactly `true`.** The tick summary's
`eventAlerts.armed` says which.

Everything above is a relation between figures. These are events an
operator must hear about while there is still time to act: a sanctions
listing (it blocks the wallet's new positions and some claims and
withdrawals, and the automated adder key can apply one unattended), a
delisting proposal (it waits so the Safe can veto it), and an operation
queued in the governance timelock (the 48-hour mainnet window is the main
protection if the governance Safe is compromised).

`src/eventAlerts.ts` holds one table, `WATCHED`: per contract, the
deployment key naming its address (`sanctionsList`,
`sanctionsDelistingTimelock`, `timelock`) and per event a severity, a
title and the input shape the rule was written against.

| Contract | Pages (critical) | Silent (advisory) |
| --- | --- | --- |
| Sanctions list | `ListUpdated` (added, removed, list size, source hash, publication date, updater), `AdderSet`, `RemoverSet`, `PublicationRollbackAuthorized`, `PublicationRollbackApplied`, ownership changes | `AdderDailyAdditionCapSet`, `PublicationRollbackCleared` |
| Delisting timelock | `DelistingProposed` (accounts, eta), `ProposerSet`, `DelaySet`, `ClearanceSourceSet`, ownership changes | `DelistingReconfirmed`, `DelistingExecuted`, `DelistingCancelled`, `DelistingDiscarded`, `VetoSet` |
| Governance timelock | `CallScheduled` (target named from the deployment record, the call in plain words, value, delay, and the ready time read from `getTimestamp`), `MinDelayChange`, `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` | `CallExecuted`, `Cancelled` |

How a tick reads them:

- **Only the observed chain**, like everything else, so each chain's events
  are read once per rotation (15 minutes at three chains). One `eth_getLogs`
  per contract present on that chain, plus one finalized-block read and,
  when an operation was queued, one multicall for the ready times.
- **Up to the FINALIZED block only**, so a reorg can neither alert an event
  that did not happen nor drop one that did. The cost is the chain's
  finality delay on top of the rotation.
- **From a stored position** (`event_cursor`, migration `0002`). A
  contract read for the first time starts `EVENT_ALERT_INITIAL_LOOKBACK`
  finalized blocks back (default 20000, never before the deploy block), and
  sends one advisory naming that block: events before it are not reported.
  The start block is stored even when that advisory fails to send, so the
  retry reads from the same block and the advisory is sent again.
- **At most `EVENT_ALERT_LOG_RANGE` blocks** per contract per tick (default
  5000). A chain further behind catches up over several ticks;
  `eventAlerts.backlogBlocks` shows how far.
- **The position moves only past delivered alerts** (`deliver.ts`
  `delivered`: sent this tick, or already sent inside the repeat window).
  An alert Telegram refused is read and sent again next time. With no
  destination configured nothing advances. A manual `POST /run` never moves
  it; repeat suppression keeps its sends from going out twice.
- **A failed read is a coverage gap** (`source: event-logs`), so the tick is
  not reported healthy. An event alert itself is news, not a fault: it
  pages, but it does not fail the `ledger-clean` precondition.
- **Only through an endpoint whose chain id it confirmed this tick.** An
  endpoint that answers as another network, or whose `eth_chainId` fails,
  is not read: an empty log read through the wrong network would move this
  chain's position past events never read.
- **An alert's record is its acknowledgement.** Event alerts are sent once,
  never on the repeat timer, and their records survive the ordinary
  not-firing sweep. Each is removed only when the position has passed its
  event, so a tick whose read failed cannot make a delivered event look new.

**A queued or executed call is put into plain words** (`action:` line) by the
shared decoder in `packages/lib/src/governanceQueue.ts`, the same module the
public "queued changes" page reads. Calls are decoded against the
state-changing surface governance is expected to drive on the Diamond (cut,
roles, ownership, pause), the timelock itself, the sanctions list and the
delisting timelock (`GOVERNANCE_CALLS` in `src/eventAlerts.ts`, copied
verbatim into the ABI subset). Any other call is named by its four-byte
selector with its whole call data, never guessed. `viem` inside that module
resolves to this Worker's own copy (`paths` in `tsconfig.json`, `alias` in
`wrangler.jsonc` and `vitest.config.ts`).

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

**ABIs are compiled, not hand-typed.** The Worker reads its views through
`src/abiSubset.json`: the entries for exactly the views it calls, each copied
verbatim from the exported facet ABIs under `packages/contracts/src/abis/` by
`scripts/abi-subset.mjs`. The Solidity compiler therefore stays the single
source of truth for every decode shape (CLAUDE.md, *Worker ABI consumption*).
`ops/lz-watcher` hand-wrote its signatures with `parseAbi`, correctly — it
read the LayerZero standard surface, none of which is in the Diamond ABI.
This Worker reads only the Diamond, where that shortcut is exactly the
2026-05-05 offer-decode-drift failure mode.

Why a subset rather than the whole files: the five complete facet ABIs were
about 300 KB of a 1.1 MB bundle, nearly all error and event entries this
Worker never decodes, and every cold start on the 5-minute cron parsed them
(the bundle is now about 790 KB). A revert still reads as a revert without
the error entries: viem reports an undecodable error by its selector.

The subset is a copy, so it is checked against the compiled ABIs:
`npm run abi:check` refuses an entry that differs in any way, or a view that
is missing or overloaded in the compiled ABI. It runs before `npm run build`
and `npm run deploy` finish, and the unit tests run the same comparison plus
one that holds the subset's view list equal to the readers' list, in the CI
job every facet re-export triggers. After a re-export that touches a watched
view, run `npm run abi:write`; to watch a new view, run
`npm run abi:write -- --add <Facet>:<function>`.

A JSON import cannot be `as const`, so viem's return types degrade to
`unknown` and this module labels the tuple positions by hand. **That**
could drift, so `assertAbiShape()` runs before any read each tick and
throws unless every watched view still has the exact output arity, order,
names and types the readers assume. A facet re-export that changes a shape
fails the subset check before deploy, and `assertAbiShape()` with a precise
message if a refreshed subset no longer matches the readers, instead of
quietly mislabelling a ledger figure — and the CI job below catches both
before deploy.

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
shared `vaipakam-warm`; `TG_OPS_BOT_TOKEN`, not the user-facing
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

### One chain per tick

A tick that read the whole mesh did not fit one Workers Free invocation.
Measured on 2026-11-04 over Base Sepolia, Arbitrum Sepolia and BNB testnet,
it made more than the 50 subrequests the free plan allows, so the last
chain's reads and every Telegram send failed with "Too many subrequests".

So each tick now reads Base (head, identity, the expected source set) plus
one chain: Base's row for it, read at the same pinned Base block, and that
chain's own books. Nothing is lost by this, because every check compares
Base's row for one chain with that chain's own books, and none sums across
chains. The rotation is the canonical chain first, then
`getExpectedSourceChainIds()` in ascending order, and the slot comes from
the cron's scheduled time divided by the cron's own interval
(`src/rotation.ts`). It is never configured, so a newly wired mirror joins
the rotation without a redeploy.

The cron in `wrangler.jsonc` is the only statement of the cadence. Each
firing reads its interval from its own cron string, so there is no second
setting to keep in step with it (#3144). The rotation supports `* * * * *`
and `*/N * * * *` where N divides 60, because those are the schedules whose
firings are evenly spaced. Any other shape could observe one chain twice and
skip another, so a tick on one fails as a configuration fault and pages,
rather than observing some chains and quietly never others. A manual
`POST /run` without `?chain` picks a chain from the wall clock in 5-minute
slots; it only chooses which chain to show and never advances the windowed
state.

Two consequences to know:

- **The windows count observations of one chain.** A chain is observed
  once per rotation, which is the number of chains times
  the cron interval (3 × 5 minutes = 15 minutes today, the cadence
  the defaults were sized for). A fourth chain makes it 20 minutes and
  lengthens both windows by a third. Late is the safe direction, but
  retune them then.
- **An alert record is pruned only by a tick that observed its chain.**
  Another chain's alerts were not evaluated on this tick, so their absence
  says nothing about whether they cleared. Watcher-level findings (chain 0)
  are owned by every tick.

### One request per Diamond

A tick reads each Diamond's views in ONE `eth_call`, through Multicall3 at
its canonical address (`0xcA11bde05977b3631167028862bE2a173976CA11`,
deployed on every chain the mesh runs on), at the block the tick pinned
(`readViews` in `src/mesh.ts`). Each view still fails on its own: a view
that reverts or does not decode comes back as its own failure and costs
only the checks that need it, exactly as when each view was its own
request. Only a failure of the whole call (transport, or Multicall3 absent)
makes the chain unreadable this tick. A chain wired into the mesh without
Multicall3 therefore shows up as a coverage gap on every tick, never as a
silent pass.

Measured on 2026-11-04 against the live Base Sepolia, Arbitrum Sepolia and
BNB testnet Diamonds, one tick per observed chain:

| | requests per tick | CPU in Node (median) |
|---|---|---|
| one request per view | 17–18 (14 of them `eth_call`) | 37–51 ms |
| one request per Diamond | 6–7 (3 `eth_call`) | 14–17 ms |

The figures each version observed were identical on all three chains. The
whole mesh in one tick would now be about 15 requests, so the rotation is
no longer needed to stay under the 50-subrequest limit. It is kept anyway,
because it holds a tick's cost flat as mirrors are added.

Alerts are packed the same way (`packAlerts` in `src/deliver.ts`): one
Telegram message carries as many findings as fit under Telegram's 4,096
characters, so a burst of findings cannot use up the tick's requests.
Criticals and advisories never share a message, so a critical always
notifies and an advisory never does.

**CPU may still be over the free plan's nominal 10 ms.** The all-chain tick
used 93 ms on Cloudflare before these changes and was allowed to finish
(`outcome: ok`). The Node figures above are only a guide to the Workers
runtime, and they are still above 10 ms, so nothing here promises that
Cloudflare will keep allowing it. If ticks start ending in `exceededCpu`,
the fix is the Workers Paid plan.

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
tracked as **#1446** is now covered by `bucket-composition` above, and the canonical bucket-coverage gap tracked
as **#1444** is closed by the released-remit stranded cumulative. Neither needed
the event-stream scanning originally assumed — both are computable from
the raw stored slots at a pinned block.)*

## Deploying — operator steps

**Arming the event alerts** on an existing deployment: apply the
migrations (`npm run db:migrate`, which adds `event_cursor`), deploy, then
set `EVENT_ALERTS_ENABLED` to `true` as a plain-text var in the dashboard.
It is deliberately absent from `wrangler.jsonc`: under `keep_vars` a
declared var is overwritten on every deploy. Confirm with `POST /run` that
`eventAlerts.armed` is `true` and that each contract's first-scan notice
arrived.

First deployed 2026-11-04 against the testnet mesh (Base Sepolia canonical,
Arbitrum Sepolia and BNB testnet mirrors). These are the steps for a fresh
account or chain set.

1. **Create the database** and put its id in `wrangler.jsonc`:

   ```bash
   cd ops/mesh-watcher
   wrangler d1 create vaipakam-mesh-alerts-db
   # → copy `database_id` into the d1_databases block
   npm run db:migrate
   ```

2. **Credentials come from the account Secrets Store** `vaipakam-credentials`,
   the same copies the keeper, indexer and agent read. `wrangler.jsonc`'s
   `secrets_store_secrets` binds `TG_OPS_BOT_TOKEN` (the OPS bot, never
   `TG_BOT_TOKEN`), `TG_OPS_CHAT_ID`, and one `RPC_<chainId>` per reward chain
   to the store's slug-named secret (`RPC_84532` → `RPC_BASE_SEPOLIA`). Each
   must exist in the store before the deploy; a chain added to
   `getExpectedSourceChainIds()` needs one more binding. Create or rotate them
   with `wrangler secrets-store secret create|update`, **never**
   `wrangler secret put`: a per-Worker secret of a bound name cannot coexist
   with the binding.

   The one per-Worker secret is the bearer token for `POST /run`:

   ```bash
   openssl rand -hex 32 | wrangler secret put WATCHER_RUN_TOKEN
   ```

   While it is unset the endpoint returns 401 and only the cron can drive a
   tick.

3. **Set the vars** in `wrangler.jsonc`: `CANONICAL_CHAIN_ID` (84532 for Base
   Sepolia, 8453 for Base).

4. **Deploy and verify** before trusting the cron:

   ```bash
   npm run deploy
   set -o pipefail
   failed=0
   for chain in 84532 421614 97; do
     curl -sS --fail-with-body -X POST \
       -H "Authorization: Bearer $WATCHER_RUN_TOKEN" \
       "https://vaipakam-mesh-watcher.<subdomain>.workers.dev/run?chain=$chain" | jq \
       || { echo "chain $chain FAILED verification"; failed=1; }
   done
   [ "$failed" -eq 0 ] && echo "all chains verified"
   ```

   A loop returns the status of its LAST command only, so without the
   `failed` flag a 503 on Base followed by a clean BNB run would read as a
   pass. The final line is the verdict: it prints and succeeds only when
   every chain did.

   One request per chain, because each run observes one chain, like a cron
   tick. Without `?chain=` it observes the chain the rotation is on now.
   The response's `rotation` lists every chain in the mesh; verify each.

   `--fail-with-body` plus `pipefail` is deliberate: the endpoint returns
   **503** for an unhealthy tick and 500 for an internal failure, and a
   plain `curl … | jq` exits 0 on both — so the documented verification
   would have reported success for a run whose pager probe had just
   failed.

   `POST /run` executes one tick synchronously and returns its summary —
   `ok`, `deliveryConfigured`, `observedChainId`, `rotation`,
   `chainsObserved`, `critical`, `advisory`, `coverageGaps`, `sent`.

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
   a watcher that cannot read the chain it is on is not healthy, however
   clean the other chains happen to be. `coverageGaps > 0`
   means a chain is wired on-chain but not readable (no RPC binding, no
   deployment stanza, a store read that failed) or the source set is
   misconfigured — fix it before relying on the alerts, or the mesh is only
   partly watched.

The watcher's cron slot is the one freed by retiring
`vaipakam-lz-watcher`, whose LayerZero surface the T-068 CCIP migration
and the #687-A securities excision had between them made entirely dead.
Retiring that Worker's *source tree* is tracked separately on **#1440**.
