#!/usr/bin/env node
/**
 * Table-classification guardrail (#1481).
 *
 * Every D1 table any Worker WRITES must carry a DECIDED restore
 * treatment, because the classes get OPPOSITE restore treatment
 * (docs/ops/OffChainRestore.md §4 vs §6):
 *
 *   born-off-chain  → archived nightly, imported from the archive on
 *                     restore. Missing from the archive = unrecoverable
 *                     (the #1480 class of bug).
 *   replay-derived  → cleared before the block-zero replay. NOT cleared
 *                     = attacker-fabricated rows survive recovery
 *                     (the #1450 r30/r31 class of bug).
 *   hybrid          → born off chain WITH columns the replay projects
 *                     (#1481): archived and imported like born-off-chain,
 *                     but through the restore converter's
 *                     RESTORE_PROJECTIONS, which hands the projected part
 *                     back to the replay instead of restoring it.
 *
 * A table in the wrong bucket is a P1 either way — and the historical
 * failure mode is not misclassification but SILENCE: a new migration
 * adds a table, nothing forces a classification, and the gap surfaces
 * during an incident. This script closes the silent path: it extracts
 * every table written by `apps/{indexer,keeper,agent}/src` and FAILS
 * when one has no entry below. There is no "undecided" entry any more:
 * #1481 decided the last of them, and a table added since must be
 * decided in the change that adds it.
 *
 * It also cross-checks the classes against everything that carries them
 * out: the archive Worker's own list (`ops/offchain-data-warm/src/
 * backup.ts`), the restore converter's allowlist and projections
 * (`ops/offchain-data-warm/scripts/restore-from-archive.mjs`) and the
 * runbook's import list and clear commands, so none of them can drift
 * from the classification silently.
 *
 * TWO DATABASES SINCE #2450. Most tables live in the shared `vaipakam-warm`;
 * the keeper's private operational tables live in `vaipakam-keeper-db`
 * (derived from apps/keeper/migrations via `lib/d1-workers.mjs`). Restore
 * treatment does not change with the move, but WHERE it is carried out does:
 * a replay-derived private table must be cleared by the runbook's command
 * against ITS database — a `DELETE` aimed at the shared one would leave the
 * live rows standing (the shared copies were dropped by 0064, #2560) — and a
 * private table cannot be born-off-chain, because the nightly archive binds
 * only the shared database and could never have carried it.
 *
 * SCOPE CONTRACT — a tripwire against honest drift, not a hostile-code
 * analyzer. The extraction models the conventions this repo actually
 * uses (SQL in string literals, the runbook's fence shapes, the
 * backup's spread-consumption loop) faithfully enough that an ordinary
 * edit which changes restore semantics goes RED, and a shape this
 * script cannot see goes red too (loud helper throws), never silently
 * green-while-wrong where the shape is recognisably absent. It does
 * NOT claim to detect adversarially obfuscated writes — dynamic SQL
 * assembly, computed table names, eval — because code like that in a
 * PR is a failure of code review, not of this tripwire. Extend the
 * extraction when the repo's legitimate conventions grow; do not
 * extend it to chase obfuscation.
 *
 * Run: `node apps/indexer/scripts/check-table-classification.mjs`
 * (wired into `pnpm --filter @vaipakam/indexer typecheck`).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { PRIVATE_DATABASES, privateTables } from './lib/d1-workers.mjs';
import {
  BORN_OFF_CHAIN_TABLES as CONVERTER_IMPORTS,
  RESTORE_PROJECTIONS,
} from '../../../ops/offchain-data-warm/scripts/restore-from-archive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The shared database every table lives in unless a private schema owns it. */
const SHARED_DATABASE = 'vaipakam-warm';

