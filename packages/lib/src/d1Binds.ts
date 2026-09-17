/**
 * D1's bound-parameter ceiling, and the one way to stay under it.
 *
 * D1 caps a single prepared statement at **100 bound parameters**. A statement
 * that asks for more does not return a partial answer — it throws, and it
 * throws identically on every subsequent attempt, because the input that
 * overflowed it is a function of how much work is waiting rather than of
 * anything transient. That is the shape worth naming: not a flaky read, a
 * *stall*, and one that arrives precisely when a backlog has built up.
 *
 * The cap is recorded in this repository with its provenance at
 * `apps/indexer/src/notifications.ts` (Codex #1292 r1) — a catch-up touching
 * more than 99 distinct loans "would blow the limit, throw, and — fail-open —
 * skip those rows forever, with the cursor already advanced".
 *
 * WHY THIS IS A SHARED MODULE AND NOT A THIRD LOCAL CONSTANT (#2234).
 *
 * Three call sites had independently arrived at a local `90`, each with its
 * own comment re-deriving the same arithmetic, and two more had never chunked
 * at all — one of them (`getRemitAckAttempts`) collecting up to 200 ids and
 * throwing on 99. Patching that one site would have left the next author to
 * rediscover the cap exactly as the previous two did. So the number lives
 * here, once, with its source.
 *
 * WHY THE CALLER DOES NOT STATE A RESERVED COUNT.
 *
 * The obvious signature is `chunk(items, reservedBinds)`, and it carries the
 * defect it is meant to remove: `reservedBinds` is a hand-maintained count of
 * the statement's OTHER binds, so adding a `WHERE` clause a year later makes
 * it quietly wrong, and wrong in the direction that overflows. Here the caller
 * hands over the fixed binds themselves and gets back the complete bind array
 * for each chunk. There is no count to keep in step, because there is no
 * count.
 *
 * NO SAFETY MARGIN, deliberately. The chunk is as wide as the cap allows once
 * the fixed binds are subtracted. A margin exists to absorb a miscounted
 * reservation, and the shape above removes the miscount instead — a margin on
 * top would only hide arithmetic that is already exact, and would cost a
 * statement per read on the widest pages.
 *
 * Framework-free: no viem, no DOM, no D1 types. It builds strings and arrays,
 * so a Worker, a test harness and a browser bundle can all take it.
 */

/**
 * The hard ceiling on bound parameters in ONE D1 statement.
 *
 * Not a tuning knob. Lowering it is safe; raising it is a claim about D1 that
 * this repository cannot make on its own.
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** One statement's worth of an `IN (...)` list. */
export interface D1InChunk<T> {
  /** The items in this chunk, in the order they were given. */
  items: T[];
  /** `?, ?, …` — exactly `items.length` placeholders. */
  placeholders: string;
  /**
   * Every bind for this statement, in statement order: the fixed binds that
   * precede the list, then the chunk, then the fixed binds that follow it.
   * Pass it straight to `.bind(...)` — splitting it apart and reassembling is
   * how the order goes wrong.
   */
  binds: unknown[];
}

/**
 * Split `items` into as few statements as D1's cap allows.
 *
 * `before` / `after` are the statement's other binds, in the order they appear
 * around the `IN (...)` list. They are counted against the cap and repeated in
 * every chunk's `binds`, because every chunk is a separate statement that
 * needs them.
 *
 * An empty `items` yields an empty array — a caller with nothing to look up
 * should issue no statement at all, rather than one with `IN ()`, which is not
 * valid SQL.
 *
 * Throws `RangeError` when the fixed binds alone leave no room for even one
 * item. That is a statement that can never run, so it is a programming error
 * rather than a condition to degrade around, and the alternative — returning
 * zero-width chunks — is an infinite loop.
 */
export function chunkD1InList<T>(
  items: readonly T[],
  opts: { before?: readonly unknown[]; after?: readonly unknown[] } = {},
): D1InChunk<T>[] {
  const before = opts.before ?? [];
  const after = opts.after ?? [];
  const width = D1_MAX_BOUND_PARAMETERS - before.length - after.length;
  if (width < 1) {
    throw new RangeError(
      `chunkD1InList: ${before.length + after.length} fixed binds leave no ` +
        `room under D1's ${D1_MAX_BOUND_PARAMETERS}-parameter cap for even ` +
        `one list item; this statement cannot run at any list length.`,
    );
  }
  const out: D1InChunk<T>[] = [];
  for (let i = 0; i < items.length; i += width) {
    const chunk = items.slice(i, i + width);
    out.push({
      items: chunk,
      placeholders: chunk.map(() => '?').join(', '),
      binds: [...before, ...chunk, ...after],
    });
  }
  return out;
}

/**
 * The widest `IN (...)` list this statement can carry, given its other binds.
 *
 * For call sites that bound a SCAN or a page rather than chunking a list they
 * already hold — a `LIMIT` chosen so the ids it can return always fit one
 * statement. Same arithmetic, stated once, so such a bound is visibly derived
 * from the cap rather than looking like a magic number.
 */
export function maxD1InListWidth(fixedBinds: number): number {
  const width = D1_MAX_BOUND_PARAMETERS - fixedBinds;
  return width > 0 ? width : 0;
}
