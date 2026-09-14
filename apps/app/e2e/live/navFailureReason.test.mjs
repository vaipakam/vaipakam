/**
 * A route that ran out of time was reported as a bare "DID NOT LOAD",
 * which reads as a broken route (#2109). Its two sibling cases — an HTTP
 * error document and a redirect — have said why since they were written.
 * Only the navigation case never did.
 *
 * The wording is the whole subject here, so the tests are about what it
 * may and may not CLAIM. Two limits were found by review rather than by
 * writing it:
 *
 *   - whether the deadline expired is decided from the error's IDENTITY
 *     at the catch site, never from its text, so this takes the answer
 *     rather than a message to match against;
 *   - a timed-out load may still have observed plenty (the document
 *     committed, responses arrived, console errors were recorded), so it
 *     claims the LOAD did not complete — not that nothing was seen.
 */
import { describe, expect, it } from 'vitest';

import { navFailureReason } from './navFailure.mjs';

describe('#2109 — a timeout says it timed out, and no more', () => {
  const BUDGET = 45_000;

  it('names the deadline that expired', () => {
    const why = navFailureReason({ timedOut: true, message: 'anything' }, BUDGET);
    expect(why).toContain('timed out');
    // The BUDGET, not the elapsed figure: `45002ms` only means something
    // once you know what the route was allowed.
    expect(why).toContain('45s budget');
  });

  it('claims the load did not complete, NOT that nothing was observed', () => {
    const why = navFailureReason({ timedOut: true, message: '' }, BUDGET);
    expect(why).toContain('NOT FULLY REVIEWED');
    // A `load` deadline can expire after the document committed and the
    // sweep recorded responses and console errors — whose counters are
    // printed on this very row. Saying the route was not observed would
    // contradict the numbers beside it.
    expect(why).not.toContain('NOT OBSERVED');
  });

  it('cites whatever budget it is given, not a baked-in figure', () => {
    expect(navFailureReason({ timedOut: true, message: '' }, 9_000)).toContain('9s budget');
  });

  it('does not read a timeout out of the message text', () => {
    // The identity says it was not a timeout; the words say otherwise.
    // Trusting the words would hand a real defect an infrastructure
    // excuse, which is the dangerous direction.
    const why = navFailureReason(
      { timedOut: false, message: 'Error: navigating to /timeout-exceeded failed' },
      BUDGET,
    );
    expect(why).toContain('navigation failed');
    expect(why).not.toContain('timed out');
    expect(why).not.toContain('NOT FULLY REVIEWED');
  });

  it('reports an unrecognised failure as itself, without guessing', () => {
    const why = navFailureReason(
      { timedOut: false, message: 'Error: net::ERR_CONNECTION_REFUSED at https://app.example' },
      BUDGET,
    );
    expect(why).toContain('ERR_CONNECTION_REFUSED');
  });

  it('keeps the row to one line, however long the error', () => {
    const why = navFailureReason(
      { timedOut: false, message: `Error: ${'x'.repeat(400)}\nsecond line` },
      BUDGET,
    );
    expect(why).not.toContain('\n');
    expect(why).not.toContain('second line');
    expect(why.length).toBeLessThan(160);
  });

  it('survives an absent message rather than printing undefined', () => {
    expect(navFailureReason({ timedOut: false, message: null }, BUDGET)).toBe(
      'navigation failed: ',
    );
  });
});