// ── The classification ────────────────────────────────────────────────
// One entry per written table: { class, reason }. Classes:
//   'born-off-chain'   — archived nightly; §4 import on restore.
//   'replay-derived'   — cleared in §6 before the replay (or, for
//                        producer-state, cleared WITH its projection).
//   'hybrid'           — archived nightly; §4 import through the
//                        converter's RESTORE_PROJECTIONS, the projected
//                        part re-derived by the §6 replay (#1481).
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
  indexer_deployment: {
    class: 'replay-derived',
    reason:
      'the Diamond each chain\'s rows were indexed from (#1566, Codex #2545 r1); a block-zero ' +
      'replay re-adopts the bundle\'s Diamond on its first pass, so nothing is born here',
  },
  prenotify_pass: {
    class: 'replay-derived',
    reason:
      'pre-notify pass record — the pass in progress and when it began (#2230). ' +
      'Nothing is born here: a cleared row makes the lane begin a new pass, ' +
      'numbered above every mark, which re-examines rather than skips',
  },
  loan_participants: { class: 'replay-derived', reason: 'append-only chain history (#1450 r31)' },
  loan_lifecycle_state: {
    class: 'replay-derived',
    reason: 'the status each loan last announced, read off LoanInitiated / LoanStatusChanged (#2337)',
  },
  loan_lifecycle_violation: {
    class: 'replay-derived',
    reason:
      'announcements that disagreed with the status diagram (#2337); a replay from genesis sees every ' +
      'loan from initiation, so it re-records each one and checks more than the live pass could',
  },
  notifications: {
    class: 'replay-derived',
    reason: 'derived inbox; cleared WITH hf_band_state; read-state is client-side (#1450 r33)',
  },
  hf_band_state: {
    class: 'replay-derived',
    reason:
      'keeper band-edge producer state, keeper-private (vaipakam-keeper-db, #2450); ' +
      'cleared with notifications so band rows re-derive (#1450 r33)',
  },
  swap_to_repay_intents: { class: 'replay-derived', reason: 'chainIndexer-only writes (#1450 r32)' },
  loan_orphans: {
    class: 'born-off-chain',
    reason:
      'loan rows proven absent on chain, moved out of `loans` with the whole row kept (#2197); ' +
      'a block-zero replay cannot recreate them (their initiation is not in canonical history), ' +
      'so the archive is the only copy of what was withdrawn (#2636 r1)',
  },
  loan_reconcile_quarantine: {
    class: 'replay-derived',
    reason:
      'reconciliation findings about `loans` rows; the pass rebuilds them from the chain, ' +
      'and a restored entry naming a loan the replay has not recreated would withhold ' +
      "reminders for a row that no longer exists in that shape (#2212)",
  },

  // hybrid (#1481) — born off chain, with columns the replay projects.
  // Archived like born-off-chain and imported by §4, but through the
  // converter's RESTORE_PROJECTIONS, which hands the projected part back to
  // the §6 replay instead of restoring it from the archive.
  signed_offers: {
    class: 'hybrid',
    reason:
      'EIP-712 offers users POSTed (signedOfferRoutes.ts) that exist nowhere on chain until filled; ' +
      'status and filled_amount are the projection of the SignedOffer* events, each handler updating ' +
      'only an active row, so they are imported as active/0 and the replay re-derives them',
  },

  // replay-derived, settled by #1481's audit.
  prepay_listing_match_breadcrumbs: {
    class: 'replay-derived',
    reason:
      'chainIndexer-only writes from PrepayListingMatched since #2757 retired the unauthenticated ' +
      "app POST that wrote 'v1-twostep' rows; every row is the event's own record, so the replay " +
      'writes it again',
  },
  prepay_listings: {
    class: 'replay-derived',
    reason:
      'chainIndexer-only writes from the PrepayListing* events; the OpenSea republish the handlers ' +
      'trigger publishes only an order that is still the loan\'s live listing at the head (#1481), ' +
      'so a replay over cancelled or settled listings publishes nothing stale',
  },
  keeper_commitment_reconciled: {
    class: 'replay-derived',
    reason:
      'rows come from CommitmentRemitEligibilityReconciled (chainIndexer.ts); the keeper only stamps ' +
      'consumed_at, which it re-stamps after one on-chain read (or with no read, for a day its ' +
      'resolved marker already skips), so a replayed row costs a re-check, never a report',
  },
  market_summary: {
    class: 'replay-derived',
    reason:
      'an aggregate of offers + signed_offers; with indexer_cursor cleared the sweep has no watermark ' +
      'and recomputes every market from both tables on its first pass, and a row for a market with ' +
      'no source rows would otherwise never be touched again',
  },
  protocol_config: {
    class: 'replay-derived',
    reason:
      'a snapshot of live contract state; a missing row is refreshed on the next scan, and a restored ' +
      'copy would serve an old grace schedule or pause log to the reminder sweep as current',
  },
  webhook_deliveries: {
    class: 'replay-derived',
    reason:
      'exact-seen dedupe of webhook deliveries, a latency hint only (the cron converges without it); ' +
      'an empty table costs one duplicate forward, a kept row can only suppress a hint',
  },
  reward_loop_totals: {
    class: 'replay-derived',
    reason:
      'RL-2 ledger: a fold of reward events in (block, log) order, days from block timestamps; the ' +
      'activity_events backfill finds nothing on an empty replay and stamps itself done, which is ' +
      'exact for a Diamond that emitted VaultVpfiDebited from its first debit (every fresh deploy)',
  },
  // M5 (#1218 / #1349) recycling transparency series. Classified rather
  // than deferred: every column is a fold of chain logs and nothing else,
  // so a block-zero replay rebuilds both tables exactly. (The pre-cutover
  // getter backfill, `recycle_day_backfill`, was the one born-off-chain
  // recycling table; #2937 retired it — every chain is a fresh deploy with
  // no pre-cutover day to recover — so it is no longer classified.)
  recycle_chain_reported: { class: 'replay-derived', reason: 'per-source lifetime recycled cumulative folded from ChainRecycledReported; regenerated by replay' },
  recycle_prelaunch: { class: 'replay-derived', reason: 'per-chain fold of VpfiRecycledPreLaunch; regenerated by replay' },
  // NOT 'born-off-chain' even though it is the only recycle table whose
  // contents are not derived from EVENTS: it is a periodic snapshot of
  // live contract state, re-captured by the scheduled pass within one
  // round-robin cycle of an empty table. Archiving it would preserve a
  // reading that is stale by definition, and importing that on restore
  // would republish an old backing verdict as current — the exact
  // failure `snapshot-stale` exists to prevent. Clearing it is both the
  // cheaper and the SAFER treatment.
  // #2667 — not a chain projection, but the same treatment as a snapshot of
  // live state: the keeper republishes it each watcher run, and a restored
  // copy would answer for a configuration the keeper may no longer have.
  // One-time-use marks for signed alert requests (#2753), each kept only
  // until its request could no longer pass the agent's age check (about
  // eleven minutes). Nothing in it is worth restoring: an archived row has
  // long expired.
  signed_request_use: { class: 'replay-derived', reason: 'one-time-use marks for signed alert requests, each kept ~11 minutes; an archived copy is always expired' },
  push_rail_status: { class: 'replay-derived', reason: "the keeper's Push rail readiness, republished every watcher run; a restored copy would vouch for a stale configuration" },
  recycle_backing_snapshot: { class: 'replay-derived', reason: 'periodic snapshot of live contract state; re-captured by the scheduled pass, and a restored copy would republish a stale backing verdict' },
  recycle_series_state: { class: 'replay-derived', reason: 'one-time activity_events backfill marker; meaningless without the projection it guards' },
  recycle_series_events: { class: 'replay-derived', reason: 'chain-log dedup keyed (chain, block, logIndex); regenerated by replay' },
  recycle_day_pool: { class: 'replay-derived', reason: 'per-reward-day fold of GovernorDayPoolStamped / VpfiRecycled / ChainRecycledReported; no off-chain input' },
  reward_loop_events: { class: 'replay-derived', reason: 'RL-2 ledger, rebuilt by the replay with reward_loop_totals (see there)' },
  reward_loop_day: { class: 'replay-derived', reason: 'RL-2 ledger, rebuilt by the replay with reward_loop_totals (see there)' },
  reward_day_user: { class: 'replay-derived', reason: 'RL-2 ledger, rebuilt by the replay with reward_loop_totals (see there)' },
  reward_retention: { class: 'replay-derived', reason: 'RL-2 ledger, rebuilt by the replay with reward_loop_totals (see there)' },
  // Keeper state. Every table below except the lease is keeper-PRIVATE
  // (vaipakam-keeper-db, #2450), which the nightly archive does not bind, so a
  // restore into a fresh account starts each one EMPTY (OffChainRestore.md
  // §1 step 3). #1481 checked each for that: none holds anything the keeper
  // cannot re-derive from the chain or the shared database, at the stated
  // cost. They are therefore replay-derived, and §6 clears them in the
  // keeper's database too, so a recovery in place starts from the same state
  // a fresh account does instead of keeping rows nobody can vouch for (a
  // forged frontier or completion marker makes the keeper skip work). The
  // keeper is stopped through §6 (§7a re-arms it), so nothing races the
  // clear.
  keeper_commitment_day: {
    class: 'replay-derived',
    reason:
      'commitment-report completion marker; an empty table re-checks each day in range with one isCommitmentReportSent read, and a sent day is never sent again',
  },
  keeper_commitment_scan: {
    class: 'replay-derived',
    reason:
      'commitment-report scan frontier; an empty table re-reads the entry pages, which submit nothing already accumulated on chain',
  },
  keeper_remit_ack: {
    class: 'replay-derived',
    reason:
      'remit-ack attempt log; an empty table re-sends one acknowledgement per reservation still Pending on Base (a paid CCIP message, rate-limited from then on), which §1 step 3 already states',
  },
  keeper_remit_ack_frontier: {
    class: 'replay-derived',
    reason:
      'remit-ack frontier and rotating cursor; an empty table rescans from reservation 1, where a forged frontier would leave reservations below it unacknowledged',
  },
  keeper_deployment: {
    class: 'replay-derived',
    reason:
      'deployment epoch per chain (#2497 r10); an empty table adopts the indexer\'s adopted Diamond and resets nothing',
  },
  keeper_ops_alert: {
    class: 'replay-derived',
    reason:
      'ops-alert de-duplication (#2450); an empty table re-sends at most one line per live condition',
  },
  keeper_sanctions_screen: {
    class: 'replay-derived',
    reason:
      'sanctions-hold screen cursor (#2489); an empty table restarts the screen from the first loan party',
  },
  keeper_sanctions_watch: {
    class: 'replay-derived',
    reason:
      'sanctions-hold watch list (#2497 r11); an empty table re-finds each held owner on the screen\'s next cycle',
  },
  keeper_work_open: {
    class: 'replay-derived',
    reason:
      'open-work queue (#2489, #2497 r8), cleared WITH keeper_work_cursor: both empty re-discover from the active Diamond\'s deploy block and drop each finished item after one on-chain read',
  },
  keeper_work_cursor: {
    class: 'replay-derived',
    reason:
      'open-work discovery cursor (#2497 r8), cleared WITH keeper_work_open; re-queuing an item is a no-op',
  },
  keeper_horizon_entry: {
    class: 'replay-derived',
    reason:
      'claim-horizon heartbeat queue (#2517), cleared WITH keeper_horizon_cursor: both empty re-discover from entry id 1, losing only the stuck-clock and overdue history',
  },
  keeper_horizon_cursor: {
    class: 'replay-derived',
    reason:
      'claim-horizon discovery cursor (#2517), cleared WITH keeper_horizon_entry; re-queuing an entry is a no-op',
  },
  keeper_runner_lease: {
    class: 'replay-derived',
    reason:
      'one-runner keeper lease (#2503), in the SHARED database (migration 0059); it self-expires ' +
      'within 10 minutes, and §6 clears it while the keeper is stopped, so a forged lease cannot ' +
      'hold the restored keeper off',
  },
};

