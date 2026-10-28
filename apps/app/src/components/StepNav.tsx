/** Compact step indicator for guided flows. */
import { copy } from '../content/copy';

/** One step of a guided flow: the flow's own id for it, and its label. */
export interface StepDef<S extends string> {
  id: S;
  label: string;
}

/**
 * Where `current` sits in `steps` (#2532). Each flow lists its steps once,
 * with their ids, and the indicator finds the position from the id, so no
 * caller keeps a hand-written ladder from step to number beside the list it
 * has to agree with. A step outside the walk shown (unreachable in every
 * flow today) reads as the last one, which is what the ladders this replaces
 * did with any step they did not name.
 */
export function stepPosition<S extends string>(
  steps: readonly StepDef<S>[],
  current: S,
): number {
  const at = steps.findIndex((s) => s.id === current);
  return at === -1 ? steps.length - 1 : at;
}

export function StepNav<S extends string>({
  steps,
  current,
}: {
  steps: readonly StepDef<S>[];
  current: S;
}) {
  const at = stepPosition(steps, current);
  return (
    <nav className="steps-nav" aria-label={copy.stepNav.progressAria}>
      {/* Phones swap the dot row for this single line (UX-039) — same
          information, no wrapped orphan labels. */}
      <span className="steps-compact">
        {copy.stepNav.progress(at + 1, steps.length, steps[at].label)}
      </span>
      {steps.map((step, i) => (
        <span
          key={step.id}
          className={`step-dot ${i < at ? 'done' : i === at ? 'current' : ''}`}
          aria-current={i === at ? 'step' : undefined}
        >
          {step.label}
        </span>
      ))}
    </nav>
  );
}
