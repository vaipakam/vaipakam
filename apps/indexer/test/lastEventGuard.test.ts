/**
 * #3921 part B2 — every row the indexer derives names the event that last
 * changed it (TroubleshootingPictureDesign §4.6). The rule and its one SQL
 * form are in `src/lastEvent.ts`; this file is what keeps it true.
 *
 * Three checks:
 *
 *  1. Every table of the shared database is CLASSIFIED below: an event-derived
 *     row (it must carry the three last-event columns), or not, with the
 *     reason. A new table fails here until someone decides which it is.
 *  2. Every event-derived table carries the columns, except those still
 *     PENDING. The pending list only shrinks: a pending table that has gained
 *     the columns fails until it leaves the list, so the list cannot go stale.
 *     It reaches empty one handler group at a time.
 *  3. Every write to an event-derived table that is not pending, anywhere in
 *     the Workers and the shared library, sets the columns: an INSERT names
 *     all three, an UPDATE (or an upsert's DO UPDATE) ends with
 *     `${LAST_EVENT_SET}`, or the statement carries the SQL comment
 *     `last-event: unchanged — <reason>` for a write that changes no figure
 *     an event produced.
 *
 * The statements are found with the TypeScript parser (every string and
 * template literal), not with a regular expression over the source, so a
 * comment that mentions a table is not a write, and a write built outside a
 * `.prepare(...)` call (a shared SQL constant) is still found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LAST_EVENT_SET, LAST_EVENT_UPSERT_SET } from '../src/lastEvent';
import rebuildKeep from '../src/reorgRebuildKeep.json';

const REPO = new URL('../../../', import.meta.url);
const MIGRATIONS_DIR = new URL('apps/indexer/migrations/', REPO);
const LAST_EVENT_COLUMNS = ['last_event_block', 'last_event_tx_index', 'last_event_log_index'] as const;

/** Where the shared database is written from. */
const SOURCE_DIRS = ['apps/indexer/src', 'apps/agent/src', 'apps/keeper/src', 'packages/lib/src'];

type Classification =
  | { eventRow: true }
  | { eventRow: false; reason: string };

const EVENT_ROW = { eventRow: true } as const;
const not = (reason: string): Classification => ({ eventRow: false, reason });
const OWN_EVENT = not('each row is one event, keyed by its own block and position, and never changes after');
const READ = not('a snapshot of chain state read at a block, not a fold of events; it records what it read');
const BORN_OFF_CHAIN = not('born off chain: written by a user, an operator or a service, never derived from an event');
const PRODUCER_STATE = not('the indexer\'s own progress or bookkeeping, not a figure derived from an event');