// Tables written by tooling/infra, not domain state.
const IGNORED = new Set(['d1_migrations']);

// ── Diamond-change keep list (#1566, Codex #2545 r1) ─────────────────
// `src/deploymentEpoch.ts` resets EVERY table carrying a `chain_id` column
// when a chain's Diamond changes, minus the user-owned tables
// `src/diamondEpochKeep.json` names. That default (reset) is the safe one —
// a stale row never survives into a fresh Diamond's restarted ids — so the
// only thing to guard is the exception: a keep entry must name a table that
// exists AND carries `chain_id`, or it is a typo that silently keeps nothing.
// Read from the migrations' CREATE TABLE blocks; a shape this parse cannot
// see fails CLOSED (an unknown keep table is an error, never a pass).
const INDEXER_DIR = join(__dirname, '..');
const EPOCH_KEEP_PATH = join(INDEXER_DIR, 'src', 'diamondEpochKeep.json');
const epochKeep = JSON.parse(readFileSync(EPOCH_KEEP_PATH, 'utf8'));
if (!epochKeep || typeof epochKeep.keep !== 'object' || epochKeep.keep === null) {
  console.error(`✗ ${relative(REPO_ROOT, EPOCH_KEEP_PATH)}: expected a { keep: { table: reason } } object`);
  process.exit(1);
}
const chainScopedFromDdl = (() => {
  const dir = join(INDEXER_DIR, 'migrations');
  const out = new Set();
  const createTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([a-z][a-z0-9_]*)["`\]]?\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8');
    for (const m of sql.matchAll(createTable)) {
      if (/(^|[\s,(])chain_id\b/i.test(m[2])) out.add(m[1]);
    }
  }
  return out;
})();
if (chainScopedFromDdl.size === 0) {
  console.error('✗ diamond-epoch keep guard scanned no CREATE TABLE with chain_id — the DDL parse is broken, not the schema');
  process.exit(1);
}
const badKeep = Object.entries(epochKeep.keep).filter(
  ([t, reason]) => !chainScopedFromDdl.has(t) || typeof reason !== 'string' || reason.trim() === '',
);
if (badKeep.length > 0) {
  console.error(
    `✗ ${relative(REPO_ROOT, EPOCH_KEEP_PATH)}: every keep entry must name an existing table with a ` +
      `chain_id column and carry a reason:\n` +
      badKeep.map(([t]) => `  - ${t}`).join('\n'),
  );
  process.exit(1);
}

// ── Extract written tables from Worker sources ────────────────────────
// SQL lives in STRING/TEMPLATE LITERALS, so extraction runs over
// string contents only — comments and identifier-position code never
// count as writers. Keywords match case-INSENSITIVELY (nothing
// enforces uppercase SQL, and `insert into t …` is exactly as much a
// write as `INSERT INTO t …` — Codex #1485 r1), and `UPDATE <t>` only
// counts when a `SET` follows, which separates `update loans … set`
// from prose like "update the schedules". A prose false-positive
// fails CLOSED (an unclassified-table error someone will question),
// never open.
// A quote-class before each identifier: SQLite accepts quoted
// identifiers (`INSERT INTO "t"`, backtick, bracket forms), and an
// unquoted-only pattern let ordinary identifier quoting bypass
// classification (Codex #1485 r3). Backtick IS a live case — it
// appears unescaped inside single/double-quoted TS strings, which
// stringLiteralContents extracts too (r3 briefly claimed otherwise;
// r4 corrected it).
const WRITE_RES = [
  /INSERT\s+(?:OR\s+[A-Za-z]+\s+)?INTO\s+["`\[]?([a-z][a-z0-9_]*)/gi,
  // Bare `REPLACE INTO` is SQLite's alias for INSERT OR REPLACE and
  // writes exactly the same way (Codex #1485 r2).
  /(?<![A-Za-z_])REPLACE\s+INTO\s+["`\[]?([a-z][a-z0-9_]*)/gi,
  /DELETE\s+FROM\s+["`\[]?([a-z][a-z0-9_]*)/gi,
  // `(?!set\b)` keeps upsert syntax (`ON CONFLICT … DO UPDATE SET`)
  // from registering a table named "set".
  /UPDATE\s+["`\[]?(?!set\b)([a-z][a-z0-9_]*)[\s\S]{0,240}?\bSET\b/gi,
];

/** One-pass TS lexer: walks the source tracking string / comment
 *  state, returning { code, strings }. Regex-order stripping is
 *  structurally wrong here — a `//` comment containing `/*` (e.g.
 *  "migrations/*.sql") opens a phantom block that swallows real
 *  declarations, and a commented-out spread must not read as code
 *  (both Codex #1485 r5). `code` is the source with comments blanked
 *  and string BODIES blanked (delimiters kept); `strings` carries
 *  every literal body with quote/backslash escapes decoded — `\"t\"`
 *  is the identifier `"t"` to SQLite. Template `${…}` interiors are
 *  treated as part of the literal, which is fine for extraction whose
 *  failure mode is a visible CI error. */
export function lexTs(source) {
  let code = '';
  let codeWithStrings = '';
  const strings = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      code += ' ';
      codeWithStrings += ' ';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      code += ' ';
      codeWithStrings += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      let body = '';
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          const esc = source[i + 1];
          body += `"'\``.includes(esc) || esc === '\\' ? esc : '\\' + esc;
          i += 2;
        } else {
          body += source[i++];
        }
      }
      i++; // closing quote
      strings.push(body);
      code += quote + quote;
      codeWithStrings += quote + body + quote;
    } else {
      code += c;
      codeWithStrings += c;
      i++;
    }
  }
  return { code, codeWithStrings, strings };
}

/** Comment-free view of a TS source (string bodies blanked too — the
 *  consumption tripwires watch CODE, and a spread inside a string or
 *  comment is not consumption). */
export function stripJsComments(source) {
  return lexTs(source).code;
}

/** Every string/template literal body in a TS source, comments
 *  excluded, escapes decoded. */
export function stringLiteralContents(source) {
  return lexTs(source).strings;
}

function tsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function runChecks() {
const writers = new Map(); // table -> Set<relative file>
for (const app of ['indexer', 'keeper', 'agent']) {
  const srcDir = join(REPO_ROOT, 'apps', app, 'src');
  for (const file of tsFilesUnder(srcDir)) {
    const literals = stringLiteralContents(readFileSync(file, 'utf8')).join('\n');
    for (const re of WRITE_RES) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(literals)); ) {
        const table = m[1].toLowerCase();
        if (IGNORED.has(table)) continue;
        if (!writers.has(table)) writers.set(table, new Set());
        writers.get(table).add(relative(REPO_ROOT, file));
      }
    }
  }
}

