/**
 * #2532 — the shared pieces of the offer and rental flows' signing step:
 * the submit button's progress label and the step indicator's position.
 */
import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import { submitProgressLabel } from './FlowFinish';
import { stepPosition } from './StepNav';

const labels = { idle: 'Post', waiting: 'Waiting for your wallet' };

describe('submitProgressLabel', () => {
  it("is the flow's own action while nothing is in flight", () => {
    expect(submitProgressLabel(null, labels)).toBe('Post');
  });

  it('waits during the checks before the first prompt', () => {
    expect(submitProgressLabel({ kind: 'send', current: 0, total: 2 }, labels)).toBe(
      'Waiting for your wallet',
    );
  });

  it('names the prompt the wallet is showing, of how many', () => {
    expect(submitProgressLabel({ kind: 'sign', current: 1, total: 3 }, labels)).toBe(
      copy.signing.phaseSign(1, 3),
    );
    expect(submitProgressLabel({ kind: 'permit', current: 2, total: 3 }, labels)).toBe(
      copy.signing.phasePermit(2, 3),
    );
    expect(submitProgressLabel({ kind: 'approve', current: 2, total: 3 }, labels)).toBe(
      copy.signing.phaseApprove(2, 3),
    );
    expect(submitProgressLabel({ kind: 'send', current: 3, total: 3 }, labels)).toBe(
      copy.signing.phaseSend(3, 3),
    );
  });
});

describe('stepPosition', () => {
  const steps = [
    { id: 'details', label: 'Details' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done' },
  ] as const;

  it('finds a step by its id', () => {
    expect(stepPosition(steps, 'details')).toBe(0);
    expect(stepPosition(steps, 'review')).toBe(1);
    expect(stepPosition(steps, 'done')).toBe(2);
  });

  it('reads a step outside the walk as the last one', () => {
    expect(stepPosition<string>(steps, 'terms')).toBe(2);
  });
});
