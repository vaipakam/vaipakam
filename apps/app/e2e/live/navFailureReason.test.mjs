/**
 * A route that ran out of time was reported as a bare "DID NOT LOAD",
 * which reads as a broken route — and in the run that prompted this, the
 * evidence that it was not broken sat one line below, in the same output
 * (#2109). An expired deadline means the sweep OBSERVED NOTHING about
 * that route. A broken route is something it observed. The row was
 * making the second claim on the first one's evidence.
 *
 * The two sibling cases — an HTTP error document and a redirect — have
 * said why since they were written. Only the navigation case never did.
 */
import { describe, expect, it } from 'vitest';

import { navFailureReason } from './driver.mjs';

describe('#2109 — a timeout says it timed out', () => {
  const BUDGET = 45_000;

  it('names the deadline, and says the route was not observed', () => {
    const why = navFailureReason(
      'TimeoutError: page.goto: Timeout 45000ms exceeded.\n  at /home/runner/x.mjs:1',
      BUDGET,
    );
    expect(why).toContain('timed out');
    // The BUDGET, not the elapsed figure: `45002ms` only means something
    // once you know what the route was allowed.
    expect(why).toContain('45s budget');
    expect(why).toContain('NOT OBSERVED');
  });

  it('cites whatever budget it was given, rather than a baked-in figure', () => {
    expect(navFailureReason('Timeout 9000ms exceeded', 9_000)).toContain('9s budget');
  });

  it('reports an unrecognised failure as itself, without guessing', () => {
    const why = navFailureReason('Error: net::ERR_CONNECTION_REFUSED at https://app.example', BUDGET);
    expect(why).toContain('ERR_CONNECTION_REFUSED');
    // Not classified as a timeout, and not given a category it has not
    // earned — inventing one would be this defect in a new place.
    expect(why).not.toContain('timed out');
    expect(why).not.toContain('NOT OBSERVED');
  });

  it('keeps the row to one line, however long the error', () => {
    const why = navFailureReason(`Error: ${'x'.repeat(400)}\nsecond line`, BUDGET);
    expect(why).not.toContain('\n');
    expect(why).not.toContain('second line');
    expect(why.length).toBeLessThan(160);
  });

  it('says nothing when the navigation did not fail', () => {
    expect(navFailureReason(null, BUDGET)).toBeNull();
  });
});