// ── Check 0: the classification itself is well-formed ─────────────────
// A typo'd class ('born-of-chain') must not count as classified — it
// would pass the presence check while silently escaping the archive
// cross-check (Codex #1485 r1).
const VALID_CLASSES = new Set(['born-off-chain', 'replay-derived', 'hybrid']);
/** The classes the nightly archives and §4 imports. */
const ARCHIVED_CLASSES = new Set(['born-off-chain', 'hybrid']);
const malformed = Object.entries(CLASSIFICATION)
  .filter(
    ([, c]) =>
      !VALID_CLASSES.has(c.class) || typeof c.reason !== 'string' || c.reason.trim() === '',
  )
  .map(([t, c]) => `${t} (class: ${JSON.stringify(c.class)})`);

// ── Check 1: every written table is classified ────────────────────────
// `Object.hasOwn`, never `in`: a table named `constructor` (a valid
// SQL identifier) satisfies `in` via Object.prototype and would slip
// through unclassified (Codex #1485 r2 probed exactly that).
const unclassified = [...writers.keys()]
  .filter((t) => !Object.hasOwn(CLASSIFICATION, t))
  .sort();

// ── Check 2: classification entries that nothing writes (staleness) ───
// Tables written from OUTSIDE `apps/*/src` — declared, not warned about.
//
// The `dead` check below exists to flag a classification left behind by a
// dropped table. A table whose writer is legitimately not a Worker would
// trip it forever, and a permanently-warning guard teaches people to skip
// the output — so the case is declared here with its writer and its reason.
// The requirement it must NOT weaken: silence is still disallowed, because
// an entry here is as explicit as a Worker write site.
/**
 * Is this tracker number cited anywhere in the design docs?
 *
 * Offline stand-in for "does the tracker exist": a card nobody documented
 * is a card nobody will act on, and a mistyped number fails because nothing
 * in the repo mentions it.
 */
