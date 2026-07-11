/** Compact step indicator for guided flows. */
export function StepNav({
  steps,
  current,
}: {
  steps: readonly string[];
  current: number;
}) {
  return (
    <nav className="steps-nav" aria-label="Progress">
      {/* Phones swap the dot row for this single line (UX-039) — same
          information, no wrapped orphan labels. */}
      <span className="steps-compact">
        Step {current + 1} of {steps.length} — {steps[current]}
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
