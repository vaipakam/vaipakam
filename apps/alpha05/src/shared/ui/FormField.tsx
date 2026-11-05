import { useId, type ReactNode } from 'react';

/**
 * One labelled input with its hint (tier B) and its error (tier A), wired
 * for assistive technology: the control is labelled by the label and
 * described by the hint and the error, and an error marks it invalid.
 * `children` receives the ids to put on the control.
 */
export function FormField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p id={hintId} className="tier-b field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="tier-a field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
