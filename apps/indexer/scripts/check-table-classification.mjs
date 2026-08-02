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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

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
  // M5 (#1218 / #1349) recycling transparency series. Classified rather
  // than deferred: every column is a fold of chain logs and nothing else,
  // so a block-zero replay rebuilds both tables exactly. The pre-cutover
  // BACKFILL is deliberately NOT part of them — those rows cannot be
  // replayed and get their own born-off-chain table in their own slice
  // (see the 0045 migration header).
  recycle_prelaunch: { class: 'replay-derived', reason: 'per-chain fold of VpfiRecycledPreLaunch; regenerated by replay' },
  recycle_series_state: { class: 'replay-derived', reason: 'one-time activity_events backfill marker; meaningless without the projection it guards' },
  recycle_series_events: { class: 'replay-derived', reason: 'chain-log dedup keyed (chain, block, logIndex); regenerated by replay' },
  recycle_day_pool: { class: 'replay-derived', reason: 'per-reward-day fold of GovernorDayPoolStamped / VpfiRecycled / ChainRecycledReported; no off-chain input' },
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
const VALID_CLASSES = new Set(['born-off-chain', 'replay-derived', 'decision-needed']);
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
const dead = Object.keys(CLASSIFICATION).filter((t) => !writers.has(t)).sort();

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
  readFileSync(join(REPO_ROOT, 'ops', 'offchain-data-archive', 'src', 'backup.ts'), 'utf8'),
);
// Strings KEPT for the array parse (the table names ARE string
// literals); strings BLANKED for the consumption tripwires (a spread
// quoted inside a string is prose, not consumption).
const backupSrc = backupLex.codeWithStrings;
const backupCode = backupLex.code;
const archivedSet = archivedTablesFrom(backupSrc);
const unarchived = Object.entries(CLASSIFICATION)
  .filter(([t, c]) => c.class === 'born-off-chain' && !archivedSet.has(t))
  .map(([t]) => t);

// ── Check 4: replay-derived == the runbook's §6 clear command ─────────
// The classification's PROMISE for this class is "cleared before the
// block-zero replay", and the implementation of that promise is the
// fixed DELETE command in OffChainRestore.md §6. A replay-derived
// entry missing there lets fabricated rows survive tampering recovery;
// a cleared table not classified replay-derived means the command
// deletes something whose restore treatment says otherwise. Both
// directions fail (Codex #1485 r2).
const runbookSrc = readFileSync(join(REPO_ROOT, 'docs', 'ops', 'OffChainRestore.md'), 'utf8');
const clearedSet = clearedTablesFrom(runbookSrc);
const replaySet = new Set(
  Object.entries(CLASSIFICATION)
    .filter(([, c]) => c.class === 'replay-derived')
    .map(([t]) => t),
);
const notCleared = [...replaySet].filter((t) => !clearedSet.has(t)).sort();
const clearedUnclassified = [...clearedSet].filter((t) => !replaySet.has(t)).sort();

// ── Check 5: born-off-chain == the runbook's §4 import list ───────────
// Same promise-vs-implementation binding as check 4, for the other
// class: an archived table missing from §4's list is one the operator
// never imports during recovery, so the archived user state silently
// stays absent from the restored D1 (Codex #1485 r3).
const importList = importTablesFrom(runbookSrc);
const importSet = new Set(importList);
const bornSet = new Set(
  Object.entries(CLASSIFICATION)
    .filter(([, c]) => c.class === 'born-off-chain')
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
if (notCleared.length > 0) {
  failed = true;
  console.error("✗ Classified replay-derived but missing from OffChainRestore.md §6's");
  console.error('  clear-before-replay command (fabricated rows would survive recovery):');
  for (const t of notCleared) console.error(`    ${t}`);
}
if (clearedUnclassified.length > 0) {
  failed = true;
  console.error("✗ In §6's clear command but not classified replay-derived:");
  for (const t of clearedUnclassified) console.error(`    ${t}`);
}
if (notImported.length > 0) {
  failed = true;
  console.error("✗ Classified born-off-chain but missing from OffChainRestore.md §4's");
  console.error('  import list (an operator following §4 would never restore it):');
  for (const t of notImported) console.error(`    ${t}`);
}
if (importedUnclassified.length > 0) {
  failed = true;
  console.error("✗ In §4's import list but not classified born-off-chain:");
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

/** Table names deleted by the runbook §6 clear-before-replay command.
 *  Targets the bash fence(s) that invoke `wrangler d1 execute
 *  vaipakam-archive` with DELETE statements — prose mentions of
 *  DELETE FROM elsewhere in the document do not count. */
export function clearedTablesFrom(runbookSrc) {
  const cleared = new Set();
  for (const fence of runbookSrc.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const raw = fence[1];
    if (!raw.includes('wrangler d1 execute vaipakam-archive') || !raw.includes('DELETE FROM')) {
      continue;
    }
    // Model bash BEFORE SQL (Codex #1485 r4): join `\`-newline
    // continuations exactly as bash does, THEN isolate the SQL — the
    // `--command="…"` value — and apply SQLite comment semantics to
    // that string ALONE. Earlier revisions comment-stripped the whole
    // fence and needed a space-after-`--` heuristic to spare wrangler's
    // flags, which missed the spaceless `--DELETE …` form SQLite
    // happily treats as a comment (Codex #1485 r5). Scoping to the
    // command value removes the heuristic: inside SQL, `--` to
    // end-of-input is a comment, full stop.
    const joined = raw.replace(/\\\n/g, ' ');
    const cmd = joined.match(/--command="([^"]*)"/);
    if (!cmd) continue;
    // The §6 replay-clear only counts against the DEPLOYED database.
    // Without `--remote`, wrangler targets a local D1 and the replay
    // would run over an uncleared production dataset (Codex #1485 r5).
    if (!/\s--remote\b/.test(joined)) {
      throw new Error(
        'the §6 clear-before-replay command is missing --remote — it would clear a LOCAL D1 ' +
          'and leave the deployed database unpurged',
      );
    }
    const sql = cmd[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/s, '');
    for (const m of sql.matchAll(/DELETE\s+FROM\s+([a-z][a-z0-9_]*)/gi)) {
      cleared.add(m[1].toLowerCase());
    }
  }
  if (cleared.size === 0) {
    throw new Error('could not locate the §6 clear-before-replay command in OffChainRestore.md');
  }
  return cleared;
}

/** Table names in the runbook §4 born-off-chain import list — the
 *  backticked names after the "**`vaipakam-archive` tables**
 *  (born-off-chain):" marker, up to the end of that sentence.
 *  Returns them IN LIST ORDER: §4's order is load-bearing (parent
 *  before cascade children), so callers check sequence, not just
 *  membership. */
export function importTablesFrom(runbookSrc) {
  const m = runbookSrc.match(
    /\*\*`vaipakam-archive` tables\*\* \(born-off-chain\):([\s\S]*?)\.\n/,
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
