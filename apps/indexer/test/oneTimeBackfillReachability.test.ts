/**
 * One-time backfills must be reachable on EVERY path out of the chain
 * scan (Codex #1507 r2 P1).
 *
 * Both `ensureRewardLoopBackfill` and `ensureRecycleSeriesBackfill` seed a
 * projection from history the shared cursor has already passed. A deploy
 * landing on an already-caught-up chain takes the early return in
 * `runChainIndexerForChain` and scans nothing — so a backfill invoked only
 * from the scanning path never runs, and the metric serves an empty series
 * until an unrelated future log happens to arrive.
 *
 * That is not hypothetical: the recycling backfill shipped inside the
 * ingest helper, which the caught-up path does not reach, and the PR
 * claimed it ran "unconditionally". The behavioural tests could not see
 * it, because they call the ingest helper directly and so bypass the
 * caller's control flow entirely.
 *
 * This pins the structural property instead: every one-time backfill is
 * invoked BEFORE the first `return` in `runChainIndexerForChain`. A guard
 * on the call graph rather than on behaviour is the right shape here —
 * the defect is reachability, and reachability is what a behavioural test
 * of a directly-invoked helper cannot establish.
 *
 * Adding a new one-time backfill? Add it to `ONE_TIME_BACKFILLS` and call
 * it in the same block as the others.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ONE_TIME_BACKFILLS = [
  'ensureRewardLoopBackfill',
  'ensureRecycleSeriesBackfill',
];

const SOURCE = readFileSync(
  new URL('../src/chainIndexer.ts', import.meta.url),
  'utf8',
);

/** Body of `runChainIndexerForChain` up to its FIRST `return` of ANY
 *  form. Codex #1527 r1 caught the original single-pattern version
 *  (`return {` only) missing the `return emptyResult(...)` identity
 *  aborts — a whole exit family the guard was blind to — so this now
 *  cuts at the earliest match across every return shape the function
 *  uses, and the guard-the-guard below rejects a prologue containing
 *  ANY return statement. */
function prologue(): string {
  const start = SOURCE.indexOf('export async function runChainIndexerForChain');
  expect(
    start,
    'runChainIndexerForChain not found — this guard has drifted from the source',
  ).toBeGreaterThan(-1);
  const returnAt = SOURCE.slice(start).search(/\n\s+return[ ;(]/);
  expect(
    returnAt,
    'no early return found — if the exit paths were restructured, ' +
      'reconfirm this guard still asserts something',
  ).toBeGreaterThan(-1);
  return SOURCE.slice(start, start + returnAt);
}

describe('one-time backfills are reachable on every exit path', () => {
  for (const fn of ONE_TIME_BACKFILLS) {
    it(`${fn} is awaited before the first return`, () => {
      expect(prologue()).toContain(`await ${fn}(env, chainId)`);
    });
  }

  it('the prologue really does precede the first early return', () => {
    // Guards the guard: if the slice above ever stopped ending at the
    // FIRST return, the assertions would pass vacuously against the
    // whole function. The earliest exit today is the #1415 identity
    // abort — the backfills must sit above even that (they replay only
    // D1 data; an RPC problem is no reason to skip them).
    const p = prologue();
    expect(p).toContain('verifyRpcChainIdentity(');
    expect(p.match(/\n\s+return[ ;(]/)).toBeNull();
    expect(p.match(/\n\s+return \{/)).toBeNull();
  });
});