function docsCite(num) {
  // WHOLE TOKEN, not substring (Codex #1513 r12). `.includes('#152')`
  // matches a checked-in `#1523`, so a truncated-but-numeric tracker stayed
  // exempt from the dead-entry check while nothing cited it. My r11 fix
  // replaced a shape test with a different shape test.
  // Escape for regex, then forbid a trailing digit so `#152` cannot match
  // a cited `#1523`. (The previous `replace('#','#')` was a no-op —
  // CodeQL was right to flag it as substring-replaced-with-itself.)
  const token = new RegExp(`${num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`);
  const roots = [
    join(REPO_ROOT, 'docs', 'DesignsAndPlans'),
    join(REPO_ROOT, 'docs', 'ReleaseNotes'),
  ];
  const stack = [...roots];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      // `withFileTypes` gives the kind WITHOUT a second stat call, so there
      // is no check-then-use window for the path to change underneath
      // (CodeQL file-system race on the previous statSync/readFileSync pair).
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          if (token.test(readFileSync(full, 'utf8'))) return true;
        } catch {
          /* unreadable file is not a citation */
        }
      }
    }
  }
  return false;
}

// Empty since #2937 retired `recycle_day_backfill`, whose operator pass
// (#1523) never shipped. The mechanism stays: a future table whose writer is
// legitimately not a Worker is declared here, with a script or a cited tracker.
const EXTERNAL_WRITERS = {};

const dead = Object.keys(CLASSIFICATION)
  .filter((t) => !writers.has(t) && !(t in EXTERNAL_WRITERS))
  .sort();

