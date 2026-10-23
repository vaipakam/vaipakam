import { describe, expect, it } from 'vitest';
import { awaitSurface, notReadyReason, surfaceStateOf } from './readiness.mjs';

const main = (textLength, placeholderCount = 0, otherTextLength = textLength) => ({
  hasMain: true,
  textLength,
  placeholderCount,
  otherTextLength,
});

describe('surfaceStateOf', () => {
  it('reads the route fallback as loading, not as a rendered page (#2111)', () => {
    // "Loading…" is 8 characters, all of them the placeholder's own.
    expect(surfaceStateOf(main(8, 1, 0))).toBe('loading');
  });

  it('reads a page with a rendered heading beside a loading card as rendered', () => {
    expect(surfaceStateOf(main(120, 1, 100))).toBe('rendered');
  });

  it('reads an empty state with no spinner as rendered — it is a settled answer', () => {
    expect(surfaceStateOf(main(40, 0, 40))).toBe('rendered');
  });

  it('reads a missing landmark, empty text and a failed snapshot as not ready', () => {
    expect(surfaceStateOf({ hasMain: false })).toBe('unmounted');
    expect(surfaceStateOf(main(0))).toBe('empty');
    expect(surfaceStateOf({ error: 'Execution context was destroyed' })).toBe('unreadable');
    expect(surfaceStateOf(null)).toBe('unreadable');
  });
});

/** A page whose snapshots are scripted, one per poll. */
function scriptedPage(snaps) {
  let i = 0;
  return {
    async evaluate() {
      const s = snaps[Math.min(i, snaps.length - 1)];
      i += 1;
      if (s instanceof Error) throw s;
      return s;
    },
    async waitForTimeout() {},
  };
}

describe('awaitSurface', () => {
  it('waits through the placeholder and returns once the route renders', async () => {
    const page = scriptedPage([main(8, 1, 0), main(8, 1, 0), main(300)]);
    const r = await awaitSurface(page, { timeoutMs: 60_000, pollMs: 0 });
    expect(r).toMatchObject({ ready: true, state: 'rendered' });
  });

  it('reports a surface that never rendered as not ready, with its last state', async () => {
    const page = scriptedPage([main(8, 1, 0)]);
    const r = await awaitSurface(page, { timeoutMs: 0, pollMs: 0 });
    expect(r).toMatchObject({ ready: false, state: 'loading' });
    expect(notReadyReason(r)).toMatch(/still showing only its loading placeholder/);
    expect(notReadyReason(r)).toMatch(/not a product finding/);
  });

  it('carries the cause of an unreadable snapshot into the reason', async () => {
    const page = scriptedPage([new Error('Target page, context or browser has been closed')]);
    const r = await awaitSurface(page, { timeoutMs: 0, pollMs: 0 });
    expect(r).toMatchObject({ ready: false, state: 'unreadable' });
    expect(notReadyReason(r)).toMatch(/has been closed/);
  });
});
