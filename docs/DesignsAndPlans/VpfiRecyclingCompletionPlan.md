# VPFI Recycling — Completion Plan (programme of record)

| Field | Value |
| --- | --- |
| **Title** | VPFI Recycling — Completion Plan |
| **Author** | Vaipakam Developer Team |
| **Date** | 2026-07-18 |
| **Status** | **Draft — programme plan + Phase B′ implementation design** for owner review. Single document of record for *everything still required* to complete VPFI recycling, re-verified against `main` (through the RL-4 landing) and reconciled with the 2026-07-18 completeness-scout state (#1346, #1347, the #1222 parked B1–B4/C1–C2 plan + WIP branch) |
| **Cards** | Umbrella **#1349** · #1222 (Phase B′ mesh + Phase C′) · #1331 (folds into B2) · #1346 (Layer 0) · #1347 (Layer 2 — **D1 DECIDED (b)**, owner 2026-07-18; re-based to the formula doc) · #1218 (metric completion) · #1204 / #1219 (channels 3–4) · M2 card set (cut per §M2) |
| **Substrate (binding)** | [`VpfiRecyclingBalanceGovernorDesign.md`](VpfiRecyclingBalanceGovernorDesign.md) (RATIFIED governor), [`VpfiCrossChainRecyclingDesign.md`](VpfiCrossChainRecyclingDesign.md) (Option-B mesh), [`VpfiRecyclingLoopClosureDesign.md`](VpfiRecyclingLoopClosureDesign.md) (RATIFIED RL-1…6), [`VpfiAbsorptionDistributionFormulaRedesign.md`](VpfiAbsorptionDistributionFormulaRedesign.md) **pinned at rev 15 — the revision the owner's D1 decision (2026-07-18) approved** (adds ack-timed remitted accounting + reward-haircut snapshotting over the rev-8–14 freezes). A later formula-doc rev enters implementation scope ONLY after this completion plan is updated to adopt it (a conscious re-ratification step) — cards must never silently follow a mutable draft past the decided revision |

---

## 0. Purpose

Four design documents govern VPFI recycling, written at different times
against different code states, plus a completeness scout (2026-07-18) that
filed cards and parked WIP. This plan consolidates all of it into one
verified programme: what is **done** on `main`, what **remains**, in what
**order**, which older checklist items are **superseded**, and the one
genuine **design divergence** that gated the biggest remaining block —
**resolved: D1 decided (b), owner 2026-07-18** (§M2/§7.1). It also carries the Phase B′
mesh implementation design (§M3), aligned to the #1222 parked
decomposition with two corrections.

**Definition of done** is §6: every governor-§4 absorption class live or
explicitly market-era deferred; distribution absorption-coupled on every
deployed chain; recycle-at-source with shortfall-only remittance; loop
health publicly observable; and the system **armed**, not just merged dark.

## 1. State of `main` — DONE (verified 2026-07-18)

| Piece | Landed via | Notes |
| --- | --- | --- |
| Recycle-bucket ledger, `LibVpfiRecycle.credit` chokepoint, `VpfiRecycled` day-bucketed feed, backing check, forfeited-reward re-route | #1217 PR-3a (#1312) | `RecycleSource` enum reserves the currently-designed classes (notification, tariff, LIF/yield/matcher, bond slash, forfeit/expiry); only `ForfeitedReward` + `ExpiredReward` have credit sites today. **Not yet reserved: a spend-gated-perk class — the #1204 build appends `SpendGatedPerk` (enum is append-only, stable ABI) rather than misclassifying perk absorption under another source** |
| Governor: absorption-coupled day-pool stamps, commitment accounting, margin knob, `armedFromDay` arming | #1217 PR-3b (#1313) | Ships **unarmed** — schedule-only until the ceremony (§M7) |
| Dual fresh/recycled accumulators, consume-at-claim, pool-composition + arming broadcast (8-word payload) | #1217 PR-3c (#1315) | Composition crosses the mesh already; custody stays Base-side |
| RL-1 claim-to-vault delivery (Diamond-funded credit primitive, `deliverTo`, wrapper carve-outs, broadcast-safe rollup) | #1301 (#1302) | |
| RL-2 retention ledger + `VaultVpfiDebited` + indexer `rewardLoopLedger` | #1303 (#1310) | Dashboard *surface* still pending (§M5) |
| RL-3 claim-horizon sweep (per-entry, grandfathered, split signals) | #1305 (#1317) | **Dark** until the horizon knob is set; mirror routing gap = #1331 |
| RL-4 allocation register (claims-first structural, forward reserve, dormant `[keeper 0, reserve 10000]`) | #1306 (#1344) | Base-only by design |
| RL-6 legal evidence pack + copy-rules release gate | #1304 (#1308) | |
| Read views (`getRecycleBucket`, `getRecycledCreditedByDay`, `getRecycleConfig`, `getRecycleRegisterState`) + EIP-170 lens refactor | #1344 / #1333 | |

**Verified NOT done (as of 2026-07-18 — see §1a for the current state):**
notification-fee custody re-route + flat tariff — #1346; the Layer-2
tariff charger — #1347; the #1294 D1/HoldOnly/settlement-sweep stack;
all Phase B′ mesh fields; Phase C′; the arming ceremonies.

## 1a. Status refresh — verified against `main` 2026-07-27 (through #1435)

The 2026-07-18 baseline above is retained for the record; this section is
the current state. Everything below merged **dark/dormant** — the M7
ceremonies remain the only activation path — **with TWO exceptions
that are LIVE now**:

1. **The M1 notification tariff.** `LibNotificationFee.bill` has no M7
   gate: on any deployment where notification billing runs, the flat
   tariff already moves into Diamond custody and credits the bucket
   (`credit(NotificationFee, …)`) — operators account for those
   credits now, not after the ceremonies.
2. **The #1352 fee changes.** The 0.2% LIF / 2% yield-fee freeze is a
   **compiled constant** (`LOAN_INITIATION_FEE_BPS = 20`) charged at
   accept, and the borrower HoldOnly direct lending-asset fee
   reduction likewise runs at origination — neither waits for
   `feeEntitlementEnabled` or a ceremony. Current borrower charges and
   treasury fee behaviour already reflect them. "Dark" properly covers
   the Full channel, the loan-side reward cap, and their gated
   settlement behaviour.

**Now DONE (all Codex-reviewed, all `Closes` their cards):**

| Milestone | Landed via | Notes |
| --- | --- | --- |
| **M1 complete** (#1346) | #1358 | Flat native tariff + numeraire-rotation removal + Diamond-custody re-route + `credit(NotificationFee, …)` + the #973 restamp tail |
| **M2 — all landed slices** (milestone itself stays IN PROGRESS until #1369) | #1350→#1359 (specs) · #1352→#1363 (HoldOnly + 20/200 freeze + grandfather resolver) · #1347→#1366 (Full tariff, dark) · #1353→#1371 (loan-side cap, dark) · #1354→#1381 (settlement sweep, dark) · #1355→#1412 (frontend) · #1356→#1411 (deploy asserts + facet-key drift gate) · **#1351 CLOSED** via the slice series #1397/#1399/#1407–#1410 (D1 ShareOfPool claim SM: storage+knob+stamp, `processUserSideDay`, pricing core, chunked claim, preview-parity) with its remit-side prerequisite delivered by B2-d2 | Settlement-sweep long tail closed by follow-up cards #1383 (PR-B2/B3 repay/preclose/swap families), #1384 (extension repricing), #1391 (offset close-out), #1392 (sold-position discount continuity). **One deferred origination-auth slice remains — #1369** (see the remaining map): signed-offer makers cannot authorize Full, and matched fills ignore the lender offer's `creatorFull` — so the M2 milestone must NOT be checked off on the umbrella tracker until #1369 lands; only the listed slices are done |
| **M3 B1 + B2-a…d2** (#1222, in progress) | B1 #1413 · B2-a #1414 (two-pass per-chain funding) · B2-b #1417 (per-destination BROADCAST_V2 — the D1+mesh **union** landed as one 15-word kind-5 evolution, per the wire rule) · B2-c #1422 (Base-side commitment-gate plumbing) · B2-d1 #1425 (per-entry mirror→Base commitment report, kind-6) · B2-d2 #1426 (delivered-backing remit ledger `(remitter, remitId)` + kind-7 ack + Σcommitments remit gate/clamp + operator valves + zeroed-chain manual-budget path) | Keeper passes shipped with d1/d2; **operator prerequisite: D1 migrations `0043_keeper_commitment_scan.sql` + `0044_keeper_remit_ack.sql` before arming** |

**Implementation supersessions of this plan's §M3 text (recorded; the
merged PRs' design records are authoritative):**

1. **B1 consistency clamp** landed as the **AGGREGATE form** — the
   baseline advances only by accepted credit, order-independent,
   `Σattributed ≤ reported` — superseding this plan's
   per-chain-monotonic-cursor / lower-day-snapshot options (Codex r2 on
   #1413 showed the per-report-delta clamp corrupts quiet-day late
   closes).
2. **Gate retiming (§2b of the B2-d design record) — RATIFIED (owner,
   2026-07-27):** finalize-readiness does NOT wait for commitment
   reports (causally circular — the report prices from finalize's own
   outputs); the "never from a partial set / delays never zeroes" rule
   binds at the **remit gate** instead — tokens never leave Base for a
   mirror until that mirror's report is complete — and
   `remitIneligible` marks a silent chain ZEROED out of that day's
   shipment until operator reconciliation. Load-bearing in #1425 +
   #1426. This supersedes this plan's earlier "chunk completeness wired
   into day-finalization readiness" rule (the §M3 text carries the
   in-place supersession note).

**Still REMAINING for complete VPFI recycling:**

| Item | Where |
| --- | --- |
| ~~**M3 B2-d3**~~ **— DONE, merged `bf2b97cc` (#1430).** Mirror commitment-on-arrival (**not** the "consume-on-arrival" this row said while parked — arrival RESERVES the instructed amount into the mirror's `outstandingCommitRecycled`; the bucket is debited later, pro-rata, at claim/remit, per this plan's own "broadcast *commits*" rule. Debiting at arrival would charge the same tokens twice, because claims already debit as they pay — see `LibVpfiRecycle.reserveMirrorCommit`) + two-sided netting + per-chain books (`chainConsumedRecycled` / `chainOutstandingRecycledCommit` become real; `_stampOne` local-vs-top-up split; remittance netting) — makes the per-chain §7 invariants bind | #1222 |
| **M3 B2-d4** — lift the mirror `_dayPoolHalves` pricing halt (mirror claims are HALTED on armed days until this lands — per the B2-d design record `Vpfi1222B2dDeliveredBackingDesign.md`; `LibInteractionRewards` gates on it). **ATTEMPTED 2026-07-27 (PR #1433) and WITHDRAWN — the halt STAYS.** d5 discharged the precondition this row assumed, but review found the halt ALSO guards (a) the FRESH side, which has no delivered-funding bound on a mirror and truncates-terminally rather than deferring, and (b) deliberately-zeroed (`remitIneligible`) days, which would advance the cursor and retire their entries for zero — and which the manual-compensation path cannot reprice, since nothing writes the mirror's funding stamp. **Both prerequisites, and the retry of this slice, are tracked on #1434** (design record §2g) | #1222 → **#1434** |
| ~~**M3 B2-d5**~~ **— DONE, merged `64964e91` (#1432).** The `Ā`-excluded remitted-recycled custody-credit class (`RecycleSource.RemittedCustodyRelocation`) + the #1331 reclassification. The exclusion covers the REPORTED CUMULATIVE as well as the `Ā` day-bucket (the derived floor `bucket + paidOut` would otherwise re-admit it), and the remit payload carries a leading keccak version sentinel (`RemitWire.REMIT_WIRE_TAG_D5`) so an un-upgraded receiver REJECTS rather than silently truncates | #1222 |
| **M2 #1369** — deferred Full-auth origination paths: signed-offer maker Full authorization (`OfferCreateFacet`) + matched fills honoring the lender offer's `creatorFull` (`FeeEntitlementFacet`) + the frontend maker surface — without it, those parties cannot enter the Full absorption channel even after enablement | #1369 |
| ~~**M3 B3**~~ **— DONE, merged `4961e9db` (#1435).** Source-scoped netted remittance completion. d3 had shipped the SEND half (shortfall-only remittance); B3 closed the BOOK half — mirrors now report two commitment-retirement cumulatives (total retired, and the release-only subset) on the day-close, so `chainOutstandingRecycledCommit[c]` finally RETIRES (`== instructed − retired`, exact with broadcasts in flight) and a commitment released un-spent restores that chain's availability instead of being lost forever. Both figures are clamped on ingest against Base's own instruction ledger — a mirror is trusted for timing, never magnitude — which forces `avail ≤ reported` and keeps d5's exclusion intact. Report payload 6→8 words (length is a sound discriminator here: flat `uint256` tuple, no dynamic member, so no version sentinel is needed unlike d5's remit payload). Design record `Vpfi1222B3SourceScopedNettingDesign.md` | #1222 |
| **M3 B4** — 3-chain mesh e2e + invariants + watcher per-chain bucket checks + TokenomicsTechSpec §4a | #1222 |
| **M4 C1/C2** — surplus knob + batched repatriation | #1222 tail |
| **M5** — dashboard views (`selfFundingRatio`, `platformRetained`, runway, `netEmission = freshDrawdown`) + public surface | #1218 |
| **M6** — perks (#1204, `SpendGatedPerk` enum entry, legal glance first) + bonds (#1219, schedule the glance) | #1204 / #1219 |
| **M7** — ceremonies, now including the NEW operator steps the mesh added. **Chain-side ORDER is load-bearing (r4):** **(1) enable `feeEntitlementEnabled` FIRST** — while it is off, `_fullTariffShouldRun` skips plain canonical originations, so any loan accepted after an unstamped-scan but before enablement re-joins the unstamped class and the readback goes stale; enabling first means every subsequent origination stamps itself and the scan result cannot be invalidated by new loans (this reorders the §M7.4 joint gate — arming becomes the LAST step, see the in-place note there; the alternative is atomically batching enablement + scan + arming with canonical originations paused across the batch). **(2) Zero unstamped reward-eligible canonical loans.** On armed days the legacy #1008 cap retires and the loan-side cap deliberately skips an UNSTAMPED loan (`feeEntitlementByLoanId[loanId].openDays == 0` — the rev-15 unstamped-earns-normally rule), so any reward-eligible canonical loan still open and unstamped at `D*` would earn **uncapped**. Enumerate open reward-eligible canonical loans with `openDays == 0` and resolve each, reading back **zero unresolved** before arming. **There is NO backfill surface**: `_stampEntitlement` runs only at origination and no admin/migration path can stamp an existing loan — the supported resolutions are the enable-first ordering (prevents new members of the class) and **wait-for-close** (or voluntary close/re-open) for existing ones; a true backfill needs a not-yet-filed migration card with snapshot inputs + verification. (Pre-live: enabling + arming at mainnet genesis makes the set empty by construction — but the readback is still the gate, and any testnet-rehearsal or post-launch `D*` DOES have such loans.) **(3) Arm with a propagation buffer:** `setGovernorCommitArmedFromDay(D*)` **IS the D\* cutover** — one canonical-only, one-shot, future-day-only Base call; NO per-chain `D*` administration (a mirror-chain or duplicate call reverts). The setter only writes Base storage + emits `GovernorCommitArmed` — it does NOT itself send anything: a mirror learns `D*` only when the **first application of a not-yet-applied finalized day's kind-5 broadcast** lands after arming (a replay of an already-applied day exits through the idempotency branch WITHOUT installing `armedFromDay`). Because the call is **irreversible the moment it lands** while `D*` may legally be `today+1`, choose `D*` with a **multi-day buffer** (several broadcast cycles), require the per-mirror **readback of `governorCommitArmedFromDay`** to succeed on every mirror **well before `D*`**, and have the contingency written down for a mirror that misses the deadline (its claims stay halted until CCIP delivery recovery / manual re-execution — governance cannot postpone `D*`). **Keeper side:** apply D1 migrations 0043/0044; grant the keeper EOA `KEEPER_ROLE` **on EVERY mirror Diamond** (`submitCommitmentBatch` is mirror-only AND role-gated — granting on Base alone, or missing one mirror, leaves that mirror's commitment pass reverting forever, its report never completes, and the remit gate stalls that chain's funding); **fund the keeper EOA on every mirror AND on Base (canonical)** — mirrors need transaction gas for `submitCommitmentBatch` plus the quoted native CCIP fee for `sendCommitmentReport`/`sendRemitAck`, and **Base needs gas + the CCIP `msg.value` fee for every Base→mirror `remitRewardBudget` send** (`runRewardBudgetRemit` submits from the canonical chain — an unfunded Base EOA lets commitment reports complete while every reward-budget send fails and mirror claims stay unfunded); per-chain balance readback **including the canonical chain** is part of the checklist; **verify per-destination lane capacity before enabling the flags** — the keeper excludes any day whose eligible slice exceeds `REWARD_REMIT_LANE_CAP` or the CCIP token-bucket capacity (retries cannot fund it until limits are raised, and the 50,000-VPFI default capacity can be below an early high-concentration daily slice), so the **#918 largest-slice preflight is an M7 activation dependency**: read back that each destination's token-bucket capacity AND the keeper lane cap clear the maximum supported single-day slice; authorize the remit signing EOA; and arm the **master flags together** — `KEEPER_ENABLED` + `REWARD_COMMIT_ENABLED` (commitment reports) + `REWARD_REMIT_ENABLED` (delivery-ack pass) — arming the chain without all of these leaves reports/acks inert and stalls multi-chain funding | runbook |
| **M8** — fragment assembly (`1346-*`–`1356-*`, `1383a/b-*`+, and the `1222-b*` mesh family — see §M8 for the exact filename families), #882 | docs |
| ~~Owner ratification — the §2b gate retiming~~ | **DONE — RATIFIED 2026-07-27** (supersession 2 above) |

## 2. Is the cross-chain mesh (#1222) still required? — YES

Re-checked after #1299 and the A′ landings. The mesh substrate was kept
verbatim by every later design; the code state has made the need concrete:

1. **Mirror buckets accumulate with nothing consuming them.**
   `LibVpfiRecycle.credit` is chain-agnostic and the facets are identical
   everywhere, so a mirror's forfeited rewards (LIVE class) credit that
   mirror's local `recycleBucket` — but sizing, commitment reserve, and
   consume paths are all `onlyCanonical`. Mirror-absorbed VPFI is parked,
   invisible to `Ā`, funding nothing.
2. **Base over-remits while mirror buckets sit full** — #776 remittances
   don't know a mirror holds protocol-owned recycled VPFI locally;
   exactly the round-trip waste Option B exists to remove.
3. **Global `Ā` under-counts**: the coupled term sizes from Base-local
   credits only.
4. **A live, filed drift exists (#1331)**: mirror remitted-recycled
   shares hit a no-op `releaseCommitment` instead of crediting the local
   bucket — benign only *because* B′ is missing.
5. **RL-3's ratified mirror rules presuppose B′.**

Scope nuance (matches the owner's 2026-07-18 parking directive): B′ is
not needed while the reward program ships **dark / Base-only** — it is a
hard prerequisite of the **multi-chain reward rollout** being
economically correct. Parking is sequencing, not obsolescence.

## 3. The remaining programme — eight milestones

### M1 — Layer 0: notification tariff into the loop — card **#1346**

As filed (matches this plan): **M1a** flat-VPFI re-denomination (drop the
`VPFI_PER_ETH_FIXED_PHASE1` conversion — the class §14.2 forbids at
launch; default preserves today's ≈0.5 VPFI typical bill) + **M1b**
custody re-route into Diamond custody with
`credit(NotificationFee, …)`. No deps — the PR-3a chokepoint is live.
Reconcile with **#973 (L26)** in the same PR: the bill path moves vault
VPFI without the mandatory discount/tier restamp; the re-route must run
the standard tracked-balance/rollup tail. First live non-forfeit
absorption class.
> **SUPERSEDED by implementation (see §1a):** this milestone did NOT
> ship dark. `LibNotificationFee.bill` carries no M7 gate — the flat
> tariff is LIVE wherever notification billing runs, moving VPFI into
> Diamond custody and crediting the bucket now. Operators account for
> `NotificationFee` credits from deploy, not after the ceremonies.
**Numeraire-rotation
surface (in scope):** the current code treats the notification fee as a
numeraire-denominated knob — `NumeraireConfigFacet.setNumeraire` writes
`newNotificationFeeInNewNumeraire` into the same storage slot. Once the
slot is reinterpreted as a flat VPFI amount, that rotation path would
clobber it with a fiat-denominated value on the next numeraire change.
M1 therefore also removes the notification fee from the numeraire
rotation (config/event rename included) — the flat VPFI tariff has no
numeraire linkage at all.

### M2 — The absorption formula stack — card **#1347** + the M2 card set

> **D1 DECIDED: (b)** — owner, 2026-07-18. The
> `VpfiAbsorptionDistributionFormulaRedesign.md` LIF·year dual-fee
> package at rev 15 (the D1-approved revision) governs M2; option (a) is retired
> (the governor §4.2 formula gets its supersession note; the unwired
> `recycleTariffKPer1e18EthDay` knob is deleted once no caller remains).
> The divergence table is retained below for the record.

The launch-era absorption path is the tariff-priced discount entitlement
— on this everything agrees. What the tariff IS diverged between two
documents; the owner resolved it as recorded above (historical table):

| | **(a) Governor §4.2** (RATIFIED 2026-07-15; how #1347 is currently written) | **(b) #1294 rev 8–15** (merged doc, Draft status, but carrying later owner product decisions C1–C6 dated 2026-07-16) |
| --- | --- | --- |
| Formula | `k × loanVolumeETH × durationDays` (ETH·day) | `C* = baseLif_list × tYears × K` (LIF·year; K default 5e18) |
| Knob | `recycleTariffKPer1e18EthDay` (exists, unwired) | **New** `tariffKPerLifYear`; rev 14+ explicitly **forbids** wiring the ETH·day knob and retires it |
| Effect of paying | Buys that loan's LIF + yield-fee **discount entitlement** (applied at settlement) | **Dual-fee Full**: asset fees always charged; +10% own-side discount (CAP 50%); tariff absorbed at init, never a waiver/offset |
| Who pays | Party opting in | **Per-party double absorption** (each Full party pays own `C*`; both ⇒ 2×C*) |
| Coupling | Standalone charger | Drags the **loan-side reward cap** (`½×C*×(1−m_reward)` replaces #1008) + **D1 share cap** + joint `D*` cutover — `feeEntitlementEnabled=true` is forbidden until PR-5c is live |
| List fees | Unchanged (0.1% / 1%) | Frozen **0.2% LIF / 2% yield** with open-loan grandfathering |

**Recommendation: (b)** — it is the later owner decision set, it went
through five Codex design rounds, and its supersession map explicitly
retires (a)'s formula ("do not wire `setRecycleTariffKPer1e18EthDay` for
Phase-1 absorption"). But (b) is materially bigger (it re-prices list
fees and replaces the reward-cap regime), so the choice is the owner's,
made consciously — not defaulted. On (b), #1347's body is re-based to
rev 15 (the D1-approved revision) and the card set below is cut; on (a), the
formula doc's fee/tariff sections get a supersession note instead. **The
formula doc's D1 + messenger content survives either way — with one
non-negotiable coupling under (a) too:** ShareOfPool must never cut over
without a per-loan fee-linked reward cap in force. Under (b) that is
PR-5c; under (a) the equivalent cap must be defined from (a)'s own
tariff (e.g. `½ × kEthDay-tariff × (1−m_reward)` per side) **or** the
D1 ShareOfPool cutover stays blocked (keep #1008) until one exists —
choosing (a) never licenses the documented D1-only thin-book
over-reward path.

Cards to cut on (b) (titles per the #1294 PR plan; PR-3a–3c landed —
**PR-3d, the metrics slice, is NOT landed and lives on as M5/#1218** —
PR-7 = #1346):

| Card | Scope | Hard deps |
| --- | --- | --- |
| PR-1 | Spec supersession (docs; fee defaults 20/200 + grandfather resolver) | D1 decided |
| PR-2 | D1 `(user,side,day)` share cap + joint day SM + broadcast evolution — **scope includes the report/remit side even standalone**: mirror→Base per-loan headroom commitments + ack-timed `loanSideRewardRemitted` attribution (rev-15 freezes) are prerequisites for safe ShareOfPool remittance (`chainRewardBudgetForDay = min(uncappedSlice, Σ commitments)`), with or without the mesh — never broadcast-only. **Broadcast shape rule: the D1 evolution EXTENDS the live PR-3c tuple** — `scheduleFloorHalf`, `recycledHalf`, and `armedFromDay` are load-bearing live fields and must survive (cap field replaced/extended by `capMode`+`capPayload`); the formula doc's older "cap-only v2 minimum" wording is superseded — a cap-only shape would lose the pool composition + arming stamp and stall or misprice armed days on mirrors (coordinate with §M3 wire rule when same-window) | Receiver-first in BOTH directions: mirrors dual-decode the widened broadcast before Base sends it, AND **Base dual-decodes the widened report before any mirror report sender switches** (else day-close reports revert/zero) |
| PR-4 | HoldOnly hybrid borrower LIF + fee-default migration | PR-1 |
| PR-5a/5b | Per-party Full tariff (LIF·year `C*`, `maxCStar` auth, no silent downgrade) + `credit(FullTariff, …)` at init | PR-4; #1347 re-based |
| PR-5c | Loan-side reward cap + `cStar` backfill gate | PR-5b |
| — | **Joint cutover `D*`** (arm ShareOfPool only when 5c live); **Full enablement additionally requires PR-6** (settlement sites must honor the lender Full stamp before anyone pays `C*` for it) | PR-2 + PR-5c (+ PR-6 for `feeEntitlementEnabled`) |
| PR-6 | Settlement sweep honors lender hold + Full stamps | PR-4 + PR-5b |
| PR-8 | Frontend (tariff quote, incidence copy, no purchase-price language) | PR-5b ABIs |
| PR-9 | Deploy asserts (peg unset, fee 20/200, knob states) | before mainnet |

### M3 — Phase B′ mesh — card **#1222** (adopting its parked B1–B4 plan, with two corrections)

The #1222 parked decomposition (B1 ledger+report, B2 broadcast
consume/keeper + commitment-on-arrival absorbing #1331, B3 source-scoped
netted remittance, B4 e2e/invariants/watcher/specs) matches this plan and
is adopted as the implementation cut. Two corrections before B1 resumes:

1. **B1 must carry TWO report fields, not one.** The parked B1 adds only
   the cumulative `chainRecycledVpfi18` (payload 4→5). The ratified
   governor (§6, Codex r2) requires the mirror to report **both** the
   cumulative (availability accounting, self-healing) **and the
   day-bucketed credit total for the closing day** (`Ā`'s per-day
   attribution) — a cumulative delta spanning a missed day cannot be
   split between D and D+1, letting report *timing* rather than receipt
   timing shift budgets. Report payload goes 4→6 in one bump; the WIP
   branch's test updates cover both. **Rollout gate — receiver first:**
   the report flows mirror→Base and Base's messenger pins one strict
   `REPORT_PAYLOAD_SIZE`, so Base MUST ship dual-length decode (4 and 6
   words accepted, nothing else) **before** any mirror sends the 6-word
   shape — otherwise `closeDay` reports revert and the day finalizes
   with that chain zeroed. Mirror senders upgrade only after Base
   dual-decode is live (or behind a sender flag). **Consistency clamp
   (Base-side):** Base rejects or clamps any report whose for-day
   credit exceeds the increase in that chain's cumulative counter since
   the last accepted report — otherwise a mirror sender bug or stale
   replay could feed excess into `Ā` that the cumulative availability
   ledger does not back, making Base fund "absorption" that never
   happened. **Ordering precondition:** the clamp's baseline is only
   sound if reports are accepted in day order per chain — today's flow
   is merely per-day idempotent, so a delayed earlier day accepted
   after a later one would be clamped against the later (higher)
   cumulative and permanently under-credit that chain. B1 therefore
   adds a **per-chain monotonic report cursor** for the recycled
   fields (out-of-order earlier days are held/retried until in order —
   consistent with the existing cumulative self-heal), or clamps
   against the nearest lower-day accepted cumulative snapshot; the
   implementing PR picks one and tests the delayed-day case. **If the
   cursor option is chosen, it MUST advance over grace-finalized-zero
   days**: the aggregator can finalize a missing chain as zero after
   the grace window and then reject that day's late report forever — a
   cursor that simply waits would wedge behind an unacceptable day and
   hold every later report. Rule: a day finalized-zero for the chain
   advances the cursor with zero day credit, keeping the last accepted
   cumulative as baseline (the cumulative self-heal then recovers
   availability on the next accepted report); otherwise use the
   lower-day snapshot approach.
2. **Per-chain two-pass funding resolution** (governor §3.1, Codex
   r5/r6) belongs in B2/B3: global `Ā` sizes the *target*;
   `localFunded_c = min(target_c, availRecycled_c)` — **with a
   deterministic per-side allocation of the shared availability**: a
   chain's `availRecycled_c` is one bucket serving both side halves, so
   the split is computed at ONE allocation point, pro-rata to the two
   side targets (`fundedSide_c = availRecycled_c × targetSide_c /
   (targetLender_c + targetBorrower_c)` when short, rounded down),
   preserving `fundedLenderBudget_c + fundedBorrowerBudget_c ≤ local +
   top-up availability` by construction — computing the sides
   independently against the same availability would spend it twice,
   and split rules chosen per-component would drift between claim caps
   and remittance; Base tops up
   pro-rata (claims-first, keeper residual) **from its REMAINING
   availability only** — Base is itself a chain in the set, so its own
   `localFunded_Base` slice reserves first and the top-up pool is
   `BaseAvail − localFunded_Base` (funding top-ups from total Base
   availability would double-commit the same bucket whenever Base has
   local demand and mirrors have shortfalls); each chain's broadcast
   carries its own funded recycled figures — **and Base is an explicit
   "destination" for stamping purposes**: Base receives no broadcast (it
   stamps its local day record directly at finalization), so that stamp
   MUST be Base's own per-side funded equivalents, never the aggregate
   `Σ recycledBudget_c` (a Base claim against the aggregate would
   compute ≈ `p_Base × Σ funded` instead of Base's reserved slice; the
   aggregate is a metric, not a claimable figure). A chain whose slice
   is unfunded gets a smaller add-on — never a claim against tokens
   parked on another mirror. **Accumulator semantics (load-bearing, PER
   SIDE):** today's `recycledHalf` slot is consumed by the accumulator
   as a numerator over the **global** side denominators — and the
   lender and borrower sides have **separate** global denominators, so
   a chain whose lender and borrower demand weights differ cannot be
   made correct on both sides by one scaled value. The broadcast
   therefore carries **side-specific global-equivalent halves**:
   `recycledLenderHalfEquiv_c = fundedLenderBudget_c / p_c,lender` and
   `recycledBorrowerHalfEquiv_c = fundedBorrowerBudget_c /
   p_c,borrower` (each rounded down), so the existing per-side
   numerator/global-denominator math yields exactly that side's funded
   budget — with the funded budgets remaining the binding caps at
   claim/remit (scaling dust can never over-pay). Alternatives
   rejected: mirrors switching to local denominators (changes claim
   math on every chain); a single scaled value under an
   equal-side-weights invariant (the invariant does not hold in
   general). **Zero-demand guard, per side:** when a side's
   `p_c,side == 0` (no finalized demand on that side/chain for the day
   — quiet or force-finalized days, still-broadcast-configured
   destinations), never divide: send that side's equiv half as 0 /
   skip — the same zero-denominator convention the live remittance
   math already uses. The implementing PR pins the rounding.

Kept from the parked plan verbatim: commitment semantics (broadcast
*commits*; bucket debited pro-rata at claim/remit), whole-day idempotency
stamp covering every bucket-touching field, `consumed ≤ reported` per
chain, source-scoped netting with commitment-netted `availRecycled`,
per-destination values with a **replay-stable binding**: alignment to
the mutable `broadcastDestinationChainIds` list alone is NOT stable —
a message built before a list reorder/add/remove would decode against
a different ordering on delayed CCIP delivery or governance replay,
applying another chain's funded halves/consume amounts. Either one
payload per destination, or array fields that embed the destination
chain-ids (with the mirror selecting its element by `block.chainid`),
never positional alignment to the live list,
mirrors-decode-first messenger redeploy. **Backward decodability
(both message kinds, both directions):** the messenger dispatches by
`msgType` then enforces strict payload sizes — every widening therefore
ships **dual-length decode on the receiver first** (old + new sizes
accepted for that kind, nothing else), because delayed CCIP deliveries
and governance replays of pre-upgrade messages MUST keep decoding after
the upgrade: mirrors keep accepting the 8-word kind-2 broadcast
alongside the widened shape, Base keeps accepting the 4-word report
alongside the 6-word one. Only after every receiver dual-decodes do
senders switch. **Wire-format rule, stated as a
field union — never an assumed word count, applied to WHICHEVER
broadcast kind is ACTIVE when M3 lands:** if M2's D1 evolution has
already cut over, Base no longer sends legacy kind-2 for ShareOfPool
days — widening kind-2 then would bolt the recycle fields onto an
inactive shape while post-cutover mirrors receive the D1 kind without
them. M3 therefore widens the **active** kind (kind-2 only if D1 has
not landed; otherwise the D1 successor kind, or a new union kind),
keeping every superseded kind backward-decodable as legacy. **The same
active-shape rule applies to the REPORT direction:** M3 widens
whichever report shape is active when it lands, preserving all
existing fields — if PR-2 landed first, the active report already
carries per-loan headroom commitments + ack-timed remitted accounting,
and M3's recycled fields ADD to that shape (never a regression to the
old 4-word report + recycled fields that would drop the commitment
data ShareOfPool remittance depends on). Standalone
M3 adds the two new fields (`recycleConsume`, `keeperAllocate`) and
the report 4→6 — **and the broadcast build becomes
per-destination**: today's messenger builds ONE payload and loops over
`broadcastDestinationChainIds`, but under the §M3 two-pass funding
correction each chain must receive its OWN funded values —
the per-side `recycledLenderHalfEquiv_c` / `recycledBorrowerHalfEquiv_c`
pair (replacing the today-global `recycledHalf` slot),
`recycleConsume_c`, `keeperAllocate_c` — **and the FRESH component
varies per destination too**: near 69M exhaustion the governor's
ceil-dust trims bind the `scheduleFloor` slice as well, and the
governor's "trim propagates" rule requires the trimmed chain's
broadcast to carry the trimmed figures — so the fresh component is
per-destination **and PER SIDE** whenever a fresh trim binds
(`scheduleFloorLenderHalfEquiv_c` / `scheduleFloorBorrowerHalfEquiv_c`;
global value otherwise): the trims arise from per-side ceil-div sums,
so lender and borrower slices can trim against different demand
weights — one `scheduleFloorHalf_c` would reproduce for the fresh
component exactly the per-side denominator mismatch fixed above for
the recycled halves. Without this, a fresh-trimmed mirror would
accrue/remit against the untrimmed floor and overrun remaining fresh
availability. A single shared
payload would have every mirror accruing against the same halves even
when a chain's slice was trimmed. So the B2 change is per-destination
payload assembly (or explicit per-destination array fields), not merely
"+2 words". If M2's PR-2 D1 evolution lands in the same window, the
combined shape is the **union of both field sets, in BOTH directions** —
Base→mirror: D1's `capMode` + `capPayload` (replacing `capThreshold18`)
*and* the two recycle fields; **mirror→Base: the union likewise covers
the REPORT side** — the recycled cumulative + for-day fields (B1) *and*
rev-15 D1's per-loan headroom commitments, plus the ack-timed remitted
accounting on the remit path (Base must not compute
`chainRewardBudgetForDay = min(uncappedSlice, Σ commitments)` without
the commitment data, nor consume loan headroom on failed bridge
deliveries without the ack timing). **Two hardening rules on those
report/remit fields:** (1) *bounded commitments* — per-loan headroom is
dynamic data, and a busy chain's day-close CCIP report must never
become undeliverable: the report carries a **bounded** scheme
(aggregate per-side headroom + a commitment root with chunked detail,
or paginated commitment chunks), and ShareOfPool remittance for a day
is gated on **all chunks present and verified** — never computed from a
partial set (a missing chunk delays, never zeroes, that chain).
> **SUPERSEDED in part — §2b gate retiming, RATIFIED by the owner
> 2026-07-27 (see §1a supersession 2):** the original rule here wired
> chunk completeness into *day-finalization readiness*; implementation
> (#1425/#1426) proved that causally circular — the commitment report
> prices from finalize's own outputs — so the completeness gate binds
> at the **remit gate** instead: armed days remit to a destination only
> once its report is `.complete`, bounded by the reported liability,
> with `remitIneligible` zeroing a silent chain out of that day's
> shipment until the evidenced operator reconciliation (which the
> B2-d2 zeroed-chain manual-budget path serves). The
> delays-never-zeroes / never-partial-set property is preserved at the
> point where tokens actually move. (2)
*pending-remittance reservation* — ack-timed accounting alone allows
duplicate in-flight allocations (two remits before the first ack both
see the same headroom), while incrementing at send reintroduces the
failed-bridge bug: sends therefore reserve into a separate
`pendingRemitted` ledger at dispatch, finalized into
`loanSideRewardRemitted` on an **authenticated delivery ack** and
released on failure — headroom visible to later remits =
`capEff − paid − remitted − pending`. **Ack-loss recovery (must be
specified before this is implementable):** reservations are bound to
the CCIP message ID; the ack is idempotent and retryable (a
re-delivered ack finalizes the same reservation exactly once); and an
ambiguous outcome (ack delayed/lost while delivery status is unknown)
resolves through a bounded reconciliation path — after a timeout, the
operator finalizes or releases the reservation against the observed
CCIP delivery status (manual, evidenced, Base-ledgered) — so one lost
ack can never permanently suppress remits for a loan/side, and a blind
release can never double-allocate. **Storage width note (every
equivalent-half field):** the global-equivalent numerators scale funded
budgets by `1 / p_c,side`, so a thin chain with a tiny nonzero side
weight legitimately produces values orders of magnitude above the
actual daily pool — the live mirror day-pool stamp's `uint128` casts
are NOT a safe container. Implementing PRs use widened storage/wire
fields (uint256) or an explicitly bounded numerator scheme; a
skewed-demand broadcast must never revert or truncate. One evolution
per direction, one
receiver-dual-decode gate each, with the implementing PR pinning the
exact layouts. Naming a fixed word count
across both upgrades is exactly how a decoder silently drops `capMode`
or a recycle field; the layout is derived from the union at
implementation time. #1331 is absorbed by B2
(remit-ingress labeling + remitted-recycled = local credit vs
locally-committed = pure release, across claim/forfeit/expiry paths).
**`Ā`-feed exclusion for remitted-recycled (consciously supersedes the
governor §4 Codex-r7 "reported like any other receipt" wording):** the
remitted-recycled share of a mirror forfeit/expiry credits the mirror
bucket for **availability/custody labeling only** (bucket balance +
reported cumulative, so netting works and no balance goes unlabelled) —
it is **excluded from the day-bucketed `credited[d]` feed**, because
those tokens were already `Ā`-counted once when first absorbed on Base:
re-crediting them would let one protocol receipt cycle
bucket → budget → expiry → bucket and manufacture repeat reward budget
(geometrically decaying via the margin, but with no new user activity
behind it). A distinct custody-relocation credit class carries this
(e.g. a non-`Ā` flag on `VpfiRecycled` or a sibling event). Fresh-funded
forfeit/expiry shares still credit `Ā` — those tokens enter the
recycled economy for the first time. Phase C′ (C1 surplus knob, C2 batched repatriation,
Base-ledgered before the send) stays sequenced last, unchanged.

Invariants/tests: the B4 list, plus the governor §7 commitment
invariants per chain and the no-double-count rule across
fresh / remitted-recycled / locally-committed shares.

### M4 — Phase C′ surplus tooling — #1222 tail (C1 + C2, unchanged)

### M5 — #1218 transparency dashboard completion

RL-2 landed the ledger + events + indexer ingestion; remaining: the
derived views — `selfFundingRatio`, commitment-netted `platformRetained`,
`runwayExtensionDays` (`∞ / self-funded` terminal form), and the
net-emission series, which under the governor is **`freshDrawdown[D]`**
(the scheduleFloor actually drawn fresh), not the superseded
`freshMint − recycled` formula — plus the public dashboard surface under
RL-6's copy gate (supply/flow transparency only). Meaningful once
#1346/#1347 give absorption a live feed; global figures sum per-chain
day-bucketed credits after M3.

### M6 — Absorption channels 3–4 (RL-5's four-channel posture)

**E-2 spend-gated perks (#1204)** — the two spend-gated perks charge
VPFI → `credit(…)`; ratified (RL-5) to ride M2's release train. **Gate:
the #1204 design's own status is `legal glance → per-perk build` — the
glance precedes the build here exactly as for bonds**, and §6 counts
perks complete only in a decided state (glance passed + built, or an
explicit owner deferral recorded on #1204).
**#1219 service bonds** — schedule the legal glance now (the bounded
review slot the excision doc recommends); slash path →
`credit(ServiceBondSlash, …)` on build.

### M7 — Activation ceremonies (runbook, not code — nothing is real until this)

GovernanceRunbook gains a recycling section, executed in order:

1. **Arm the governor** (`armedFromDay`) once M1b gives absorption a
   live feed — **AND only while reward claims are Base-only / dark on
   mirrors, or M3 (Phase B′) is complete.** Arming with active mirror
   claims and no mesh produces exactly the §2 failure set (mirror
   buckets invisible to global `Ā`, Base over-remitting, the #1331-class
   drift becoming economically real). The runbook entry carries this
   gate as a precondition checklist item, not prose.
2. **RL-3 horizon knob** — only after BOTH ratified RL-3 UX safeguards
   are verified live: the free-channel pre-expiry notice (in-app
   notification center) **and the claim-center countdown surface**
   (users must see when claimable rewards become terminally sweepable —
   notice alone does not satisfy the ratified safeguard), **AND under
   the same mesh gate as arming: rewards Base-only/dark on mirrors OR
   M3 complete** (mirror expiry credits land in local buckets that Base
   can neither count in `Ā` nor consume until B′ — activating the
   horizon on live mirror reward chains without the mesh reproduces
   the arming failure mode). The ≥90-day grandfather window starts at
   activation.
3. **RL-4 weights** — stay `[keeper 0, reserve 10000]` absent a keeper
   funding need.
4. **`feeEntitlementEnabled`** — only at the M2 joint-cutover gate,
   **which includes PR-6 (#1354) as a hard dependency**: with Full
   enabled before the settlement sweep lands, a lender could pay `C*`
   at origination while every yield-fee site still ignores the lender
   Full stamp — collecting the tariff without delivering the purchased
   +10% discount. Gate = PR-2 + PR-5c live + PR-6 live + `D*` armed
   (asserted by PR-9/#1356).
   > **ORDERING SUPERSEDED (r4, see the §1a M7 row):** with PR-6
   > (#1354/#1381) landed, the protective intent of "`D*` armed" as an
   > enablement precondition is met differently — the ceremony now runs
   > **enable `feeEntitlementEnabled` → unstamped-scan/readback → arm
   > `D*` LAST** (with a multi-day propagation buffer). Enabling before
   > arming is safe (pre-`D*` days keep the legacy #1008 cap) and
   > closes the scan-staleness window: while enablement is off, plain
   > canonical originations skip stamping, so a loan accepted between
   > the scan and enablement would reach `D*` unstamped and uncapped.
   > **SUPERSEDED by implementation (see §1a):** the original
   > "configure the same `shareOfPoolCutoverDay` on every reward chain
   > before Base arms" step no longer exists as per-chain
   > administration — `RewardAggregatorFacet.setGovernorCommitArmedFromDay(D*)`
   > IS the cutover: one canonical-only, one-shot, future-day-only Base
   > call (a mirror-chain or duplicate call reverts). The setter itself
   > only writes Base storage and emits `GovernorCommitArmed` — it does
   > NOT invoke the messenger. `D*` reaches a mirror in-band with the
   > **first application of a not-yet-applied finalized day's kind-5
   > broadcast** after arming; a replay of an already-applied day exits
   > through the idempotency branch without installing `armedFromDay`.
   > The all-chains-consistent property this paragraph wanted is
   > delivered by that propagation, gated by a per-mirror **readback of
   > `governorCommitArmedFromDay`** once the next new-day broadcast has
   > applied — the checklist item is that readback, not "configure each
   > chain" and not the setter call alone. **Mesh/dark precondition
   (same as governor arming and RL-3):** Full enablement on
   reward-active mirrors before M3 would strand `FullTariff` credits
   in mirror-local buckets Base can neither count in `Ā` nor fund
   from — so `feeEntitlementEnabled` additionally requires rewards
   Base-only/dark on mirrors OR M3 complete (or Full is explicitly
   limited to Base until B′ lands).
5. Deploy asserts (M2 PR-9) wired into `predeploy-check.sh`.

### M8 — Docs housekeeping

Assemble the pending release-note fragments — the `1217-*`/`130x-*`
families AND the post-plan implementation wave (`1346-*`–`1356-*`,
`1383a-*`/`1383b-*`, `1384-*`, `1391-*`, `1392-*`, and the Phase B′
mesh family `1222-b1-*` through `1222-b2d2-*` — fragments are named by
their **card**, #1222, not by the implementing PR numbers — as present
under `docs/ReleaseNotes/unreleased/`);
TokenomicsTechSpec edits ride each implementing PR; whitepaper
reconciliation (#882) when that copy is next touched.

## 4. Dependency graph

```mermaid
flowchart LR
  D1{{"D1: tariff formulation<br/>(a) §4.2 vs (b) rev 15"}} --> M2
  M1a[#1346 M1a flat tariff] --> M1b[#1346 M1b custody re-route]
  M1b --> ARM[M7.1 arm governor]
  GATE{{"mesh/dark gate:<br/>mirrors dark OR M3 complete"}} --> ARM
  M3 -.-> GATE
  GATE --> RL3KNOB[M7.2 RL-3 horizon knob]
  subgraph M2 [M2 — absorption stack]
    PR1[PR-1 specs] --> PR4[PR-4 HoldOnly]
    PR4 --> PR5[#1347 PR-5a/5b Full tariff]
    PR5 --> PR5c[PR-5c loan-side cap]
    PR2[PR-2 D1 share cap] --> DSTAR[joint D* cutover]
    PR5c --> DSTAR
  end
  DSTAR --> FEE[M7.4 feeEntitlementEnabled]
  PR6[#1354 PR-6 settlement sweep] --> FEE
  GATE --> FEE
  PR2 -. one wire evolution .-> M3[M3 #1222 B1..B4]
  M1b -.-> M3
  M3 --> M4[M4 Phase C' C1..C2]
  M3 --> M5g[M5 global metrics]
  PR5 --> E2[M6 #1204 perks]
```

## 5. Card actions

**Umbrella: #1349** mirrors this plan's M1–M8 as a single programme
tracker (checklist per milestone, D1 gate, DoD) — the one card to read;
constituent cards below remain the working tickets.

| Card | Action |
| --- | --- |
| #1349 | Umbrella — keep in lockstep with this plan; tick milestones as constituent cards close |
| #1346 | Keep as filed = M1; add the #973 restamp note (comment posted) |
| #1347 | **D1 decided (b)** — body re-based to the formula doc at rev 15 (LIF·year, dual-fee, per-party double absorption, PR-5a/5b scope) |
| #1222 | Adopt the parked B1–B4/C1–C2 cut with §M3's two corrections (B1 two report fields; two-pass funding in B2/B3); #1331 stays absorbed by B2 |
| #1331 | **CLOSED 2026-07-18 as duplicate of #1222** — its full scope (remit-ingress labeling; remitted-recycled = local credit vs locally-committed = pure release, across claim/forfeit/expiry) is §M3's B2; the B4 tests must cover it |
| #1218 | Re-point at §M5 (net-emission = `freshDrawdown` under the governor; dashboard surface) |
| #1204 / #1219 | Keep; note the RL-5 release-train commitment; schedule the #1219 legal glance |
| New | Cut the M2 card set (per §M2 table) once D1 is decided; one M7 runbook card |
| #1217 | **CLOSED 2026-07-18 as completed** — tasks 1/4 shipped (governor stack), task 2's conversion-routing superseded (successors: #1346 Layer 0, #1347 Layer 2), task 3 continues as #1218 (§M5); fragment assembly stays tracked by M8, not by the card. #1301–#1306 closed via their PRs |

## 6. Definition of done — "VPFI recycling complete"

1. **Absorption**: notification tariff (M1) + Full tariff (M2) live and
   crediting the bucket — **including the #1369 origination-auth slice**
   (signed-offer maker Full authorization + matched fills honoring the
   lender offer's `creatorFull`): the Full channel is not complete while
   whole origination paths cannot enter it; forfeit/expiry classes live
   (already);
   **spend-gated perks (#1204) in a DECIDED state** — legal glance passed
   + built and crediting, or an explicit owner deferral recorded on
   #1204; **service bonds (#1219) in a DECIDED state** — either the
   legal glance passed and the slash path (`credit(ServiceBondSlash, …)`)
   built and live, **or** an explicit owner deferral recorded on #1219
   (the same completed-deferral treatment as the conversion classes) —
   "pending" is not a done state; conversion classes (borrower
   LIF-in-VPFI, yield-fee-in-VPFI, matcher remainders) explicitly
   **market-era deferred** behind the single §14 legal item — deferral
   is a completed state, not an omission.
2. **Distribution**: governor armed; `dailyPool = scheduleFloor +
   (1−m)×Ā` live with commitment discipline; D1 + loan-side cap cut over
   jointly; rewards delivered claim-to-vault by default.
3. **Cross-chain**: recycle-at-source + netted remittance live on every
   deployed chain (M3); surplus tooling available (M4); watcher
   invariants green.
4. **Observability**: #1218 dashboard live (loop-closure,
   self-funding, net-emission), global across chains.
5. **Governance/ops**: all M7 ceremonies executed and recorded; deploy
   asserts green; the retired ETH·day knob removed or documented dormant
   (per D1's outcome).
6. **Docs**: specs current per-PR; release notes assembled; #1217,
   #1222, #1331, #1346, #1347, #1218 closed.

## 7. Decisions asked of the owner

1. **D1 — tariff formulation** (§M2): **DECIDED (b)** — owner,
   2026-07-18: the `VpfiAbsorptionDistributionFormulaRedesign.md`
   LIF·year dual-fee package at its CURRENT revision (rev 15 at time of
   writing, whose later freezes — reward-haircut snapshotting, ack-timed
   remitted accounting — are part of the package). M2 cards scope
   against rev 15 as pinned — a later formula-doc rev enters scope only via a plan update (re-ratification); #1347 re-based;
   option (a) retired with a supersession note.
2. **CONFIRMED (owner, 2026-07-27):** this plan is the **programme of
   record** (supersedes the Phase-B checklist in #1222's body; adopts the
   parked B1–B4/C1–C2 cut with §M3's two corrections). It had been
   executed against as such since the plan merged — every M1/M2/M3 slice
   in §1a was scoped from it — so this marker records the standing
   practice rather than changing it.
3. **CONFIRMED (owner, 2026-07-27):** the **wire-evolution coordination
   rule** — one messenger widening shared between M2's D1 broadcast and
   M3's mesh fields when they land in the same window. Already applied in
   practice: B2-b (#1417) landed the D1 + mesh field sets as ONE 15-word
   kind-5 evolution rather than two, exactly per this rule.

> Every decision in this section is now settled: D1 (2026-07-18), the two
> confirmations above (2026-07-27), and the §2b gate retiming ratified
> 2026-07-27 (recorded as §1a supersession 2). No owner decision is
> outstanding against this plan.
