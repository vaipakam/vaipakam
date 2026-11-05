/**
 * Where a flow is (RB-CLICKS): the steps in order, the current one marked
 * for assistive technology, the done ones named as done. A flow states its
 * step count up front so the reader knows the clicks ahead.
 */
export function StepNav({ steps, current, label }: { steps: readonly string[]; current: number; label: string }) {
  return (
    <ol className="steps" aria-label={label}>
      {steps.map((s, i) => (
        <li key={s} aria-current={i === current ? 'step' : undefined} data-state={i < current ? 'done' : i === current ? 'current' : 'todo'}>
          {s}
        </li>
      ))}
    </ol>
  );
}