/** Every table of the shared database. */
const CLASSIFICATION: Record<string, Classification> = {
  // Event-derived rows: a handler changes them as events arrive.
  offers: EVENT_ROW,
  loans: EVENT_ROW,
  loan_lifecycle_state: EVENT_ROW,
  rental_rights: EVENT_ROW,
  swap_to_repay_intents: EVENT_ROW,
  prepay_listings: EVENT_ROW,
  loan_participants: EVENT_ROW,
  signed_offers: EVENT_ROW,
  keeper_commitment_reconciled: EVENT_ROW,
  recycle_chain_reported: EVENT_ROW,
  recycle_prelaunch: EVENT_ROW,
  recycle_day_pool: EVENT_ROW,
  reward_loop_totals: EVENT_ROW,
  reward_loop_day: EVENT_ROW,
  reward_day_user: EVENT_ROW,
  reward_retention: EVENT_ROW,

  // Each row is one event.
  activity_events: OWN_EVENT,
  activity_participants: not('one row per wallet of one event, keyed by that event\'s block and log position'),
  chain_event_log: OWN_EVENT,
  facet_history: OWN_EVENT,
  settings_history: OWN_EVENT,
  loan_lifecycle_violation: OWN_EVENT,
  position_side_moves: OWN_EVENT,
  recycle_series_events: OWN_EVENT,
  reward_loop_events: OWN_EVENT,
  pending_activity_events: not('events above the safe block, each keyed by its block and position, replaced every caught-up pass'),
  prepay_listing_match_breadcrumbs: not('one row per PrepayListingMatched, keyed by its transaction'),
  notifications: not('one notice per event, carrying the event\'s block and log position'),

  // Reads of chain state, and aggregates of other rows.
  oracle_snapshot_state: READ,
  liquidity_confidence: READ,
  protocol_config: not('a snapshot of the settings read at a block; it records that block (source_block)'),
  recycle_backing_snapshot: not('a snapshot of contract state read at a block; it records that block'),
  asset_issuer_check: not('a check of an asset\'s contracts read at a block; it records that block'),
  asset_issuer_finding: not('a finding of an asset check; it points at its check'),
  asset_ranking: not('market rankings from an outside source, not from chain events'),
  asset_ranking_run: not('a run of the outside rankings fetch'),
  market_summary: not('an aggregate of offer rows; a figure is traced through the offer rows it sums, which name their events'),

  // The indexer's own progress and bookkeeping.
  indexer_cursor: PRODUCER_STATE,
  indexer_chain_anchor: PRODUCER_STATE,
  indexer_deployment: PRODUCER_STATE,
  pending_activity_window: PRODUCER_STATE,
  activity_participants_state: PRODUCER_STATE,
  recycle_series_state: PRODUCER_STATE,
  prenotify_pass: PRODUCER_STATE,
  loan_reconcile_quarantine: not('findings of the reconciliation pass about loan rows, each with what it observed'),
  loan_orphans: not('loan rows proven absent on chain, moved here whole; the kept row carries its own last-event columns'),
  webhook_deliveries: PRODUCER_STATE,
  signed_request_use: PRODUCER_STATE,
  protected_lock_readiness: PRODUCER_STATE,
  protected_lock_requests: BORN_OFF_CHAIN,
  push_rail_status: PRODUCER_STATE,
  alert_channel_changes: BORN_OFF_CHAIN,

  // Born off chain.
  diag_errors: BORN_OFF_CHAIN,
  diag_legal_holds: BORN_OFF_CHAIN,
  diag_legal_hold_audit: BORN_OFF_CHAIN,
  user_thresholds: BORN_OFF_CHAIN,
  notify_state: BORN_OFF_CHAIN,
  pre_grace_notify_state: BORN_OFF_CHAIN,
  telegram_links: BORN_OFF_CHAIN,
  support_tickets: BORN_OFF_CHAIN,
  failed_tx: not('a failed transaction, keyed by its own hash and block'),
  failed_tx_cursor: PRODUCER_STATE,
  failed_tx_range: PRODUCER_STATE,
  service_build_history: BORN_OFF_CHAIN,
};

/**
 * Event-derived tables that do not carry the columns YET. Only shrinks: each
 * handler group's change adds its migration and removes its tables here.
 */
const PENDING = new Set<string>([
  // The signed offer book.
  'signed_offers',
  // The reward and recycling ledgers.
  'keeper_commitment_reconciled',
  'recycle_chain_reported',
  'recycle_prelaunch',
  'recycle_day_pool',
  'reward_loop_totals',
  'reward_loop_day',
  'reward_day_user',
  'reward_retention',
]);

function migratedSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
  }
  return db;
}

function sourceFiles(dir: URL): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) {
      if (name === 'node_modules' || name === 'test' || name === '__tests__') continue;
      out.push(...sourceFiles(new URL(`${name}/`, dir)));
    } else if (/\.(ts|mts|mjs|js)$/.test(name) && !/\.(test|spec)\./.test(name) && !/\.d\.(ts|mts)$/.test(name)) {
      out.push(url.pathname);
    }
  }
  return out;
}

interface Literal {
  file: string;
  line: number;
  text: string;
}

/** Every string and template literal, a template's substitutions written
 *  back as `${<expression>}`. */
