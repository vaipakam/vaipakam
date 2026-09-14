import { describe, it, expect } from 'vitest';
import { confirmWrite, unconfirmedWhy } from './writeConfirm.mjs';

/**
 * The three answers are the point of the module, so each one is pinned
 * here — including the distinction the bug in #2107 collapsed: a state
 * that is WRONG and a state nobody would tell us about are not the same
 * result and must not produce the same verdict.
 */

/** A fake clock: `now` advances only when `sleep` is called, so a test
 *  can exhaust a deadline deterministically without waiting. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

const base = (over = {}) => ({
  minBlock: 100n,
  accept: (v) => v === 'done',
  timeoutMs: 30,
  everyMs: 10,
  ...fakeClock(),
  ...over,
});

describe('confirmWrite', () => {
  it('confirms when a node at or after the write answers acceptably', async () => {
    const r = await confirmWrite(
      base({ getBlockNumber: async () => 101n, read: async () => 'done' }),
    );
    expect(r.ok).toBe(true);
    expect(r.blockNumber).toBe(101n);
  });

  it('pins the read to the head it checked, not to some later block', async () => {
    const seen = [];
    // The head is deliberately ABOVE minBlock, so a read pinned to the
    // head and one pinned to minBlock are distinguishable. With the two
    // equal this assertion cannot tell them apart, and reading at
    // minBlock is the wrong one: a node whose head is 105 need not
    // still serve state at 100 on a pruning backend.
    await confirmWrite(
      base({
        minBlock: 100n,
        getBlockNumber: async () => 105n,
        read: async (bn) => {
          seen.push(bn);
          return 'done';
        },
      }),
    );
    expect(seen).toEqual([105n]);
  });

  it('reports a wrong value as a DEFECT, not as unconfirmed', async () => {
    const r = await confirmWrite(
      base({ getBlockNumber: async () => 100n, read: async () => 'still-open' }),
    );
    expect(r.ok).toBe(false);
    expect(r.unconfirmed).toBe(false);
    expect(r.value).toBe('still-open');
  });

  it('does NOT poll a wrong value through — one read decides it', async () => {
    // The chain at or after the write's own block is settled, so a
    // second look is not a second chance. If this ever starts retrying,
    // the helper has become a way to wait out real defects.
    let reads = 0;
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 100n,
        read: async () => {
          reads += 1;
          return reads > 1 ? 'done' : 'still-open';
        },
      }),
    );
    expect(reads).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.unconfirmed).toBe(false);
  });

  it('retries past a node whose head is behind the write', async () => {
    // This is the #2107 race itself: the first node has not applied the
    // block the receipt came from. It must not answer.
    const heads = [98n, 99n, 101n];
    let i = 0;
    const readAt = [];
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => heads[i++],
        read: async (bn) => {
          readAt.push(bn);
          return 'done';
        },
      }),
    );
    expect(r.ok).toBe(true);
    // The stale nodes were never read from — that is what stops the
    // pre-write value being mistaken for the post-write one.
    expect(readAt).toEqual([101n]);
  });

  it('retries a read that throws, and confirms on a later attempt', async () => {
    let calls = 0;
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 100n,
        read: async () => {
          calls += 1;
          if (calls === 1) throw new Error('header not found');
          return 'done';
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('returns UNCONFIRMED when no node ever reaches the block', async () => {
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 99n,
        read: async () => {
          throw new Error('must not be read from a stale node');
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.unconfirmed).toBe(true);
    expect(r.why).toMatch(/COULD NOT CONFIRM/);
    // The message must not be readable as a claim about the chain.
    expect(r.why).toMatch(/says nothing about whether the write took effect/);
  });

  it('returns UNCONFIRMED when every read errors', async () => {
    const r = await confirmWrite(
      base({
        getBlockNumber: async () => 100n,
        read: async () => {
          throw new Error('rate limited');
        },
      }),
    );
    expect(r.unconfirmed).toBe(true);
    expect(r.why).toMatch(/rate limited/);
  });

  it('lets a throwing predicate propagate rather than blaming the endpoint', async () => {
    // A predicate that throws is a bug in the caller — a field that
    // moved, a shape it did not expect. Retrying it to the deadline and
    // then reporting "no node would answer" would report the drive's own
    // mistake as an infrastructure problem.
    await expect(
      confirmWrite(
        base({
          getBlockNumber: async () => 100n,
          read: async () => ({}),
          accept: (v) => v.missing.field === 1,
        }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it('asks once even with no budget at all', async () => {
    let asked = 0;
    const r = await confirmWrite(
      base({
        timeoutMs: 0,
        getBlockNumber: async () => {
          asked += 1;
          return 100n;
        },
        read: async () => 'done',
      }),
    );
    expect(asked).toBe(1);
    expect(r.ok).toBe(true);
  });

  it('gives up rather than looping forever', async () => {
    let asked = 0;
    const r = await confirmWrite(
      base({
        timeoutMs: 100,
        everyMs: 10,
        getBlockNumber: async () => {
          asked += 1;
          return 1n;
        },
      }),
    );
    expect(r.unconfirmed).toBe(true);
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThan(50);
  });
});

describe('unconfirmedWhy', () => {
  it('names a stale-node run and an erroring run differently', () => {
    const stale = unconfirmedWhy({ what: 'x', minBlock: 7n, behind: 3, lastErr: null, timeoutMs: 1000 });
    const erroring = unconfirmedWhy({
      what: 'x',
      minBlock: 7n,
      behind: 0,
      lastErr: new Error('boom'),
      timeoutMs: 1000,
    });
    expect(stale).toMatch(/3 attempts reached a node still behind/);
    expect(erroring).toMatch(/last error: boom/);
    expect(stale).not.toEqual(erroring);
  });

  it('reports BOTH causes when a run hit both', () => {
    const s = unconfirmedWhy({
      what: 'x',
      minBlock: 7n,
      behind: 2,
      lastErr: new Error('boom'),
      timeoutMs: 1000,
    });
    expect(s).toMatch(/behind/);
    expect(s).toMatch(/boom/);
  });

  it('keeps a multi-line error to its first line', () => {
    const s = unconfirmedWhy({
      what: 'x',
      minBlock: 7n,
      behind: 0,
      lastErr: new Error('short reason\nstack frame\nstack frame'),
      timeoutMs: 1000,
    });
    expect(s).toMatch(/short reason/);
    expect(s).not.toMatch(/stack frame/);
  });
});
