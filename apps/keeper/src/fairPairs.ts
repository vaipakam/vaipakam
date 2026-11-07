// apps/keeper/src/fairPairs.ts
//
// The matcher's one fairness rule (#3242 part 2): previews are shared across
// CREATORS, never across offers. A wallet that posts many offers must not be
// able to use up a run's preview budget and keep everyone else's offers from
// being looked at.
//
// The walk is split into UNITS. A unit is one pair of counterparties (a lender
// creator and a borrower creator in one bucket for the offer match, or one
// lender intent and a borrower creator for the intent fill), and holds every
// candidate pair of their offers. The walk takes ROUNDS: each round takes the
// next candidate pair from every unit that still has one. So every pair of
// counterparties gets its first preview before any pair gets its second, and a
// creator's offer count buys it nothing: one wallet's 3,000 borrower offers in
// a bucket are one unit per lender creator, the same as an honest borrower's
// single offer.
//
// What this does not bound: many WALLETS. A spammer splitting offers across
// wallets gets one unit per wallet, like anyone else; that is the minimum
// offer size's job (#3242 part 1), not the walk's.
//
// Where round 0 starts is the unit list's business (`pairSpaceFrom`): a run
// usually stops partway through it, so the start must move through the whole
// unit space from run to run, not along each axis separately.
//
// Bounds. Units are read from a lazy iterable, so round 0 builds a unit only
// when it reaches it. Only a unit with candidates left after its first is kept
// for later rounds, and at most `maxLive` of them: later rounds cannot spend
// more than the run's budget, so keeping more would hold memory for work the
// run cannot do. The walk checks `stop` at every step, skipped candidates and
// passed-over units included, so a book of candidates nobody can fill cannot
// outrun the caller's deadline.

/** One pair of counterparties: every `a` against every `b`, `a`-major. */
export interface FairUnit<A, B> {
  readonly as: readonly A[];
  readonly bs: readonly B[];
}

/** How a walk reads the caller's state. Every rule is read lazily, at the
 *  moment a pair is chosen, so a change between pulls (a lender filled, a
 *  borrower left in flight, the deadline reached) holds from the next pull. */
export interface FairPairsOptions<A, B> {
  /** An `a` the walk is done with: passed over whole. */
  readonly deadA?: (a: A) => boolean;
  /** A candidate not worth offering: passed over alone. */
  readonly skip?: (a: A, b: B) => boolean;
  /** True once the walk must end, checked at every step. */
  readonly stop?: () => boolean;
  /** The most units kept for rounds after the first. */
  readonly maxLive?: number;
}

/** Where a unit's walk stands. */
interface Cursor<A, B> {
  unit: FairUnit<A, B>;
  ai: number;
  bi: number;
}

const STOPPED = Symbol('stopped');

/** The unit's next live pair, advancing its cursor; null when it has none,
 *  STOPPED when `stop` ended the search. */
function nextOf<A, B>(
  c: Cursor<A, B>,
  deadA: (a: A) => boolean,
  skip: (a: A, b: B) => boolean,
  stop: () => boolean,
): readonly [A, B] | null | typeof STOPPED {
  const { as, bs } = c.unit;
  while (c.ai < as.length) {
    if (stop()) return STOPPED;
    const a = as[c.ai];
    if (deadA(a)) {
      c.ai += 1;
      c.bi = 0;
      continue;
    }
    while (c.bi < bs.length) {
      if (stop()) return STOPPED;
      const b = bs[c.bi];
      c.bi += 1;
      if (skip(a, b)) continue;
      return [a, b];
    }
    c.ai += 1;
    c.bi = 0;
  }
  return null;
}

/** Whether a cursor still has a candidate by position (the rules may still
 *  pass over it). A unit with none is never kept. */
function hasMore<A, B>(c: Cursor<A, B>): boolean {
  const { as, bs } = c.unit;
  if (c.ai >= as.length) return false;
  return c.bi < bs.length || c.ai + 1 < as.length;
}

/**
 * The candidate pairs of `units`, round-robin across units: round 0 yields
 * each unit's first live pair in unit order, every later round the next live
 * pair of each kept unit still holding one. Each `(a, b)` of a unit is yielded
 * at most once. Pull until the budget is spent and stop; the generator does no
 * work it is not asked for.
 */
export function* fairPairs<A, B>(
  units: Iterable<FairUnit<A, B>>,
  opts: FairPairsOptions<A, B> = {},
): Generator<readonly [A, B], void, undefined> {
  const deadA = opts.deadA ?? (() => false);
  const skip = opts.skip ?? (() => false);
  const stop = opts.stop ?? (() => false);
  const maxLive = opts.maxLive ?? Number.POSITIVE_INFINITY;
  let live: Cursor<A, B>[] = [];
  for (const unit of units) {
    if (stop()) return;
    const c: Cursor<A, B> = { unit, ai: 0, bi: 0 };
    const pair = nextOf(c, deadA, skip, stop);
    if (pair === STOPPED) return;
    if (pair === null) continue;
    yield pair;
    if (live.length < maxLive && hasMore(c)) live.push(c);
  }
  while (live.length > 0) {
    const still: Cursor<A, B>[] = [];
    for (const c of live) {
      const pair = nextOf(c, deadA, skip, stop);
      if (pair === STOPPED) return;
      if (pair === null) continue;
      yield pair;
      if (hasMore(c)) still.push(c);
    }
    live = still;
  }
}

/**
 * The cells of a list of grids, read as one sequence and started at `start`
 * (wrapping), lazily. `sizes[g]` is grid g's `[rows, cols]`; each cell is
 * yielded as `[g, row, col]`.
 *
 * Round 0 of a {@link fairPairs} walk over a book's units usually ends partway,
 * so where it starts decides which units are reached at all. Rotating the rows
 * and the columns separately by the same step keeps their relative offset
 * fixed, and a run that ends within one row then only ever reaches the same
 * band of columns (Codex #3274 r1). Starting in the whole cell space, at a
 * point that moves with the run (`walkStart`), reaches every cell in turn.
 */
export function* pairSpaceFrom(
  sizes: readonly (readonly [number, number])[],
  start: number,
): Generator<readonly [number, number, number]> {
  const offsets: number[] = [];
  let total = 0;
  for (const [rows, cols] of sizes) {
    offsets.push(total);
    total += rows * cols;
  }
  if (total === 0) return;
  const first = ((start % total) + total) % total;
  let g = 0;
  for (let k = 0; k < total; k += 1) {
    const idx = (first + k) % total;
    if (k === 0 || idx === 0) {
      // Locate the grid once, then advance with the walk.
      g = 0;
      while (g + 1 < offsets.length && offsets[g + 1] <= idx) g += 1;
    }
    while (g + 1 < offsets.length && offsets[g + 1] <= idx) g += 1;
    const local = idx - offsets[g];
    const cols = sizes[g][1];
    yield [g, Math.floor(local / cols), local % cols];
  }
}
