import { describe, expect, it } from 'vitest';
import { publishAutoLifecycleStep, resetAutoLifecycleSteps } from '../src/autoLifecycle';

function fakeDb(batches: unknown[][][]): D1Database {
  return {
    prepare(sql: string) {
      expect(sql).toMatch(/INSERT INTO keeper_step_status/);
      return { bind: (...v: unknown[]) => v };
    },
    async batch(stmts: unknown[][]) {
      batches.push(stmts);
      return [];
    },
  } as unknown as D1Database;
}

describe('the auto-extend status the app reads (#3763)', () => {
  const chain = { id: 84532, diamond: '0x2c300b26bc15359E7948dA61a1960303772b0335' };
  const d = '0x2c300b26bc15359e7948da61a1960303772b0335';

  it('publishes extend armed or not, and again at once when it changes', async () => {
    resetAutoLifecycleSteps();
    const batches: unknown[][][] = [];
    const db = fakeDb(batches);
    await publishAutoLifecycleStep(db, chain, false, 1_000);
    await publishAutoLifecycleStep(db, chain, false, 1_010); // unchanged, not due
    await publishAutoLifecycleStep(db, chain, true, 1_020); // changed: at once
    expect(batches).toEqual([
      [[84532, d, 'autoLifecycle', 'extend', 0, 1_000]],
      [[84532, d, 'autoLifecycle', 'extend', 1, 1_020]],
    ]);
  });
});
