import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planRemitBatch } from '../src/rewardBudgetRemit';

/**
 * The keeper's day-count bound, and the two things that can go wrong with it.
 *
 * `LibRewardCustody.requireRemittableFanout` refuses a remittance naming more
 * days than the destination can retire at once, on the SEND and on its fee
 * QUOTE alike. The keeper builds those batches, and until Codex #2232 r4 it
 * bounded them only by VPFI: a keeper outage or a run of delayed commitment
 * reports leaves many owed days carrying small slices, which fits the monetary
 * cap comfortably and names far more than 32 days. The quote then reverted
 * before anything was sent, and the next tick rebuilt the same batch — a
 * mirror unfunded indefinitely.
 *
 * Two failure modes, a test for each:
 *
 *   1. DRIFT. The cap lives as a figure in two languages. Solidity is the
 *      authority — it is the one that reverts — so this reads the constant out
 *      of the contract source and pins the keeper's copy to it. Raising the
 *      cap on chain without raising it here leaves the keeper bounded by a
 *      limit that no longer exists; lowering it on chain without lowering it
 *      here puts the keeper straight back into the wedge.
 *
 *   2. THE BOUND ITSELF, driven through `planRemitBatch` — the function the
 *      pass itself calls, not a restatement of it. Including the detail that
 *      made a VPFI-only bound insufficient: close-only days ride along free on
 *      the monetary cap but still occupy a place in the day list the
 *      destination has to retire.
 */
const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const KEEPER_SRC = join(REPO_ROOT, 'apps/keeper/src/rewardBudgetRemit.ts');
const LIB_SRC = join(REPO_ROOT, 'contracts/src/libraries/LibRewardCustody.sol');
const LANE_CAP = 50_000n * 10n ** 18n;
const ONE = 10n ** 18n;

function capFrom(path: string, pattern: RegExp): number {
  const m = readFileSync(path, 'utf8').match(pattern);
  if (!m) throw new Error(`TRANSPORT_DAY_FANOUT_CAP not found in ${path}`);
  return Number(m[1]);
}

const solidityCap = () => capFrom(LIB_SRC, /TRANSPORT_DAY_FANOUT_CAP\s*=\s*(\d+)\s*;/);
const keeperCap = () => capFrom(KEEPER_SRC, /const TRANSPORT_DAY_FANOUT_CAP\s*=\s*(\d+)\s*;/);

const days = (n: number, from = 1000) => Array.from({ length: n }, (_, i) => BigInt(from + i));

describe('reward-budget remittance fan-out cap', () => {
  it('matches the Solidity constant that enforces it', () => {
    expect(keeperCap()).toBe(solidityCap());
  });

  it('bounds a batch of many small days that fits the lane cap comfortably', () => {
    const cap = solidityCap();
    // 45 days — the default lookback — each carrying 1 VPFI against a 50k
    // lane. The monetary cap is nowhere near binding; the day count is.
    const window = days(45);
    const { batch, deferred } = planRemitBatch(
      window,
      window.map(() => ONE),
      window.map(() => false),
      LANE_CAP,
    );
    expect(batch.length).toBe(cap);
    expect(deferred).toBe(45 - cap);
    // A PREFIX of the window, so the next tick takes the next slice rather
    // than re-offering the same days for ever.
    expect(batch).toEqual(window.slice(0, cap));
  });

  it('counts close-only riders against the cap, because the destination does', () => {
    const cap = solidityCap();
    // The first `cap` days are close-only (zero amount, closeable) — free on
    // the VPFI cap, and exactly what a lane-cap-only bound lets through on top
    // of a full batch. Two funded days follow.
    const window = days(cap + 2, 2000);
    const { batch, deferred } = planRemitBatch(
      window,
      window.map((_, i) => (i < cap ? 0n : ONE)),
      window.map((_, i) => i < cap),
      LANE_CAP,
    );
    expect(batch.length).toBe(cap);
    expect(deferred).toBe(2);
  });

  it('leaves a within-cap window whole', () => {
    const cap = solidityCap();
    const window = days(cap, 3000);
    const { batch, deferred } = planRemitBatch(
      window,
      window.map(() => ONE),
      window.map(() => false),
      LANE_CAP,
    );
    expect(batch.length).toBe(cap);
    expect(deferred).toBe(0);
  });

  it('still defers on the VPFI cap when that is what binds', () => {
    // Three days, well inside the fan-out cap, each 30 VPFI against a 50 lane.
    const window = days(3, 4000);
    const { batch, total, deferred } = planRemitBatch(
      window,
      window.map(() => 30n * ONE),
      window.map(() => false),
      50n * ONE,
    );
    expect(batch).toEqual([window[0]]);
    expect(total).toBe(30n * ONE);
    expect(deferred).toBe(2);
  });

  it('carries days already dropped while replanning into the same total', () => {
    const window = days(2, 5000);
    const { deferred } = planRemitBatch(
      window,
      window.map(() => ONE),
      window.map(() => false),
      LANE_CAP,
      3,
    );
    expect(deferred).toBe(3);
  });
});
