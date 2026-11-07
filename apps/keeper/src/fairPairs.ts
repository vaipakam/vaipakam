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
// Memory: units are read from a lazy iterable, so round 0 builds a unit only
// when it reaches it, and only the units that still hold a pair after their
// first one are kept for later rounds. A run stops at its preview budget, so
// what is kept is bounded by the previews round 0 paid for, never by the size
// of the book.

/** One pair of counterparties: every `a` against every `b`, `a`-major. */
export interface FairUnit<A, B> {
  readonly as: readonly A[];
  readonly bs: readonly B[];
}

/** Where a unit's walk stands. */
interface Cursor<A, B> {
  unit: FairUnit<A, B>;
  ai: number;
  bi: number;
}

/** The unit's next live pair, advancing its cursor, or null when it has none.
 *  An `a` that `deadA` reports is passed over whole, and a `(a, b)` that
 *  `skip` reports is passed over alone; neither costs the caller anything. */
function nextOf<A, B>(
  c: Cursor<A, B>,
  deadA: (a: A) => boolean,
  skip: (a: A, b: B) => boolean,
): readonly [A, B] | null {
  const { as, bs } = c.unit;
  while (c.ai < as.length) {
    const a = as[c.ai];
    if (deadA(a)) {
      c.ai += 1;
      c.bi = 0;
      continue;
    }
    while (c.bi < bs.length) {
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

/**
 * The candidate pairs of `units`, round-robin across units: round 0 yields
 * each unit's first live pair in unit order, every later round the next live
 * pair of each unit still holding one. Each `(a, b)` of a unit is yielded at
 * most once. `deadA` and `skip` are read lazily, at the moment a pair is
 * chosen, so state the caller changes between pulls (a lender filled, a
 * borrower left in flight) is honoured from the next pull on. Pull until the
 * budget is spent and stop; the generator does no work it is not asked for.
 */
export function* fairPairs<A, B>(
  units: Iterable<FairUnit<A, B>>,
  deadA: (a: A) => boolean = () => false,
  skip: (a: A, b: B) => boolean = () => false,
): Generator<readonly [A, B], void, undefined> {
  let live: Cursor<A, B>[] = [];
  for (const unit of units) {
    const c: Cursor<A, B> = { unit, ai: 0, bi: 0 };
    const pair = nextOf(c, deadA, skip);
    if (pair === null) continue;
    yield pair;
    live.push(c);
  }
  while (live.length > 0) {
    const still: Cursor<A, B>[] = [];
    for (const c of live) {
      const pair = nextOf(c, deadA, skip);
      if (pair === null) continue;
      yield pair;
      still.push(c);
    }
    live = still;
  }
}
