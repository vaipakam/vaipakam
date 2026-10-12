/**
 * #2422 r10 — RULE 1: a rendered observation is judged only against chain
 * config that held still around it.
 */
import { describe, expect, it } from 'vitest';

import { configChanges, observationVerdict, observeAgainstChain } from './observation.mjs';

const CONFIG = { paused: false, autoRefinance: true, partialFill: true, treasuryFeeBps: 200n, lifBps: 20n, graceBuckets: [] };

/** A readConfig that returns each queued reading in turn, logging calls. */
function reader(readings, log) {
  let i = 0;
  return async () => {
    log.push('read');
    const r = readings[Math.min(i++, readings.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
}

describe('observeAgainstChain', () => {
  it('reads the config before and after the observation, in that order', async () => {
    const log = [];
    const r = await observeAgainstChain({
      baseline: CONFIG,
      readConfig: reader([CONFIG, CONFIG], log),
      observe: async () => {
        log.push('observe');
        return 'banner: on';
      },
    });
    expect(log).toEqual(['read', 'observe', 'read']);
    expect(r).toEqual({ state: 'stable', config: CONFIG, observed: 'banner: on' });
  });

  it('a change DURING the observation is a race', async () => {
    const r = await observeAgainstChain({
      baseline: CONFIG,
      readConfig: reader([CONFIG, { ...CONFIG, treasuryFeeBps: 300n }], []),
      observe: async () => 'x',
    });
    expect(r.state).toBe('race');
    expect(r.changes).toEqual(['during the observation, treasuryFeeBps: "200n" → "300n"']);
  });

  it('a change SINCE the preflight is a race too — the page may have rendered the older value', async () => {
    const moved = { ...CONFIG, graceBuckets: [{ maxDurationDays: 10n, graceSeconds: 5n }] };
    const r = await observeAgainstChain({ baseline: CONFIG, readConfig: reader([moved, moved], []), observe: async () => 'x' });
    expect(r.state).toBe('race');
    expect(r.changes[0]).toMatch(/^since the preflight, graceBuckets: /);
  });

  it('an unreadable config is reported as such, before or after', async () => {
    const before = await observeAgainstChain({ readConfig: reader([new Error('rpc down')], []), observe: async () => 'x' });
    expect(before).toEqual({ state: 'unreadable', error: 'config read before the observation failed: rpc down' });
    const after = await observeAgainstChain({ readConfig: reader([CONFIG, new Error('rpc down')], []), observe: async () => 'x' });
    expect(after.state).toBe('unreadable');
    expect(after.error).toMatch(/after the observation failed: rpc down/);
  });

  it('an observation that THROWS is still followed by its after-read, and then classified (#2434 r2)', async () => {
    const boom = new Error('banner locator timed out');
    // The config MOVED around the failed observation: a race carrying the error.
    const log = [];
    const moved = await observeAgainstChain({
      baseline: CONFIG,
      readConfig: reader([CONFIG, { ...CONFIG, paused: true }], log),
      observe: async () => {
        log.push('observe');
        throw boom;
      },
    });
    expect(log).toEqual(['read', 'observe', 'read']);
    expect(moved).toMatchObject({ state: 'race', observeError: 'banner locator timed out' });
    expect(moved.changes).toEqual(['during the observation, paused: false → true']);
    expect(observationVerdict(moved, { wrote: false, what: 'the banner' }).action).toBe('blocked');
    const after = observationVerdict(moved, { wrote: true, what: 'the banner' });
    expect(after.action).toBe('undetermined');
    expect(after.why).toMatch(/the observation itself failed meanwhile: banner locator timed out$/);
    // The config HELD: the observation's own error, rethrown unchanged — after the after-read.
    const log2 = [];
    await expect(
      observeAgainstChain({
        baseline: CONFIG,
        readConfig: reader([CONFIG, CONFIG], log2),
        observe: async () => {
          log2.push('observe');
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(log2).toEqual(['read', 'observe', 'read']);
    // The after-read itself failed: unreadable, still carrying the observation's error.
    const unreadable = await observeAgainstChain({
      readConfig: reader([CONFIG, new Error('rpc down')], []),
      observe: async () => {
        throw boom;
      },
    });
    expect(unreadable).toMatchObject({ state: 'unreadable', observeError: 'banner locator timed out' });
  });
});

describe('observationVerdict', () => {
  const race = { state: 'race', changes: ['during the observation, paused: false → true'] };
  it('judges a stable observation against the config read around it', () => {
    expect(observationVerdict({ state: 'stable', config: CONFIG }, { wrote: true, what: 'x' })).toEqual({ action: 'judge', config: CONFIG });
  });
  it('a race before any write is BLOCKED; after a write it is UNDETERMINED — never a FAIL', () => {
    expect(observationVerdict(race, { wrote: false, what: 'the banner' }).action).toBe('blocked');
    const u = observationVerdict(race, { wrote: true, what: 'the banner' });
    expect(u.action).toBe('undetermined');
    expect(u.why).toMatch(/the banner is judged against moved \(during the observation, paused: false → true\) — a state race/);
    expect(observationVerdict({ state: 'unreadable', error: 'e' }, { wrote: true, what: 'x' }).action).toBe('undetermined');
    expect(observationVerdict({ state: 'unreadable', error: 'e' }, { wrote: false, what: 'x' }).action).toBe('blocked');
  });
});

describe('configChanges', () => {
  it('names changed and one-sided keys; empty when equal', () => {
    expect(configChanges(CONFIG, { ...CONFIG })).toEqual([]);
    expect(configChanges({ a: 1 }, { a: 1, b: 2 })).toEqual(['b: undefined → 2']);
  });
});
