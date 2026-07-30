#!/usr/bin/env node
/**
 * Table-classification guardrail (#1481).
 *
 * Every D1 table any Worker WRITES must carry an explicit
 * restore-treatment classification, because the two main classes get
 * OPPOSITE restore treatment (docs/ops/OffChainRestore.md §4 vs §6):
 *
 *   born-off-chain  → archived nightly, imported from the archive on
 *                     restore. Missing from the archive = unrecoverable
 *                     (the #1480 class of bug).
 *   replay-derived  → cleared before the block-zero replay. NOT cleared
 *                     = attacker-fabricated rows survive recovery
 *                     (the #1450 r30/r31 class of bug).
 *
 * A table in the wrong bucket is a P1 either way — and the historical
 * failure mode is not misclassification but SILENCE: a new migration
 * adds a table, nothing forces a classification, and the gap surfaces
 * during an incident. This script closes the silent path: it extracts
 * every table written by `apps/{indexer,keeper,agent}/src` and FAILS
 * when one has no entry below. `decision-needed` is an acceptable
 * entry — the point is that it is explicit and lands on #1481's
 * docket, not that every decision is already made.
 *
 * It also cross-checks the `born-off-chain` class against the archive
 * Worker's own list (`ops/offchain-data-archive/src/backup.ts`), so
 * the classification and the backup cannot drift apart silently.
 *
 * Run: `node apps/indexer/scripts/check-table-classification.mjs`
 * (wired into `pnpm --filter @vaipakam/indexer typecheck`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

// ── The classification ────────────────────────────────────────────────
// One entry per written table: { class, reason }. Classes:
//   'born-off-chain'   — archived nightly; §4 import on restore.
//   'replay-derived'   — cleared in §6 before the replay (or, for
//                        producer-state, cleared WITH its projection).
//   'decision-needed'  — writers known, restore treatment NOT yet
//                        decided; tracked on #1481. Explicit on
//                        purpose: visible debt beats silent debt.
const CLASSIFICATION = {
  // born-off-chain (mirrors backup.ts ARCHIVE_TABLES_REQUIRED[_ONCE_MIGRATED])
  diag_errors: { class: 'born-off-chain', reason: 'frontend error captures' },
  diag_legal_holds: { class: 'born-off-chain', reason: 'operator legal-hold register' },
  diag_legal_hold_audit: { class: 'born-off-chain', reason: 'legal-hold audit trail' },
  user_thresholds: { class: 'born-off-chain', reason: 'user-supplied HF alert thresholds' },
  notify_state: { class: 'born-off-chain', reason: 'HF-band notification dedupe (FK child of user_thresholds)' },
  pre_grace_notify_state: {
    class: 'born-off-chain',
    reason: 'pre-grace warning dedupe (FK child of user_thresholds; archived since #1480)',
  },
  telegram_links: { class: 'born-off-chain', reason: 'user Telegram chat links' },
  support_tickets: { class: 'born-off-chain', reason: 'durable user support requests (#1040)' },

  // replay-derived (the §6 clear list)
  offers: { class: 'replay-derived', reason: 'chain projection' },
  loans: { class: 'replay-derived', reason: 'chain projection' },
  activity_events: { class: 'replay-derived', reason: 'append-only chain audit feed' },
  oracle_snapshot_state: { class: 'replay-derived', reason: 'chain-read snapshots' },
  liquidity_confidence: { class: 'replay-derived', reason: 'chain-read derivation' },
  indexer_cursor: { class: 'replay-derived', reason: 'replay watermark(s)' },
  loan_participants: { class: 'replay-derived', reason: 'append-only chain history (#1450 r31)' },
  notifications: {
    class: 'replay-derived',
    reason: 'derived inbox; cleared WITH hf_band_state; read-state is client-side (#1450 r33)',
  },
  hf_band_state: {
    class: 'replay-derived',
    reason: 'keeper band-edge producer state; cleared with notifications so band rows re-derive (#1450 r33)',
  },
  swap_to_repay_intents: { class: 'replay-derived', reason: 'chainIndexer-only writes (#1450 r32)' },

  // decision-needed — every entry here is #1481 scope. Do NOT clear
  // these in §6 and do NOT assume the archive covers them.
  signed_offers: {
    class: 'decision-needed',
    reason: 'HYBRID: user-submitted via HTTP, chain-updated by replay; NOT archived — #1481',
  },
  prepay_listings: {
    class: 'decision-needed',
    reason: 'chainIndexer-only writes BUT replay handlers invoke OpenSea publishing — side-effect question, #1481',
  },
  prepay_listing_match_breadcrumbs: {
    class: 'decision-needed',
    reason: 'written by HTTP routes too (loanRoutes.ts) — #1481',
  },
  keeper_commitment_reconciled: {
    class: 'decision-needed',
    reason: 'written by indexer AND keeper — #1481',
  },
  market_summary: { class: 'decision-needed', reason: 'derived summary, multiple derived writers — #1481' },
  protocol_config: { class: 'decision-needed', reason: 'chain-read snapshot via its own cron, not the replay — #1481' },
  webhook_deliveries: { class: 'decision-needed', reason: 'webhook dedupe state — #1481' },
  reward_loop_totals: { class: 'decision-needed', reason: 'reward ledger; day-bucketing vs replay unverified — #1481' },
  reward_loop_events: { class: 'decision-needed', reason: 'reward ledger; day-bucketing vs replay unverified — #1481' },
  reward_loop_day: { class: 'decision-needed', reason: 'reward ledger; day-bucketing vs replay unverified — #1481' },
  reward_day_user: { class: 'decision-needed', reason: 'reward ledger; day-bucketing vs replay unverified — #1481' },
  reward_retention: { class: 'decision-needed', reason: 'reward ledger; day-bucketing vs replay unverified — #1481' },
  // Found by this script's first run — missed by every manual sweep,
  // including the #1450 review's. Which is the point of the script.
  keeper_commitment_day: {
    class: 'decision-needed',
    reason: 'keeper commitment-reporting state (apps/keeper/src/db.ts); derivation unaudited — #1481',
  },
  keeper_commitment_scan: {
    class: 'decision-needed',
    reason: 'keeper commitment scan cursor; derivation unaudited — #1481',
  },
  keeper_remit_ack: {
    class: 'decision-needed',
    reason: 'keeper remit acknowledgement state; derivation unaudited — #1481',
  },
  keeper_remit_ack_frontier: {
    class: 'decision-needed',
    reason: 'keeper remit-ack frontier cursor; derivation unaudited — #1481',
  },
};

// Tables written by tooling/infra, not domain state.
const IGNORED = new Set(['d1_migrations']);

// ── Extract written tables from Worker sources ────────────────────────
// Case-SENSITIVE SQL keywords (source SQL is uppercase; prose in
// comments is not), and `UPDATE <t>` only counts when a `SET` follows —
// that is what separates `UPDATE loans ... SET` from the phrase
// "UPDATE the schedules" in a comment.
const WRITE_RES = [
  /INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO\s+([a-z][a-z0-9_]*)/g,
  /DELETE\s+FROM\s+([a-z][a-z0-9_]*)/g,
  /UPDATE\s+([a-z][a-z0-9_]*)[\s\S]{0,240}?\bSET\b/g,
];

function tsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const writers = new Map(); // table -> Set<relative file>
for (const app of ['indexer', 'keeper', 'agent']) {
  const srcDir = join(REPO_ROOT, 'apps', app, 'src');
  for (const file of tsFilesUnder(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const re of WRITE_RES) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(text)); ) {
        const table = m[1];
        if (IGNORED.has(table)) continue;
        if (!writers.has(table)) writers.set(table, new Set());
        writers.get(table).add(relative(REPO_ROOT, file));
      }
    }
  }
}

// ── Check 1: every written table is classified ────────────────────────
const unclassified = [...writers.keys()].filter((t) => !(t in CLASSIFICATION)).sort();

// ── Check 2: classification entries that nothing writes (staleness) ───
const dead = Object.keys(CLASSIFICATION).filter((t) => !writers.has(t)).sort();

// ── Check 3: born-off-chain ⊆ backup.ts's archived set ────────────────
const backupSrc = readFileSync(
  join(REPO_ROOT, 'ops', 'offchain-data-archive', 'src', 'backup.ts'),
  'utf8',
);
const unarchived = Object.entries(CLASSIFICATION)
  .filter(([t, c]) => c.class === 'born-off-chain' && !backupSrc.includes(`'${t}'`))
  .map(([t]) => t);

let failed = false;
if (unclassified.length > 0) {
  failed = true;
  console.error('✗ Written tables with NO classification entry (add one to');
  console.error('  check-table-classification.mjs — decision-needed is fine, silence is not):');
  for (const t of unclassified) {
    console.error(`    ${t}  (written by: ${[...writers.get(t)].join(', ')})`);
  }
}
if (unarchived.length > 0) {
  failed = true;
  console.error('✗ Classified born-off-chain but absent from backup.ts:');
  for (const t of unarchived) console.error(`    ${t}`);
}
if (dead.length > 0) {
  // Warn-only: a dropped table leaves a harmless entry; flag for cleanup.
  console.warn(`⚠ Classification entries no Worker writes any more: ${dead.join(', ')}`);
}

const decisions = Object.values(CLASSIFICATION).filter((c) => c.class === 'decision-needed').length;
if (!failed) {
  console.log(
    `✓ table classification: ${writers.size} written tables all classified ` +
      `(${decisions} still decision-needed — see #1481).`,
  );
}
process.exit(failed ? 1 : 0);