// An EXTERNAL_WRITERS entry must resolve to something REAL: either a script
// that exists, or an explicitly pending tracker. Anything else rots into a
// different kind of silence — a declaration nobody can act on.
const missingExternal = Object.entries(EXTERNAL_WRITERS)
  .filter(([, decl]) => {
    if (typeof decl === 'string') {
      const m = decl.match(/^(\S+\.mjs)/);
      return m ? !existsSync(join(REPO_ROOT, m[1])) : true;
    }
    if (decl && typeof decl === 'object') {
      if (decl.script) return !existsSync(join(REPO_ROOT, decl.script));
      // A pending writer must name a tracker AND a reason — and the
      // tracker must be CITED IN A CHECKED-IN DOC.
      //
      // Shape alone is not enough (Codex #1513 r11): a mistyped-but-numeric
      // `#1524` passes a format test, and because this entry is exempt from
      // the dead-entry check, CI would stay green indefinitely over a
      // reference to nothing. My earlier claim that mutating the tracker to
      // 'soon' verified this was an OVERCLAIM — it verified formatting.
      //
      // Resolving against the live tracker would put a network call in a
      // lint. Requiring the number to appear in the design docs is offline,
      // and it is the property that actually matters: a tracker nobody
      // documented is one nobody will act on. A typo fails because nothing
      // in the repo mentions it.
      const num = decl.pending ?? '';
      if (!/^#\d+$/.test(num) || (decl.why ?? '').length <= 20) return true;
      return !docsCite(num);
    }
    return true;
  })
  .map(([t]) => t);

// ── Check 3: born-off-chain ⊆ backup.ts's archived set ────────────────
// Parse the ACTUAL array literals runNightlyBackup consumes — a table
// name quoted in a comment or error message must not satisfy this
// check (Codex #1485 r1 reproduced exactly that with a quoted TODO).
// Comment-stripped ONCE, for every backup.ts check below: a
// commented-out array or spread must satisfy neither the declaration
// parse (check 3) nor the consumption tripwires (check 6) —
// probe-verified that raw-text matching accepted all three loop
// spreads commented out (Codex #1485 r5).
const backupLex = lexTs(
  readFileSync(join(REPO_ROOT, 'ops', 'offchain-data-warm', 'src', 'backup.ts'), 'utf8'),
);
// Strings KEPT for the array parse (the table names ARE string
// literals); strings BLANKED for the consumption tripwires (a spread
// quoted inside a string is prose, not consumption).
const backupSrc = backupLex.codeWithStrings;
const backupCode = backupLex.code;
const archivedSet = archivedTablesFrom(backupSrc);
const unarchived = Object.entries(CLASSIFICATION)
  .filter(([t, c]) => ARCHIVED_CLASSES.has(c.class) && !archivedSet.has(t))
  .map(([t]) => t);

// ── Check 3b: no PRIVATE table is born-off-chain (#2450) ──────────────
// The archive Worker binds only the shared database (`DB_ARCHIVE`), so a
// born-off-chain table in a private database is one the nightly can never
// export — listing it in backup.ts would only read a stale shared copy, or
// fail once that copy is dropped. Back the private database up first.
const PRIVATE = privateTables(REPO_ROOT);
const databaseOf = (t) => PRIVATE.get(t)?.name ?? SHARED_DATABASE;
const privateBorn = Object.entries(CLASSIFICATION)
  .filter(([t, c]) => ARCHIVED_CLASSES.has(c.class) && PRIVATE.has(t))
  .map(([t]) => `${t} (in ${databaseOf(t)})`);

// ── Check 4: replay-derived == the runbook's §6 clear command ─────────
// The classification's PROMISE for this class is "cleared before the
// block-zero replay", and the implementation of that promise is the
// fixed DELETE command in OffChainRestore.md §6. A replay-derived
// entry missing there lets fabricated rows survive tampering recovery;
// a cleared table not classified replay-derived means the command
// deletes something whose restore treatment says otherwise. Both
// directions fail (Codex #1485 r2).
//
// PER DATABASE (#2450). A replay-derived table is cleared by the command
// against the database it LIVES in: the shared one by default, a private one
// when a private schema creates it. Each database is bound both ways on its
// own — a table cleared in the wrong database counts as "cleared, but not
// classified replay-derived THERE" and as "not cleared" where it lives.
const runbookSrc = readFileSync(join(REPO_ROOT, 'docs', 'ops', 'OffChainRestore.md'), 'utf8');
const replaySet = new Set(
  Object.entries(CLASSIFICATION)
    .filter(([, c]) => c.class === 'replay-derived')
    .map(([t]) => t),
);
const notCleared = [];
const clearedUnclassified = [];
for (const db of [SHARED_DATABASE, ...PRIVATE_DATABASES.map((p) => p.name)]) {
  const replayHere = new Set([...replaySet].filter((t) => databaseOf(t) === db));
  // The shared clear is always required; a private one only once a
  // replay-derived table lives there (there is then something to clear).
  const clearedHere = clearedTablesFrom(runbookSrc, db, { required: db === SHARED_DATABASE || replayHere.size > 0 });
  for (const t of [...replayHere].filter((x) => !clearedHere.has(x)).sort()) {
    notCleared.push(`${t}  (lives in ${db})`);
  }
  for (const t of [...clearedHere].filter((x) => !replayHere.has(x)).sort()) {
    clearedUnclassified.push(
      `${t}  (cleared in ${db}${databaseOf(t) !== db ? `, but it lives in ${databaseOf(t)}` : ''})`,
    );
  }
}

// ── Check 5: born-off-chain == the runbook's §4 import list ───────────
// Same promise-vs-implementation binding as check 4, for the other
// class: an archived table missing from §4's list is one the operator
// never imports during recovery, so the archived user state silently
// stays absent from the restored D1 (Codex #1485 r3).
const importList = importTablesFrom(runbookSrc);
const importSet = new Set(importList);
const bornSet = new Set(
  Object.entries(CLASSIFICATION)
    .filter(([, c]) => ARCHIVED_CLASSES.has(c.class))
    .map(([t]) => t),
);
const notImported = [...bornSet].filter((t) => !importSet.has(t)).sort();
const importedUnclassified = [...importSet].filter((t) => !bornSet.has(t)).sort();
// §4's ORDER is load-bearing, not just its membership: every generated
// batch leads with a DELETE, and deleting user_thresholds cascades to
// its children — a list that names all eight tables but places a child
// before the parent has the operator restore the child and then
// silently erase it (Codex #1485 r4).
const misordered = [];
const parentIdx = importList.indexOf('user_thresholds');
for (const child of ['notify_state', 'pre_grace_notify_state']) {
  const childIdx = importList.indexOf(child);
  if (parentIdx >= 0 && childIdx >= 0 && childIdx < parentIdx) {
    misordered.push(`${child} listed before user_thresholds`);
  }
}

// ── Check 6: the backup arrays are actually CONSUMED ──────────────────
// Parsing the array literals (check 3) proves declaration, not use: a
// refactor that drops `...ARCHIVE_TABLES_REQUIRED` from the export
// loop while leaving the declaration keeps every check green while the
// nightly stops exporting the required set (Codex #1485 r4). These are
// deliberate tripwires on the consumption shape — if backup.ts's loop
// is legitimately restructured, this check fails LOUD and gets updated
// consciously, which is the correct failure mode for a drift guard.
const consumption = [
  /\.\.\.\s*ARCHIVE_TABLES_REQUIRED\s*,/,
  /\.\.\.\s*ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED\s*\.map/,
  /\.\.\.\s*ARCHIVE_TABLES_OPTIONAL\s*,/,
];
const unconsumed = consumption
  .filter((re) => !re.test(backupCode))
  .map((re) => re.source);

// ── Check 7: the restore converter carries out the classification (#1481) ─
// The converter is what §4 actually runs. Its allowlist decides which
// archived tables it will emit an import for at all (anything else is
// refused as hostile), and RESTORE_PROJECTIONS decides how a hybrid table's
// rows are imported. A hybrid table without a projection would be restored
// whole, keeping the archive's copy of a chain projection the replay should
// have rebuilt; a projection on a table that is not hybrid would drop or
// rewrite rows of a table whose whole row is the user's.
const archivedClassified = new Set(
  Object.entries(CLASSIFICATION)
    .filter(([, c]) => ARCHIVED_CLASSES.has(c.class))
    .map(([t]) => t),
);
const converterMissing = [...archivedClassified].filter((t) => !CONVERTER_IMPORTS.has(t)).sort();
const converterExtra = [...CONVERTER_IMPORTS].filter((t) => !archivedClassified.has(t)).sort();
const hybridSet = new Set(
  Object.entries(CLASSIFICATION)
    .filter(([, c]) => c.class === 'hybrid')
    .map(([t]) => t),
);
const projected = new Set(Object.keys(RESTORE_PROJECTIONS));
const hybridUnprojected = [...hybridSet].filter((t) => !projected.has(t)).sort();
const projectedNotHybrid = [...projected].filter((t) => !hybridSet.has(t)).sort();

let failed = false;
if (malformed.length > 0) {
  failed = true;
  console.error('✗ Malformed classification entries (class must be one of');
  console.error(`  ${[...VALID_CLASSES].join(' | ')}, with a non-empty reason):`);
  for (const t of malformed) console.error(`    ${t}`);
}
if (unclassified.length > 0) {
  failed = true;
  console.error('✗ Written tables with NO classification entry (add one to');
  console.error('  check-table-classification.mjs: decide born-off-chain, hybrid or replay-derived in this change):');
  for (const t of unclassified) {
    console.error(`    ${t}  (written by: ${[...writers.get(t)].join(', ')})`);
  }
}
if (unarchived.length > 0) {
  failed = true;
  console.error('✗ Classified born-off-chain or hybrid but absent from backup.ts:');
  for (const t of unarchived) console.error(`    ${t}`);
}
if (privateBorn.length > 0) {
  failed = true;
  console.error('✗ Classified born-off-chain or hybrid but lives in a PRIVATE database the nightly');
  console.error('  archive does not bind — it could never be backed up (#2450):');
  for (const t of privateBorn) console.error(`    ${t}`);
}
if (notCleared.length > 0) {
  failed = true;
  console.error("✗ Classified replay-derived but missing from OffChainRestore.md §6's");
  console.error('  clear-before-replay command (fabricated rows would survive recovery):');
  for (const t of notCleared) console.error(`    ${t}`);
}
if (clearedUnclassified.length > 0) {
  failed = true;
  console.error("✗ In a §6 clear command but not classified replay-derived for that database:");
  for (const t of clearedUnclassified) console.error(`    ${t}`);
}
if (notImported.length > 0) {
  failed = true;
  console.error("✗ Classified born-off-chain or hybrid but missing from OffChainRestore.md §4's");
  console.error('  import list (an operator following §4 would never restore it):');
  for (const t of notImported) console.error(`    ${t}`);
}
if (importedUnclassified.length > 0) {
  failed = true;
  console.error("✗ In §4's import list but not classified born-off-chain or hybrid:");
  for (const t of importedUnclassified) console.error(`    ${t}`);
}
if (misordered.length > 0) {
  failed = true;
  console.error("✗ §4's import list is out of FK order (parent must precede its");
  console.error('  cascade children, or the child is restored and then erased):');
  for (const m of misordered) console.error(`    ${m}`);
}
if (unconsumed.length > 0) {
  failed = true;
  console.error('✗ backup.ts declares its table arrays but the export loop no longer');
  console.error('  consumes them in the shape this guard watches — if the loop was');
  console.error('  restructured legitimately, update check 6 consciously:');
  for (const u of unconsumed) console.error(`    missing consumption pattern: ${u}`);
}
if (converterMissing.length > 0 || converterExtra.length > 0) {
  failed = true;
  console.error("✗ The restore converter's import allowlist (BORN_OFF_CHAIN_TABLES in");
  console.error('  ops/offchain-data-warm/scripts/restore-from-archive.mjs) differs from the');
  console.error('  tables classified born-off-chain or hybrid:');
  for (const t of converterMissing) console.error(`    ${t}  (classified archived; the converter refuses it)`);
  for (const t of converterExtra) console.error(`    ${t}  (the converter imports it; not classified archived)`);
}
if (hybridUnprojected.length > 0 || projectedNotHybrid.length > 0) {
  failed = true;
  console.error("✗ The restore converter's RESTORE_PROJECTIONS must cover exactly the hybrid tables:");
  for (const t of hybridUnprojected) console.error(`    ${t}  (hybrid, but imported whole)`);
  for (const t of projectedNotHybrid) console.error(`    ${t}  (projected, but not classified hybrid)`);
}
if (missingExternal.length > 0) {
  failed = true;
  console.error('✗ EXTERNAL_WRITERS entry resolves to nothing real (needs an\n  existing script, or `pending: "#NNNN"` with a reason):');
  for (const t of missingExternal) console.error(`    ${t}`);
}
if (dead.length > 0) {
  // Warn-only: a dropped table leaves a harmless entry; flag for cleanup.
  console.warn(`⚠ Classification entries no Worker writes any more: ${dead.join(', ')}`);
}

if (!failed) {
  const count = (k) => Object.values(CLASSIFICATION).filter((c) => c.class === k).length;
  console.log(
    `✓ table classification: ${writers.size} written tables all classified ` +
      `(${count('born-off-chain')} born-off-chain, ${count('hybrid')} hybrid, ` +
      `${count('replay-derived')} replay-derived).`,
  );
}
process.exit(failed ? 1 : 0);
}

