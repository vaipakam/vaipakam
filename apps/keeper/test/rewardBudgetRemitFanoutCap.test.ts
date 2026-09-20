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
 * Three failure modes, and the third is the one the first revision shipped:
 *
 *   1. DRIFT IN THE FIGURE. The cap lives as a number in two languages.
 *      Solidity is the authority — it is the one that reverts — so this reads
 *      the constant out of the contract source and pins the keeper's copy to
 *      it. Raising the cap on chain without raising it here leaves the keeper
 *      bounded by a limit that no longer exists; lowering it on chain without
 *      lowering it here puts the keeper straight back into the wedge.
 *
 *   2. DRIFT IN THE POPULATION (Codex #2232 r5). The bound applies to the
 *      FUNDED days — both the send and the quote trim their payload to those
 *      and call `requireRemittableFanout` on that count — so a close-only day
 *      is outside it. The first revision of this cap had the right number
 *      against the wrong subject: it counted every day in the batch, which
 *      refused batches the chain accepts and, worse, let a plan whose
 *      close-only riders filled the cap drop later days while reporting the
 *      mirror settled. A test on the figure alone cannot catch that, so the
 *      subject is read out of the contract too.
 *
 *   3. THE BOUND ITSELF, driven through `planRemitBatch` — the function the
 *      pass itself calls, not a restatement of it.
 */
const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const KEEPER_SRC = join(REPO_ROOT, 'apps/keeper/src/rewardBudgetRemit.ts');
const LIB_SRC = join(REPO_ROOT, 'contracts/src/libraries/LibRewardCustody.sol');
const REMIT_SRC = join(REPO_ROOT, 'contracts/src/facets/RewardRemittanceFacet.sol');
const LANE_CAP = 50_000n * 10n ** 18n;
const ONE = 10n ** 18n;

function capFrom(path: string, pattern: RegExp): number {
  const m = readFileSync(path, 'utf8').match(pattern);
  if (!m) throw new Error(`TRANSPORT_DAY_FANOUT_CAP not found in ${path}`);
  return Number(m[1]);
}

const solidityCap = () => capFrom(LIB_SRC, /TRANSPORT_DAY_FANOUT_CAP\s*=\s*(\d+)\s*;/);
const keeperCap = () => capFrom(KEEPER_SRC, /const TRANSPORT_DAY_FANOUT_CAP\s*=\s*(\d+)\s*;/);

/** Every argument the send and the quote pass to the on-chain bound. */
function fanoutSubjects(): string[] {
  const src = readFileSync(REMIT_SRC, 'utf8');
  return [...src.matchAll(/requireRemittableFanout\(([^)]*)\)/g)].map((m) => m[1].trim());
}

const days = (n: number, from = 1000) => Array.from({ length: n }, (_, i) => BigInt(from + i));

describe('reward-budget remittance fan-out cap', () => {
  it('matches the Solidity constant that enforces it', () => {
    expect(keeperCap()).toBe(solidityCap());
  });

  it('bounds the same POPULATION the contract bounds — funded days', () => {
    // The figure alone is not the rule, and pinning only the figure is how the
    // first revision of this cap shipped with the right number against the
    // wrong subject (Codex #2232 r5). Both `remitRewardBudget` and
    // `quoteRemittanceFee` trim their payload to the funded days and apply the
    // bound to THAT count, so a close-only day is outside it.
    const subjects = fanoutSubjects();
    expect(subjects.length).toBeGreaterThanOrEqual(2); // the send and the quote
    for (const subject of subjects) {
      expect(subject.toLowerCase()).toContain('fundedcount');
    }
  });

  it('bounds FUNDED days even when close-only riders share the batch', () => {
    const cap = solidityCap();
    // 10 riders, then 45 funded days. The riders do not consume the bound, so
    // a full `cap` of funded days still lands.
    const riders = 10;
    const fundedDays = 45;
    const window = days(riders + fundedDays, 7000);
    const { batch, deferred } = planRemitBatch(
      window,
      window.map((_, i) => (i < riders ? 0n : ONE)),
      window.map((_, i) => i < riders),
      LANE_CAP,
    );
    expect(batch.length).toBe(riders + cap);
    expect(deferred).toBe(fundedDays - cap);
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

  it('lets close-only riders past the cap — they never reach the destination list', () => {
    const cap = solidityCap();
    // More close-only days (zero amount, closeable) than the cap, then two
    // funded ones. The riders are trimmed out of the destination payload on
    // chain, so they are outside the bound; counting them would refuse a batch
    // the chain accepts.
    const riders = cap + 5;
    const window = days(riders + 2, 2000);
    const { batch, deferred } = planRemitBatch(
      window,
      window.map((_, i) => (i < riders ? 0n : ONE)),
      window.map((_, i) => i < riders),
      LANE_CAP,
    );
    expect(batch.length).toBe(riders + 2); // every rider, plus both funded days
    expect(deferred).toBe(0);
  });

  it('never reports a truncated plan as a settled one', () => {
    // The r5 defect: with the cap counting every day, a plan whose riders
    // filled it dropped every later day — and the deferral count only ever
    // counts positive slices, so `remitToMirror` reported the mirror COMPLETE
    // with funded days still owed. Whatever else changes, a plan that leaves a
    // funded day behind must leave `deferred` non-zero.
    const cap = solidityCap();
    const riders = cap + 5;
    const funded = 3;
    const window = days(riders + funded, 6000);
    const { batch, deferred } = planRemitBatch(
      window,
      window.map((_, i) => (i < riders ? 0n : ONE)),
      window.map((_, i) => i < riders),
      // A lane cap that admits exactly one funded day, so two are left behind.
      ONE,
    );
    expect(batch.length).toBe(riders + 1);
    expect(deferred).toBe(funded - 1);
    expect(deferred).toBeGreaterThan(0);
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
