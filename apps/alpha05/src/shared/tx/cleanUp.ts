/**
 * A flow's clean-up legs around its call (shared by the tracker). `unwind`
 * puts back what the flow set up only for a call that did not take effect;
 * `release` takes back what the flow set up for the call alone, whatever
 * the call did (an ERC-1155 operator approval is the case today). A failure
 * inside either is reported as a leg that did not land, never swallowed.
 */
import type { LegOutcome } from './outcome';

type Step = (() => Promise<LegOutcome | null>) | undefined;

/** What a clean-up step found: done, confirmed not done, or `unknown` when
 *  a step was sent but its effect could not be read (it may have landed). */
export interface CleanUpResult {
  status: 'done' | 'not-done' | 'unknown';
  sentence: string;
}

/** A clean-up result as the finish card's leg. */
export function cleanUpLeg(r: CleanUpResult, label: string): LegOutcome {
  return r.status === 'done' ? { status: 'done', label } : { status: r.status, label, reason: r.sentence };
}

export interface CleanUpSteps {
  unwind?: Step;
  release?: Step;
}

/** After a call that did not take effect: `unwind`, then `release`. */
export async function cleanUpAfterNoEffect(s: CleanUpSteps): Promise<LegOutcome[]> {
  const legs: LegOutcome[] = [];
  for (const step of [s.unwind, s.release]) {
    const leg = await runStep(step);
    if (leg) legs.push(leg);
  }
  return legs;
}

/** After a call that took effect: `release` alone. */
export async function cleanUpAfterEffect(s: CleanUpSteps): Promise<LegOutcome[]> {
  const leg = await runStep(s.release);
  return leg ? [leg] : [];
}

async function runStep(step: Step): Promise<LegOutcome | null> {
  if (!step) return null;
  try {
    return await step();
  } catch (e) {
    return { status: 'not-done', label: 'clean-up', reason: (e as Error).message };
  }
}
