/**
 * Empty / unavailable states with a single next action — never a
 * lecture, and never "empty" wording when the truth is "couldn't
 * load" (the audit's F-20260702-001 contradiction class).
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CloudOff } from 'lucide-react';

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Icon aria-hidden />
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

/** Data-source-unavailable state (indexer down / not configured).
 *  Distinct from EmptyState on purpose. */
export function UnavailableState({ body }: { body: string }) {
  return (
    <div className="empty-state">
      <CloudOff aria-hidden />
      <p>{body}</p>
    </div>
  );
}