// ── The `archivedTablesFrom` helper (exported for probes/tests) ───────
export function archivedTablesFrom(backupSrc) {
  const grab = (name) => {
    const m = backupSrc.match(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`));
    if (!m) throw new Error(`could not locate \`const ${name} = [...]\` in backup.ts`);
    // Strip comments INSIDE the array block, then take quoted strings.
    return m[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  };
  const archived = new Set();
  for (const s of grab('ARCHIVE_TABLES_REQUIRED').matchAll(/'([a-z0-9_]+)'/g)) {
    archived.add(s[1]);
  }
  // Rollout-aware entries are `{ table: 'name', migrationPrefix: '…' }`.
  for (const s of grab('ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED').matchAll(
    /table:\s*'([a-z0-9_]+)'/g,
  )) {
    archived.add(s[1]);
  }
  return archived;
}

/** Table names deleted by the runbook §6 clear-before-replay command(s)
 *  against `database` (default: the shared one). Targets the bash
 *  fence(s) that invoke `wrangler d1 execute <database>` with DELETE
 *  statements — prose mentions of DELETE FROM elsewhere in the document
 *  do not count.
 *
 *  Parsed PER INVOCATION, not per fence (#2450): with two databases a
 *  fence may carry a command for each, and attributing every DELETE in the
 *  fence to whichever database the fence mentions first would credit a
 *  table as cleared in a database that never saw the statement. A bash
 *  comment line is not an invocation. `required: false` lets a database
 *  that has nothing replay-derived go without a command. */
export function clearedTablesFrom(runbookSrc, database = SHARED_DATABASE, { required = true } = {}) {
  const cleared = new Set();
  const target = new RegExp(`wrangler\\s+d1\\s+execute\\s+(['"]?)${database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1(?![a-z0-9-])`);
  for (const fence of runbookSrc.matchAll(/```bash\n([\s\S]*?)```/g)) {
    // Model bash BEFORE SQL (Codex #1485 r4): join `\`-newline
    // continuations exactly as bash does, THEN isolate the SQL — the
    // `--command="…"` value — and apply SQLite comment semantics to
    // that string ALONE. Earlier revisions comment-stripped the whole
    // fence and needed a space-after-`--` heuristic to spare wrangler's
    // flags, which missed the spaceless `--DELETE …` form SQLite
    // happily treats as a comment (Codex #1485 r5). Scoping to the
    // command value removes the heuristic: inside SQL, `--` to
    // end-of-input is a comment, full stop.
    const joined = fence[1].replace(/\\\n/g, ' ');
    for (const line of joined.split('\n')) {
      if (line.trimStart().startsWith('#')) continue;
      if (!target.test(line) || !line.includes('DELETE FROM')) continue;
      const cmd = line.match(/--command="([^"]*)"/);
      if (!cmd) continue;
      // The §6 replay-clear only counts against the DEPLOYED database.
      // Without `--remote`, wrangler targets a local D1 and the replay
      // would run over an uncleared production dataset (Codex #1485 r5).
      if (!/\s--remote\b/.test(line)) {
        throw new Error(
          `the §6 clear-before-replay command for ${database} is missing --remote — it would ` +
            'clear a LOCAL D1 and leave the deployed database unpurged',
        );
      }
      const sql = cmd[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/s, '');
      for (const m of sql.matchAll(/DELETE\s+FROM\s+([a-z][a-z0-9_]*)/gi)) {
        cleared.add(m[1].toLowerCase());
      }
    }
  }
  if (cleared.size === 0 && required) {
    throw new Error(`could not locate the §6 clear-before-replay command for ${database} in OffChainRestore.md`);
  }
  return cleared;
}

/** Table names in the runbook §4 import list — the backticked names
 *  after the "**`vaipakam-warm` tables** (born-off-chain and hybrid):"
 *  marker, up to the end of that sentence.
 *  Returns them IN LIST ORDER: §4's order is load-bearing (parent
 *  before cascade children), so callers check sequence, not just
 *  membership. */
export function importTablesFrom(runbookSrc) {
  const m = runbookSrc.match(
    /\*\*`vaipakam-warm` tables\*\* \(born-off-chain and hybrid\):([\s\S]*?)\.\n/,
  );
  if (!m) {
    throw new Error('could not locate the §4 born-off-chain import list in OffChainRestore.md');
  }
  const tables = [];
  for (const t of m[1].matchAll(/`([a-z][a-z0-9_]*)`/g)) {
    if (!tables.includes(t[1])) tables.push(t[1]);
  }
  return tables;
}

// Run only when invoked directly — importing this module for its
// helpers must not execute the checks (or exit the importer).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChecks();
}
