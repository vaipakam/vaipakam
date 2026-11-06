import { describe, expect, it } from 'vitest';
import { cleanUpAfterEffect, cleanUpAfterNoEffect, cleanUpLeg } from './cleanUp';
import type { LegOutcome } from './outcome';

const leg = (label: string): LegOutcome => ({ status: 'done', label });

describe("a flow's clean-up legs", () => {
  it('puts back and then releases after a call that did not take effect', async () => {
    const order: string[] = [];
    const legs = await cleanUpAfterNoEffect({
      unwind: async () => (order.push('unwind'), leg('back')),
      release: async () => (order.push('release'), leg('revoked')),
    });
    expect(order).toEqual(['unwind', 'release']);
    expect(legs.map((l) => l.label)).toEqual(['back', 'revoked']);
  });
  it('releases, and never puts back, after a call that took effect', async () => {
    let unwound = false;
    const legs = await cleanUpAfterEffect({
      unwind: async () => ((unwound = true), leg('back')),
      release: async () => leg('revoked'),
    });
    expect(unwound).toBe(false);
    expect(legs.map((l) => l.label)).toEqual(['revoked']);
  });
  it('states a step that threw as not done, and still runs the next one', async () => {
    const legs = await cleanUpAfterNoEffect({
      unwind: async () => {
        throw new Error('rpc down');
      },
      release: async () => leg('revoked'),
    });
    expect(legs).toEqual([{ status: 'not-done', label: 'clean-up', reason: 'rpc down' }, leg('revoked')]);
  });
  it('adds nothing for a flow with no steps, or a step with nothing to do', async () => {
    expect(await cleanUpAfterNoEffect({})).toEqual([]);
    expect(await cleanUpAfterEffect({ release: async () => null })).toEqual([]);
  });
});

describe('a clean-up result as a leg', () => {
  it('keeps all three states, so missing evidence is never read as a failure', () => {
    expect(cleanUpLeg({ status: 'done', sentence: 's' }, 'L')).toEqual({ status: 'done', label: 'L' });
    expect(cleanUpLeg({ status: 'unknown', sentence: 's' }, 'L')).toEqual({ status: 'unknown', label: 'L', reason: 's' });
    expect(cleanUpLeg({ status: 'not-done', sentence: 's' }, 'L')).toEqual({ status: 'not-done', label: 'L', reason: 's' });
  });
});