function literals(file: string): Literal[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Literal[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push({ file, line: line(n), text: n.text });
    } else if (ts.isTemplateExpression(n)) {
      let t = n.head.text;
      for (const span of n.templateSpans) t += '${' + span.expression.getText(sf) + '}' + span.literal.text;
      out.push({ file, line: line(n), text: t });
      return; // its spans' own literals are part of this one
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

interface Write {
  where: string;
  table: string;
  kind: 'insert' | 'update';
  sql: string;
}

const WRITE = /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE)\s+(?:\/\*[\s\S]*?\*\/\s*)?("?)([A-Za-z_][\w]*|\$\{[^}]+\})\2/g;

function writes(lits: Literal[]): Write[] {
  const out: Write[] = [];
  for (const lit of lits) {
    for (const m of lit.text.matchAll(WRITE)) {
      const table = m[3];
      // `DO UPDATE SET` inside an upsert is that INSERT's, checked with it.
      if (/^set$/i.test(table)) continue;
      const start = m.index!;
      // The statement ends at the first `;` outside a SQL comment.
      let end = -1;
      for (let i = start; i < lit.text.length; i++) {
        if (lit.text.startsWith('/*', i)) {
          const close = lit.text.indexOf('*/', i + 2);
          if (close < 0) break;
          i = close + 1;
        } else if (lit.text[i] === ';') {
          end = i;
          break;
        }
      }
      out.push({
        where: `${lit.file.replace(REPO.pathname, '')}:${lit.line}`,
        table,
        kind: /^UPDATE$/i.test(m[1]) ? 'update' : 'insert',
        sql: lit.text.slice(start, end < 0 ? undefined : end),
      });
    }
  }
  return out;
}

const MARKER = /\/\*\s*last-event:\s*unchanged\s+—\s+(.{10,}?)\s*\*\//;

/** Why a write to an event-derived table does not set the columns, or null. */
function refusal(w: Write): string | null {
  if (MARKER.test(w.sql)) return null;
  const sets = w.sql.includes('${LAST_EVENT_SET}');
  if (w.kind === 'update') return sets ? null : 'an UPDATE that does not end with ${LAST_EVENT_SET}';
  const columns = /^[^(]*\(([^)]*)\)/.exec(w.sql)?.[1] ?? '';
  const named = LAST_EVENT_COLUMNS.every((c) => new RegExp(`\\b${c}\\b`).test(columns));
  if (!named) return 'an INSERT whose column list does not name the three last-event columns';
  const upsertSets = sets || w.sql.includes('${LAST_EVENT_UPSERT_SET}');
  if (/\bDO\s+UPDATE\b/i.test(w.sql) && !upsertSets) {
    return 'an upsert whose DO UPDATE does not set ${LAST_EVENT_UPSERT_SET} (or ${LAST_EVENT_SET})';
  }
  return null;
}

describe('every derived row names the event that last changed it (#3921 B2)', () => {
  const db = migratedSchema();
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const columnsOf = (t: string) =>
    (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[]).map((c) => c.name);
  const required = Object.entries(CLASSIFICATION)
    .filter(([t, c]) => c.eventRow && !PENDING.has(t))
    .map(([t]) => t);
  const all = SOURCE_DIRS.flatMap((d) => sourceFiles(new URL(`${d}/`, REPO))).flatMap(literals);
  const found = writes(all);

  it('classifies every table of the shared database, and nothing else', () => {
    expect(tables.length).toBeGreaterThan(50);
    expect(tables.filter((t) => !(t in CLASSIFICATION)), 'unclassified tables').toEqual([]);
    expect(Object.keys(CLASSIFICATION).filter((t) => !tables.includes(t)), 'classified tables that do not exist').toEqual([]);
    for (const [t, c] of Object.entries(CLASSIFICATION)) {
      if (!c.eventRow) expect(c.reason.length, `${t} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('the pending list names only event-derived tables that lack the columns', () => {
    for (const t of PENDING) {
      expect(CLASSIFICATION[t]?.eventRow, `${t} is pending but not an event-derived table`).toBe(true);
      const has = LAST_EVENT_COLUMNS.filter((c) => columnsOf(t).includes(c));
      expect(has, `${t} has gained the columns: take it off the pending list`).toEqual([]);
    }
  });

  it('every event-derived table that is not pending carries the three columns', () => {
    expect(required).toEqual(expect.arrayContaining(['offers', 'loans']));
    for (const t of required) {
      expect(columnsOf(t), t).toEqual(expect.arrayContaining([...LAST_EVENT_COLUMNS]));
    }
  });

  it('still sees the write statements (pinned floor)', () => {
    // A collapse means the parse no longer reaches the sources.
    expect(found.filter((w) => w.table === 'offers' || w.table === 'loans').length).toBeGreaterThanOrEqual(45);
  });

  it('names no write by an interpolated table but the reorg rebuild, which resets the columns it must', () => {
    // The one dynamic writer: a reorg rebuild sets a kept hybrid table's
    // replayed columns back to where the scan starts (src/reorgRebuildKeep.json).
    // Those columns are event-derived figures, so for an event-derived table
    // the reset must take the last-event columns back to unknown too.
    const dynamic = found.filter((w) => w.table.startsWith('${'));
    expect(dynamic.filter((w) => !w.where.startsWith('apps/indexer/src/deploymentEpoch.ts:')).map((w) => w.where)).toEqual([]);
    for (const [t, p] of Object.entries(rebuildKeep.project) as [string, { set: Record<string, unknown> }][]) {
      if (!required.includes(t)) continue;
      for (const c of LAST_EVENT_COLUMNS) expect(p.set[c], `reorgRebuildKeep.json: ${t} must reset ${c} to null`).toBeNull();
    }
  });

  it('every write to an event-derived table sets the columns or says why not', () => {
    const failures = found
      .filter((w) => required.includes(w.table))
      .map((w) => [w, refusal(w)] as const)
      .filter(([, why]) => why !== null)
      .map(([w, why]) => `${w.where} ${w.table}: ${why}\n  ${w.sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('the shared assignment keeps the later of two positions', () => {
    const t = new DatabaseSync(':memory:');
    t.exec(`CREATE TABLE r (id INTEGER PRIMARY KEY, v INTEGER,
      last_event_block INTEGER, last_event_tx_index INTEGER, last_event_log_index INTEGER)`);
    t.exec(`INSERT INTO r (id, v) VALUES (1, 0)`);
    const set = t.prepare(`UPDATE r SET v = ?, ${LAST_EVENT_SET} WHERE id = 1`);
    const at = () =>
      Object.values(
        t.prepare(`SELECT last_event_block, last_event_tx_index, last_event_log_index FROM r`).get() as object,
      );
    set.run(1, 10, 2, 30);
    expect(at()).toEqual([10, 2, 30]); // unknown before: any position replaces it
    set.run(2, 10, 1, 12);
    expect(at()).toEqual([10, 2, 30]); // an earlier log of the same block does not
    set.run(3, 9, 5, 99);
    expect(at()).toEqual([10, 2, 30]); // nor an earlier block
    set.run(4, 10, 3, 31);
    expect(at()).toEqual([10, 3, 31]); // a later log does
    set.run(5, 10, null, null);
    expect(at()).toEqual([10, null, null]); // a read at the block comes after its logs
    set.run(6, 10, 4, 40);
    expect(at()).toEqual([10, null, null]); // …so a log of that block does not replace it
    set.run(7, 11, 0, 0);
    expect(at()).toEqual([11, 0, 0]); // a later block does
    // A write whose figures came from a source it cannot name makes the row
    // unknown, so the row never names a source that did not produce it…
    set.run(8, null, null, null);
    expect(at()).toEqual([null, null, null]);
    // …and a stored unknown gives way to any known position.
    set.run(9, 3, 0, 0);
    expect(at()).toEqual([3, 0, 0]);
    expect((t.prepare('SELECT v FROM r').get() as { v: number }).v).toBe(9); // the write itself always lands
  });

  it('the upsert form follows the same rule (#3921 B2)', () => {
    const t = new DatabaseSync(':memory:');
    t.exec(`CREATE TABLE r (id INTEGER PRIMARY KEY, v INTEGER,
      last_event_block INTEGER, last_event_tx_index INTEGER, last_event_log_index INTEGER)`);
    const up = t.prepare(
      `INSERT INTO r (id, v, last_event_block, last_event_tx_index, last_event_log_index) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET v = excluded.v, ${LAST_EVENT_UPSERT_SET}`,
    );
    const at = () =>
      Object.values(
        t.prepare(`SELECT last_event_block, last_event_tx_index, last_event_log_index FROM r`).get() as object,
      );
    up.run(1, 10, 2, 30);
    expect(at()).toEqual([10, 2, 30]);
    up.run(2, 9, 5, 99);
    expect(at()).toEqual([10, 2, 30]);
    up.run(3, 10, 3, 31);
    expect(at()).toEqual([10, 3, 31]);
    up.run(4, null, null, null);
    expect(at()).toEqual([null, null, null]);
  });

  it('refuses the shapes it is meant to refuse', () => {
    const w = (sql: string, kind: Write['kind']): Write => ({ where: 'x', table: 'loans', kind, sql });
    expect(refusal(w('UPDATE loans SET principal = ? WHERE loan_id = ?', 'update'))).not.toBeNull();
    expect(refusal(w('UPDATE loans SET principal = ?, ${LAST_EVENT_SET} WHERE loan_id = ?', 'update'))).toBeNull();
    expect(refusal(w('UPDATE loans /* last-event: unchanged — a flag nothing reads as a figure */ SET f = 1', 'update'))).toBeNull();
    expect(refusal(w('UPDATE loans /* last-event: unchanged — */ SET f = 1', 'update'))).not.toBeNull(); // no reason
    expect(refusal(w('INSERT INTO loans (chain_id, loan_id) VALUES (?, ?)', 'insert'))).not.toBeNull();
    expect(
      refusal(w('INSERT INTO loans (chain_id, last_event_block, last_event_tx_index, last_event_log_index) VALUES (?, ?, ?, ?)', 'insert')),
    ).toBeNull();
    expect(
      refusal(
        w(
          'INSERT INTO loans (chain_id, last_event_block, last_event_tx_index, last_event_log_index) VALUES (?, ?, ?, ?) ON CONFLICT (chain_id) DO UPDATE SET principal = excluded.principal',
          'insert',
        ),
      ),
    ).not.toBeNull();
  });
});
