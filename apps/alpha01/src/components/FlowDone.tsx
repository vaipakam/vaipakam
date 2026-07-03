import type { ReactNode } from 'react';

interface Props {
  title: string;
  body: string;
  primaryLabel: string;
  onPrimary: () => void;
  secondary?: ReactNode;
}

export function FlowDone({ title, body, primaryLabel, onPrimary, secondary }: Props) {
  return (
    <div className="card" data-testid="flow-done">
      <h2>{title}</h2>
      <p style={{ marginTop: 8, color: 'var(--text-secondary)' }}>{body}</p>
      <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={onPrimary}>
        {primaryLabel}
      </button>
      {secondary ? <div style={{ marginTop: 12 }}>{secondary}</div> : null}
    </div>
  );
}