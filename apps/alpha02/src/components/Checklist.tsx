/**
 * Eligibility checklist — problems shown as fixable items, not
 * opaque transaction failures (BasicUserUXSimplification.md, Step 3).
 * Each item is pass/fail/pending; failing items may carry an inline
 * fix action (connect, switch network, ...).
 */
import { CircleCheck, CircleX, CircleDashed } from 'lucide-react';
import type { ReactNode } from 'react';

export interface CheckItem {
  id: string;
  label: string;
  state: 'pass' | 'fail' | 'pending';
  /** Optional inline remedy (a small button/link) shown when failing. */
  fix?: ReactNode;
}

export function Checklist({ items }: { items: CheckItem[] }) {
  return (
    <ul className="checklist">
      {items.map((item) => (
        <li key={item.id} className={`check-${item.state}`}>
          {item.state === 'pass' ? (
            <CircleCheck aria-label="Ready" />
          ) : item.state === 'fail' ? (
            <CircleX aria-label="Needs attention" />
          ) : (
            <CircleDashed aria-label="Checking" />
          )}
          <span>{item.label}</span>
          {item.state === 'fail' && item.fix ? (
            <span className="check-fix">{item.fix}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function allChecksPass(items: CheckItem[]): boolean {
  return items.every((i) => i.state === 'pass');
}
