/**
 * Empty / unavailable states with a single next action — never a
 * lecture, and never "empty" wording when the truth is "couldn't
 * load" (the audit's F-20260702-001 contradiction class).
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CloudOff, LoaderCircle } from 'lucide-react';

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
      {/* A loader that doesn't move reads as a hang on a slow RPC —
          spin it automatically so no call site can forget (UX-022). */}
      <Icon aria-hidden className={Icon === LoaderCircle ? 'spin' : undefined} />
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

/** Data-source-unavailable state (indexer down / not configured).
 *  Distinct from EmptyState on purpose. When the copy tells the user
 *  to "try again", give them the button that actually does it —
 *  otherwise the state is a dead end (UX-021). */
export function UnavailableState({
  body,
  onRetry,
}: {
  body: string;
  onRetry?: () => void;
}) {
  return (
    <div className="empty-state">
      <CloudOff aria-hidden />
      <p>{body}</p>
      {onRetry ? (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
