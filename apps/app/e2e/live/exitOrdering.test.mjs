/**
 * The live drive's EXIT ORDERING, asserted against its own source.
 *
 * WHY A SOURCE TEST, which is normally a weak thing to write.
 *
 * `live-position-observe.mjs` ends in a linear sequence of guards, each
 * printing and calling `process.exit`. Their ORDER is the behaviour:
 * whichever matches first decides whether the run reports a product
 * FAIL (1) or an inconclusive BLOCKED (2). #2093 round 38 found that a
 * forced-close card positively observed stating an amount it cannot know
 * — the one absolute claim this drive makes — was reported as BLOCKED
 * whenever any unrelated request had also failed, because `failures` was
 * consulted after the route, WebSocket and wrong-chain gates.
 *
 * That fix is one `if` in a top-level script. It cannot be imported: the
 * module runs the entire drive on import and exits with
 * `SITE_URL is required`. So it lives in exactly the position this PR
 * has now been caught in five times — a branch no test executes, whose
 * correctness rests on a reviewer reading it. Every one of those five
 * read as correct.
 *
 * A source-order assertion cannot prove the branch WORKS. What it does
 * prove is the property the finding was actually about, which is not
 * about the branch's logic at all: that an observed funds defect is
 * ranked ahead of the blockers that would otherwise swallow it. A
 * reorder — the realistic regression, since the guards are a long
 * sequence and new ones get appended — fails here instead of silently
 * downgrading a real finding to "nothing was learned".
 *
 * Extracting the tail so this could be tested properly is tracked with
 * the other extraction (#2120); it is a refactor, and this PR is
 * mid-review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DRIVE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'live-position-observe.mjs',
);

describe('a funds defect that was READ outranks every blocker', () => {
  const src = fs.readFileSync(DRIVE, 'utf8');

  /** Where a guard's condition appears, or -1. */
  const at = (needle) => src.indexOf(needle);

  const FORCED_CLOSE_EXIT = 'if (fcObserved.length) {';
  const ROUTE_EXIT = 'if (routeFailures.length) {';
  const WS_EXIT = 'if (wsRpcMethods.size) {';
  const CHAIN_EXIT = 'if (pageChainWrong.length) {';

  it('every guard this is ranked against still exists', () => {
    // Guards the guard. If one is renamed or removed, the ordering
    // assertions below would pass over a comparison with -1 and say
    // nothing — the vacuous-loop shape this suite has already been
    // caught by twice.
    for (const [name, needle] of [
      ['forced-close', FORCED_CLOSE_EXIT],
      ['route failures', ROUTE_EXIT],
      ['websocket RPC', WS_EXIT],
      ['wrong chain', CHAIN_EXIT],
    ]) {
      expect(at(needle), `${name} guard not found in the drive`).toBeGreaterThan(-1);
    }
  });

  it('reports the observed defect before the transport blocker', () => {
    expect(at(FORCED_CLOSE_EXIT)).toBeLessThan(at(ROUTE_EXIT));
  });

  it('reports it before the unobservable-socket blocker', () => {
    // The one most likely to hide a finding in practice: it fires on any
    // deployment configured with a websocket RPC at all, regardless of
    // whether anything went wrong.
    expect(at(FORCED_CLOSE_EXIT)).toBeLessThan(at(WS_EXIT));
  });

  it('reports it before the wrong-chain blocker', () => {
    expect(at(FORCED_CLOSE_EXIT)).toBeLessThan(at(CHAIN_EXIT));
  });

  it('exits 1 rather than 2 — a finding, not an inconclusive run', () => {
    // The distinction the batch acts on: 2 means "re-run, nothing was
    // learned", which is how a confirmed defect would disappear.
    const block = src.slice(at(FORCED_CLOSE_EXIT), at(ROUTE_EXIT));
    expect(block).toContain('process.exit(1)');
    expect(block).not.toContain('process.exit(2)');
  });

  it('is scoped to forced-close FAILs, not to every problem', () => {
    // Deliberate, and the reason is in the drive's comment: the other
    // verdicts include ABSENCE findings, and an absence is exactly the
    // conclusion a transport failure or an unobservable socket read
    // legitimately undermines. What is carried past the blockers is
    // content that was READ.
    const decl = src.slice(at('const fcObserved ='), at(FORCED_CLOSE_EXIT));
    expect(decl).toContain("fc.verdict === 'fail'");
    expect(decl).not.toContain('failures');
  });
});
