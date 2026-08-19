#!/usr/bin/env node
/**
 * Activity-refs coverage guardrail (#1794) — the DATA-INTEGRITY half.
 *
 * `activity_events` denormalizes two cross-domain reference columns —
 * `loan_id` and `offer_id` — so the audit feed can be filtered by loan or by
 * offer. Those columns are populated by `pluckActivityRefs()` in
 * `apps/indexer/src/chainIndexer.ts`. An event with no `case` there is stored
 * with all references NULL: the row exists, the insert succeeds, nothing
 * looks broken — and `/activity?loanId=N` plus the indexer-backed
 * `LoanTimeline` silently cannot find it. Codex found `LoanStatusChanged`
 * missing this way on #1792 — the 46th such omission.
 *
 * ENFORCEMENT IS SPLIT IN TWO (round-69 redesign), sharing ONE surface
 * derivation — `scripts/lib/activity-refs-surface.mjs`:
 *
 *   1. THIS SCRIPT (runs in `pnpm typecheck`): everything decidable from
 *      data alone. The ABI barrel resolves completely; every compiled
 *      reference-bearing event is visible; no ABI shape hides a reference
 *      from coverage; the allowlist is field-scoped, reasoned, and carries
 *      no entry for a pair the ABI no longer has.
 *
 *   2. `test/activityRefsCoverage.test.ts` + `test/activityLedger.test.ts`
 *      (run in `vitest`): everything about what the CODE actually does,
 *      answered by EXECUTING it. The real `pluckActivityRefs` runs against
 *      synthesized args for every event in the surface — a pair is mapped
 *      exactly when the executed mapper returns the planted id — and the
 *      real `recordActivityEvents` runs against a recording DB stub (one
 *      insert per log, references bound, count returned).
 *
 * WHY the split: this script previously carried ~5,000 lines of
 * TypeScript-AST inference trying to prove statically what the mapper and
 * ledger do. That cannot converge — for any finite catalogue of recognized
 * syntax shapes there is another JavaScript construct that defeats it, and
 * 40+ review rounds kept finding them one at a time (side-effectful getters,
 * aliased mutator hosts, spread laundering, constant-false loops, dynamic
 * SQL…). Executing the real code answers the same questions by observation,
 * so there is no shape catalogue left to evade. Do not re-grow AST analysis
 * here; extend the execution tests instead.
 *
 * Run: `node apps/indexer/scripts/check-activity-refs-coverage.mjs`
 *      (or `pnpm --filter @vaipakam/indexer check-activity-refs-coverage`)
 */
import {
  DELIBERATELY_NOT_SCOPED,
  REF_FIELDS,
  deriveActivityRefsSurface,
} from './lib/activity-refs-surface.mjs';

let surface;
try {
  surface = deriveActivityRefsSurface();
} catch (e) {
  console.error(`\n✖ ${e.message}\n`);
  process.exit(1);
}
const { carries, aliasNames, abiConflicts } = surface;

// ── ABI problems the derivation cannot reason around ────────────────────
// The one tolerated shape: an overload on an event that carries no reference
// (the live ABI has `StuckERC20Recovered`, an ops recovery event mapped
// nowhere). Whether an overloaded no-reference event is MAPPED is a
// behavioral question and is asserted by the execution suite; everything
// else is reported here unconditionally.
const relevantAbiConflicts = abiConflicts.filter(
  (c) => c.kind !== 'overload' || carries.has(c.event),
);

// ── Stale allowlist entries the ABI alone can prove dead ────────────────
// The third staleness kind — "allowlisted but now mapped" — needs the mapper
// to RUN and lives in test/activityRefsCoverage.test.ts.
const dead = [];
for (const key of Object.keys(DELIBERATELY_NOT_SCOPED)) {
  const [event, field] = key.split('.');
  const has = carries.get(event);
  if (!has) {
    dead.push(`${key} — no compiled event carries a loanId/offerId under this name`);
  } else if (!has.has(field)) {
    dead.push(`${key} — the event no longer carries ${field}; remove this entry`);
  }
}

if (relevantAbiConflicts.length || dead.length) {
  if (relevantAbiConflicts.length) {
    console.error('\n✖ activity-refs coverage: ABI problems this check cannot reason around:\n');
    for (const c of relevantAbiConflicts) console.error(`    ${c.message}`);
  }
  if (dead.length) {
    console.error('\n✖ activity-refs coverage: stale allowlist entries:\n');
    for (const d of dead) console.error(`    ${d}`);
  }
  console.error('');
  process.exit(1);
}

// ── Report ───────────────────────────────────────────────────────────────
// Print what the shape rules actually resolved. Derivation replaced a
// hand-written alias table precisely because a list's completeness cannot be
// verified by reading it; the derived set is only reviewable if it is
// visible, so a new reference name shows up here rather than being taken on
// trust.
for (const field of REF_FIELDS) {
  const found = new Set();
  for (const perField of aliasNames.values()) {
    for (const alias of perField.get(field) ?? []) found.add(alias.split('.').pop());
  }
  console.log(`  ${field} ← ${[...found].sort().join(', ')}`);
}
let pairs = 0;
let allowlisted = 0;
for (const [event, fields] of carries) {
  for (const field of fields) {
    pairs += 1;
    if (Object.hasOwn(DELIBERATELY_NOT_SCOPED, `${event}.${field}`)) allowlisted += 1;
  }
}
const todo = Object.values(DELIBERATELY_NOT_SCOPED).filter((r) =>
  r.startsWith('TODO(#1794)'),
).length;
console.log(
  `✓ activity-refs surface OK — ${carries.size} event(s) carry a reference across ` +
    `${pairs} event/field pair(s); ${allowlisted} allowlisted (${todo} of those are ` +
    'TODO(#1794) gaps awaiting mapping). Mapping and ledger behavior are enforced by ' +
    'execution in test/activityRefsCoverage.test.ts + test/activityLedger.test.ts.',
);
