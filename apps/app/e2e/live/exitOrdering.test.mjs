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

  // ROUND 82 P3 — THERE IS NO LONGER A FORCED-CLOSE EXIT OF ITS OWN, and
  // the cases below were rewritten rather than deleted.
  //
  // The drive used to carry two implementations of one exit policy: this
  // `fcObserved` guard, and the `observedNow` promotion that already
  // covered it. The second was unreachable — `visitProblemList` reads the
  // card's `failKind` and pushes an observed one with `blockable: false`,
  // which is exactly what `observedNow` selects, so the process had always
  // exited first. Every case that pinned the dead copy now pins the live
  // one, so the property survives the fold: a forced-close failure that
  // was READ outranks every blocker, and one that was INFERRED does not.
  //
  // The tag half is asserted where it belongs — behaviourally, against
  // `visitProblemKinds` in `visitVerdict.test.mjs`, which is a real
  // function call rather than a string match on this file.
  const OBSERVED_NOW_EXIT = 'if (observedNow.length) {';
  const ROUTE_EXIT = 'if (routeFailures.length) {';
  const WS_EXIT = 'if (wsRpcMethods.size) {';
  const CHAIN_EXIT = 'if (pageChainWrong.length) {';
  const CHAIN_UNKNOWN_EXIT = 'if (pageChainUnknown.length && !observedRemaining.length) {';
  const GENERIC_FAIL_EXIT = 'if (failures) process.exit(1);';

  it('every guard this is ranked against still exists', () => {
    // Guards the guard. If one is renamed or removed, the ordering
    // assertions below would pass over a comparison with -1 and say
    // nothing — the vacuous-loop shape this suite has already been
    // caught by twice.
    for (const [name, needle] of [
      ['page-read defects', OBSERVED_NOW_EXIT],
      ['route failures', ROUTE_EXIT],
      ['websocket RPC', WS_EXIT],
      ['wrong chain', CHAIN_EXIT],
      ['unknown chain', CHAIN_UNKNOWN_EXIT],
      ['generic failures', GENERIC_FAIL_EXIT],
    ]) {
      expect(at(needle), `${name} guard not found in the drive`).toBeGreaterThan(-1);
    }
  });

  // ROUND 79 P2 — and the promotion is not the card's alone.
  //
  // Round 78's tags were used only at the unknown-chain gate, so a dead
  // anchor or a mis-ordered row was still swallowed by the route,
  // WebSocket, wrong-chain and allowlist blockers — round 38's finding
  // surviving in every guard it had not been applied to.
  it('promotes page-read defects ahead of the transport blocker too', () => {
    expect(at(OBSERVED_NOW_EXIT)).toBeGreaterThan(-1);
    expect(at(OBSERVED_NOW_EXIT)).toBeLessThan(at(ROUTE_EXIT));
    expect(at(OBSERVED_NOW_EXIT)).toBeLessThan(at(WS_EXIT));
    expect(at(OBSERVED_NOW_EXIT)).toBeLessThan(at(CHAIN_EXIT));
  });

  // SELF-REVIEW AFTER ROUND 79 — the filter must read the TAG.
  //
  // Its first version matched the `why` string with a regex, thirty lines
  // under the paragraph saying the verdict states its own kind "rather
  // than this filter guessing from the `why` string". A reworded message
  // would have dropped out of the promotion silently, and a new arm would
  // have defaulted to unpromoted with nothing to notice.
  it('promotes from the tag, never from the message', () => {
    const decl = src.slice(at('const observedNow ='), at(OBSERVED_NOW_EXIT));
    expect(decl).toContain('pr.blockable === false');
    expect(decl).not.toMatch(/did not reach|NOT first|test\(pr\.why\)/);
    expect(src).not.toContain('PROMOTED_OBSERVED');
  });

  it('reports the observed defect before the transport blocker', () => {
    expect(at(OBSERVED_NOW_EXIT)).toBeLessThan(at(ROUTE_EXIT));
  });

  it('reports it before the unobservable-socket blocker', () => {
    // The one most likely to hide a finding in practice: it fires on any
    // deployment configured with a websocket RPC at all, regardless of
    // whether anything went wrong.
    expect(at(OBSERVED_NOW_EXIT)).toBeLessThan(at(WS_EXIT));
  });

  it('reports it before the wrong-chain blocker', () => {
    expect(at(OBSERVED_NOW_EXIT)).toBeLessThan(at(CHAIN_EXIT));
  });

  // ROUND 77 P2 — and an UNESTABLISHED page chain outranks an inference.
  //
  // `served === null` is a probe that was refused or timed out, not an
  // endpoint on the right chain. Treating it as acceptable let a missing
  // surface exit 1 against the product while the page's chain had never
  // been established — which is precisely the case the wrong-chain gate
  // exists for, since a deterministic deploy answers ordinary reads at
  // the same address on either network.
  it('blocks on an unknown page chain before the generic failure exit', () => {
    expect(at(CHAIN_UNKNOWN_EXIT)).toBeLessThan(at(GENERIC_FAIL_EXIT));
  });

  it('still lets a READ defect past the unknown-chain blocker', () => {
    // The whole ranking in one line: content that was read outranks a
    // blocker, and a blocker outranks a conclusion inferred from an
    // absence the blocker could explain.
    expect(at(OBSERVED_NOW_EXIT)).toBeLessThan(at(CHAIN_UNKNOWN_EXIT));
  });

  // ROUND 78 P2 — and it gates on the KIND of failure, not the count.
  //
  // `failures` is not all-inferred: the exits above extract only the
  // problems tagged unblockable, while a hooks-order crash, an
  // uncaught page error, a dead anchor and a mis-ordered row are read
  // directly and counted in the same total. Gating on the aggregate
  // downgraded those to "nothing was learned" — the swallow this whole
  // ordering exists to prevent.
  it('gates the unknown-chain block on there being no READ defect', () => {
    expect(CHAIN_UNKNOWN_EXIT).toContain('!observedRemaining.length');
  });

  // ROUND 95 P2 — AND A CLEAN RUN IS NOT AN EXEMPTION FROM IT.
  //
  // Round 78's gate additionally required an absence-shaped failure, on
  // the reasoning that an unanswerable probe is not worth exiting 2 over
  // when nothing is wrong. That only weighs what the drive fails to FIND;
  // its main product is what it READS off the page — the card's figures,
  // the receipt rows, the fee copy — all served by the endpoint that would
  // not say which chain it was. A PASS is the strongest claim here, and it
  // was the one verdict that skipped the question.
  //
  // Asserted as an ABSENCE in the condition, because that is the half a
  // future edit would restore without noticing: nothing else in the file
  // fails if `absenceRemaining` creeps back into this gate.
  it('blocks an otherwise CLEAN run too, not just an inferred failure', () => {
    expect(CHAIN_UNKNOWN_EXIT).not.toContain('absenceRemaining');
    // Still computed, because the message distinguishes the two cases.
    expect(src).toContain('const absenceRemaining =');
  });

  // ROUND 108 P2 — THE FORCED-CLOSE GAP IS NAMED EVEN WHEN ANOTHER BLOCKER
  // TAKES THE EXIT.
  //
  // Both incompletenesses can hold on one visit — shared RPC trouble leaves
  // the chooser's readiness unresolved AND the forced-close card unsettled.
  // The Advanced arm exits first, so the funds-facing gap this run promises
  // to disclose was never computed. The ranking is right and is unchanged;
  // what was wrong is that the other gap went unsaid.
  it('computes the forced-close gap ABOVE the Advanced blocked exit', () => {
    const compute = at('const fcGap = forcedCloseCoverage(visited, ROLE);');
    const advExit = at('if (advBlocked.length) {');
    expect(compute, 'the coverage computation was not found').toBeGreaterThan(-1);
    expect(advExit, 'the Advanced blocked exit was not found').toBeGreaterThan(-1);
    expect(compute, 'the gap is computed before the earlier exit').toBeLessThan(advExit);
    // Computed ONCE, so the two exits cannot report different readings.
    expect(
      [...src.matchAll(/forcedCloseCoverage\(visited, ROLE\)/g)],
      'one computation, two readers',
    ).toHaveLength(1);
  });

  it('names it inside the Advanced blocked branch too', () => {
    const branch = src.slice(at('if (advBlocked.length) {'), at('if (advBlocked.length) {') + 900);
    expect(branch, 'the Advanced exit mentions the forced-close gap').toContain('fcGap');
  });

  it('reads those kinds from the module that decides the problems', () => {
    // Deciding them anywhere else is the shape #1861 already caught in
    // this file: two places computing overlapping verdicts, one quietly
    // erasing the other.
    expect(src).toContain('visitProblemKinds(v, ROLE)');
  });

  it('exits 1 rather than 2 — a finding, not an inconclusive run', () => {
    // The distinction the batch acts on: 2 means "re-run, nothing was
    // learned", which is how a confirmed defect would disappear.
    const block = src.slice(at(OBSERVED_NOW_EXIT), at(ROUTE_EXIT));
    expect(block).toContain('process.exit(1)');
    expect(block).not.toContain('process.exit(2)');
  });

  // ⚠ THIS CASE PREVIOUSLY PINNED THE DEFECT AS CORRECT, which is worth
  // recording where it happened rather than only in a commit message.
  //
  // Round 38 ranked forced-close FAILs ahead of the infrastructure
  // gates, and its comment said — correctly — that ABSENCE findings must
  // stay behind them, because a transport failure or a wrong-chain page
  // endpoint explains a missing surface just as well as a regression
  // does. The filter it shipped was `verdict === 'fail'`, which includes
  // the two absence arms. I then wrote this case asserting exactly that
  // string, so the guard I added to protect the fix certified the bug.
  //
  // Round 39 P2 found it. The verdict now tags every failure `observed`
  // or `inferred` at its own return site, and this asserts the filter
  // reads the TAG rather than the bare verdict — the property the
  // original comment described all along.
  it('bypasses the blockers only for failures that were READ', () => {
    const decl = src.slice(at('const observedNow ='), at(OBSERVED_NOW_EXIT));
    expect(decl).toContain('pr.blockable === false');
    expect(decl).not.toContain('failures');
  });

  it('does not let a bare verdict check stand in for the tag', () => {
    // The regression that would undo this is dropping the tag test and
    // selecting on the bare verdict, which reads as a harmless
    // simplification and restores the round-38 defect exactly. Since the
    // fold there is no forced-close-shaped filter here to lose it in: the
    // promotion selects on the tag alone and knows nothing about which
    // card produced the problem.
    const decl = src.slice(at('const observedNow ='), at(OBSERVED_NOW_EXIT));
    expect(decl.includes('pr.blockable === false'), 'the promotion must read the tag').toBe(
      true,
    );
    expect(decl).not.toContain("verdict === 'fail'");
  });

  // ROUND 82 P3 — and the duplicate must not come back.
  //
  // Two exits for one policy is how the copies drift: a future change
  // edits whichever it finds first, and the dead one keeps its own
  // operator message. The shared promotion is the only decision site.
  it('keeps one exit for observed defects, not one per card', () => {
    expect(src).not.toContain('const fcObserved');
  });
  // ROUND 41 P2 — the coverage gate now needs the ROLE, and it is
  // deliberately permissive when none is supplied so an older caller
  // does not start failing. That leniency is only safe if the live
  // caller actually passes it — otherwise the lender check the round-41
  // finding restored is switched off again by omission, silently, which
  // is the exact shape of the finding it fixes.
  it('passes the role into the coverage gate', () => {
    expect(src).toContain('forcedCloseCoverage(visited, ROLE)');
  });
});
