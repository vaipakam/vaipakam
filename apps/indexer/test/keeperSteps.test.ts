/** #3681 — `GET /keeper/steps`: which keeper steps a deployment runs. */
import { describe, expect, it } from 'vitest';
import { KEEPER_STEP_STALE_SEC, handleKeeperSteps, readKeeperSteps } from '../src/keeperSteps';

const NOW = 2_000_000_000;
const DIAMOND = '0x63816b149266c9dbfb7683dfd02d851915238049';

function fakeDb(rows: Record<string, unknown>[] | Error) {
  const seen: unknown[][] = [];
  return {
    seen,
    prepare(sql: string) {
      expect(sql).toMatch(/FROM keeper_step_status WHERE chain_id = \?/);
      return {
        bind(...values: unknown[]) {
          seen.push(values);
          return {
            async all<T>() {
              if (rows instanceof Error) throw rows;
              return { results: rows as T[] };
            },
          };
        },
      };
    },
  };
}

const row = (step: string, armed: number, observed_at: number) => ({ pass: 'standingInstructions', step, diamond: DIAMOND, armed, observed_at });

describe('readKeeperSteps', () => {
  it('reads a step as running only when it is armed and said so recently', async () => {
    const db = fakeDb([row('interest', 1, NOW - KEEPER_STEP_STALE_SEC - 1), row('repay', 0, NOW), row('topUp', 1, NOW - KEEPER_STEP_STALE_SEC)]);
    const out = await readKeeperSteps(db, 8453, NOW);
    expect(db.seen).toEqual([[8453]]);
    expect(out.staleAfterSeconds).toBe(KEEPER_STEP_STALE_SEC);
    expect(out.steps.map((s) => [s.step, s.armed, s.running])).toEqual([
      ['interest', true, false],
      ['repay', false, false],
      ['topUp', true, true],
    ]);
    expect(out.steps[0]).toMatchObject({ pass: 'standingInstructions', diamond: DIAMOND, observedAt: NOW - KEEPER_STEP_STALE_SEC - 1 });
  });
});

describe('handleKeeperSteps', () => {
  const get = (q: string) => new Request(`https://indexer.example/keeper/steps${q}`);

  it('requires the chain id', async () => {
    const res = await handleKeeperSteps(get(''), fakeDb([]), NOW);
    expect(res.status).toBe(400);
  });

  it('answers 503, never an empty list, when the table cannot be read', async () => {
    const res = await handleKeeperSteps(get('?chainId=8453'), fakeDb(new Error('no such table: keeper_step_status')), NOW);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('is never cached', async () => {
    const res = await handleKeeperSteps(get('?chainId=8453'), fakeDb([row('topUp', 1, NOW)]), NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).steps[0].running).toBe(true);
  });
});
