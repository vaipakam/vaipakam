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

/** Body of `runChainIndexerForChain` up to its FIRST `return`. */
function prologue(): string {
  const start = SOURCE.indexOf('export async function runChainIndexerForChain');
  expect(
    start,
    'runChainIndexerForChain not found — this guard has drifted from the source',
  ).toBeGreaterThan(-1);
  const firstReturn = SOURCE.indexOf('\n    return {', start);
  expect(
    firstReturn,
    'no early return found — if the caught-up path was restructured, ' +
      'reconfirm this guard still asserts something',
  ).toBeGreaterThan(start);
  return SOURCE.slice(start, firstReturn);
}

describe('one-time backfills are reachable on the caught-up path', () => {
  for (const fn of ONE_TIME_BACKFILLS) {
    it(`${fn} is awaited before the first return`, () => {
      expect(prologue()).toContain(`await ${fn}(env, chainId)`);
    });
  }

  it('the prologue really does precede the caught-up early return', () => {
    // Guards the guard: if the slice above ever stopped ending at the
    // quiet-path return, every assertion here would pass vacuously
    // against the whole function.
    const p = prologue();
    expect(p).toContain('if (scanFrom > head) {');
    expect(p.match(/\n    return \{/)).toBeNull();
  });
});
