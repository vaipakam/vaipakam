import { describe, expect, it } from 'vitest';

import { createInFlight } from './inFlight.mjs';

const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('createInFlight (#1633 item 6)', () => {
  it('passes the wrapped handler its arguments and its result', async () => {
    const reg = createInFlight();
    const handler = reg.track(async (a, b) => a + b);
    await expect(handler(2, 3)).resolves.toBe(5);
    expect(reg.size()).toBe(0);
  });

  it('waits for a handler that is still running', async () => {
    const reg = createInFlight();
    const recorded = [];
    const handler = reg.track(async (id) => {
      await later(30);
      recorded.push(id);
    });
    handler('slow');
    expect(recorded).toEqual([]);
    await expect(reg.drain(1_000)).resolves.toBe(0);
    expect(recorded).toEqual(['slow']);
  });

  it('counts a handler that outlives the bound instead of dropping it', async () => {
    const reg = createInFlight();
    reg.track(() => new Promise(() => {}))();
    reg.track(async () => later(5))();
    await expect(reg.drain(50)).resolves.toBe(1);
  });

  it('treats a handler that rejected as finished', async () => {
    const reg = createInFlight();
    const run = reg.track(async () => {
      throw new Error('boom');
    })();
    await expect(run).rejects.toThrow('boom');
    await expect(reg.drain(50)).resolves.toBe(0);
  });

  it('a handler that throws synchronously still returns a tracked rejection', async () => {
    const reg = createInFlight();
    const run = reg.track(() => {
      throw new Error('sync');
    })();
    await expect(run).rejects.toThrow('sync');
    expect(reg.size()).toBe(0);
  });

  it('resolves at once when nothing is running', async () => {
    await expect(createInFlight().drain(10_000)).resolves.toBe(0);
  });
});

describe('createInFlight keys (#1633 item 6)', () => {
  it('a keyed drain waits only for that key', async () => {
    const reg = createInFlight();
    const handler = reg.track(
      (_key, ms) => (ms === Infinity ? new Promise(() => {}) : later(ms)),
      (key) => key,
    );
    handler('other page', Infinity);
    handler('this page', 20);
    expect(reg.size('this page')).toBe(1);
    expect(reg.size()).toBe(2);
    await expect(reg.drain(500, 'this page')).resolves.toBe(0);
    expect(reg.size('other page')).toBe(1);
  });

  it('does not wait for calls begun during the drain', async () => {
    const reg = createInFlight();
    const handler = reg.track((ms) => later(ms), () => 'page');
    handler(20);
    const draining = reg.drain(500, 'page');
    handler(10_000);
    const started = Date.now();
    await expect(draining).resolves.toBe(0);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('a key that throws leaves the call unkeyed, not untracked', async () => {
    const reg = createInFlight();
    reg.track(
      () => later(20),
      () => {
        throw new Error('no frame');
      },
    )();
    expect(reg.size('page')).toBe(0);
    expect(reg.size()).toBe(1);
    await expect(reg.drain(500)).resolves.toBe(0);
  });
});
