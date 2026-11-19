import { describe, expect, it } from 'vitest';
import type { ChainConfig } from '../src/env';
import { armedMatcherSteps, publishMatcherSteps, resetMatcherSteps } from '../src/matcher';
import { txFeeUnpricedReason } from '../src/txFee';

/** A chain whose fee the keeper can value, and an id it knows nothing about. */
const PRICED = 84532;
const UNPRICED = 999_999_991;

describe('the re-lend status the app reads (#3763)', () => {
  it('uses chains whose fee pricing is as assumed', () => {
    expect(txFeeUnpricedReason(PRICED)).toBeNull();
    expect(txFeeUnpricedReason(UNPRICED)).not.toBeNull();
  });

  it('arms roll only while the matcher is armed and the chain fee can be valued', () => {
    expect([...armedMatcherSteps(true, PRICED)]).toEqual(['roll']);
    expect([...armedMatcherSteps(false, PRICED)]).toEqual([]);
    expect([...armedMatcherSteps(true, UNPRICED)]).toEqual([]);
  });

  it('publishes the roll step of every chain with a Diamond, armed or not', async () => {
    resetMatcherSteps();
    const batches: unknown[][][] = [];
    const db = {
      prepare(sql: string) {
        expect(sql).toMatch(/INSERT INTO keeper_step_status/);
        return { bind: (...v: unknown[]) => v };
      },
      async batch(stmts: unknown[][]) {
        batches.push(stmts);
        return [];
      },
    } as unknown as D1Database;
    const chains = [
      { id: PRICED, diamond: '0x2c300b26bc15359E7948dA61a1960303772b0335' },
      { id: UNPRICED, diamond: '0x0EBd0536a698707958e1c327Ba1EB2b4f329A119' },
      { id: 1, diamond: '' },
    ] as unknown as ChainConfig[];
    await publishMatcherSteps(db, chains, true, 1_000);
    expect(batches).toEqual([
      [[PRICED, '0x2c300b26bc15359e7948da61a1960303772b0335', 'matcher', 'roll', 1, 1_000]],
      [[UNPRICED, '0x0ebd0536a698707958e1c327ba1eb2b4f329a119', 'matcher', 'roll', 0, 1_000]],
    ]);
  });
});
