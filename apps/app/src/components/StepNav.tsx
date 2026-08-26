/** Compact step indicator for guided flows. */
import { copy } from '../content/copy';

export function StepNav({
  steps,
  current,
}: {
  steps: readonly string[];
  current: number;
}) {
  return (
    <nav className="steps-nav" aria-label={copy.stepNav.progressAria}>
      {/* Phones swap the dot row for this single line (UX-039) — same
          information, no wrapped orphan labels. */}
      <span className="steps-compact">
        {copy.stepNav.progress(current + 1, steps.length, steps[current])}
      </span>
      {steps.map((step, i) => (
        <span
          key={step}
          className={`step-dot ${i < current ? 'done' : i === current ? 'current' : ''}`}
          aria-current={i === current ? 'step' : undefined}
        >
          {step}
        </span>
      ))}
    </nav>
  );
}
