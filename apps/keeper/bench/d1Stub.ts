/**
 * A seeded D1 stub for the CPU harness (#1896).
 *
 * WHY SEEDED. The passes are D1-DRIVEN: their work list comes from the
 * database, not from chain. `watchChain` reads `user_thresholds` and returns
 * immediately when it is empty, so an empty stub makes the pass issue zero RPC
 * calls and profile as free. The harness's third wrong answer came from
 * exactly that — a clean-looking 0.9 ms for `watcher` that measured nothing.
 *
 * So this answers by TABLE, taking the table name out of the SQL text, and
 * returns a configurable number of plausible rows. Anything it does not
 * recognise still answers empty, and the runner reports any pass that made no
 * RPC calls as NOT MEASURED rather than as cheap.
 */

/** Rows returned for a recognised list query. */
export const ROWS = Number(process.env.BENCH_ROWS ?? 20);

const WALLET = (i: number) =>
  `0x${(i + 1).toString(16).padStart(40, '0')}`;

/** Which table is this statement about? */
function tableOf(sql: string): string {
  const m =
    sql.match(/\bfrom\s+([a-z_][a-z0-9_]*)/i) ??
    sql.match(/\b(?:into|update)\s+([a-z_][a-z0-9_]*)/i);
  return (m?.[1] ?? '').toLowerCase();
}

/** Seeded rows per table. Add a case when a pass starts reading a new one. */
function rowsFor(table: string): Record<string, unknown>[] {
  switch (table) {
    case 'user_thresholds':
      return Array.from({ length: ROWS }, (_, i) => ({
        wallet: WALLET(i),
        chain_id: 84532,
        warn_hf: 2.0,
        alert_hf: 1.5,
        critical_hf: 1.1,
        tg_chat_id: null,
        push_channel: null,
        locale: 'en',
        notify_maturity_approaching: 0,
      }));
    default:
      // Unrecognised: empty. The pass will do nothing, and the runner will
      // say so rather than calling it cheap.
      return [];
  }
}

/** Tracks which tables were asked for, so gaps are visible not silent. */
export const d1Stats = { tables: new Set<string>(), unseeded: new Set<string>() };
/**
 * Reset the PER-RUN view only. `unseeded` deliberately ACCUMULATES across
 * passes and repetitions: it is printed once at the end, so clearing it every
 * repetition meant the final diagnostic described only the last repetition of
 * the last pass and erased every gap seen earlier (Codex #1945 r1).
 */
export function resetD1(): void {
  d1Stats.tables.clear();
}

export function d1Stub(): unknown {
  const prepare = (sql: string) => {
    const table = tableOf(sql);
    d1Stats.tables.add(table);
    const isRead = /^\s*select/i.test(sql);
    const rows = isRead ? rowsFor(table) : [];
    if (isRead && rows.length === 0 && table) d1Stats.unseeded.add(table);
    const res = { results: rows, success: true, meta: {} };
    const stmt: Record<string, unknown> = {};
    stmt.bind = () => stmt;
    stmt.all = async () => res;
    stmt.first = async () => rows[0] ?? null;
    stmt.run = async () => res;
    stmt.raw = async () => rows.map((r) => Object.values(r));
    return stmt;
  };
  return {
    prepare,
    batch: async (s: unknown[]) => s.map(() => ({ results: [], success: true, meta: {} })),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  };
}
