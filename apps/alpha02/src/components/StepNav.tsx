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
