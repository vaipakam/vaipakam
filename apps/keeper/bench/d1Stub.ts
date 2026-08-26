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
    const allRows = isRead ? rowsFor(table) : [];
    // The table IS seeded even if a later bound filter yields no rows, so the
    // "unseeded" diagnostic keys on the RAW seed count, not the filtered one —
    // otherwise a `WHERE chain_id = <arb>` on a Base-only fixture would be
    // reported as an unseeded table rather than an empty chain.
    if (isRead && allRows.length === 0 && table) d1Stats.unseeded.add(table);

    // Honour the bind arguments. `bind` used to return `stmt` and discard its
    // args, so `WHERE chain_id = ?` never filtered — a focused watcher replayed
    // all 20 Base subscribers on every configured chain and did 3x the RPCs it
    // should (Codex #1945 r3). Match each `col = ?` in the SQL to its bind arg
    // positionally and keep only rows whose seeded value agrees; a column the
    // fixture row does not carry is not filtered on.
    const boundCols = [...sql.matchAll(/([a-z_][a-z0-9_]*)\s*=\s*\?/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    let boundArgs: unknown[] = [];
    const rows = () => {
      if (boundCols.length === 0 || boundArgs.length === 0) return allRows;
      return allRows.filter((row) =>
        boundCols.every((col, i) => {
          if (i >= boundArgs.length) return true;
          const seeded = (row as Record<string, unknown>)[col];
          return seeded === undefined || String(seeded) === String(boundArgs[i]);
        }),
      );
    };
    const stmt: Record<string, unknown> = {};
    stmt.bind = (...args: unknown[]) => {
      boundArgs = args;
      return stmt;
    };
    stmt.all = async () => ({ results: rows(), success: true, meta: {} });
    stmt.first = async () => rows()[0] ?? null;
    stmt.run = async () => ({ results: rows(), success: true, meta: {} });
    stmt.raw = async () => rows().map((r) => Object.values(r));
    return stmt;
  };
  return {
    prepare,
    batch: async (s: unknown[]) => s.map(() => ({ results: [], success: true, meta: {} })),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  };
}
