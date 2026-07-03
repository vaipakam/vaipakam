import type { ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
  testId?: string;
  defaultOpen?: boolean;
}

/** Collapsible Advanced-mode panel (HF/LTV, bounds, construction details). */
export function AdvancedPanel({ title, children, testId, defaultOpen = true }: Props) {
  return (
    <details className="advanced-panel" data-testid={testId} open={defaultOpen || undefined}>
      <summary>{title}</summary>
      <div className="advanced-panel-body">{children}</div>
    </details>
  );
}