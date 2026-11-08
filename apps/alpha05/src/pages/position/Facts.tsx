import type { ReactNode } from 'react';
import { Icon } from '../../shared/ui/Icon';

/** One titled list of a loan's facts on its page. */
/** `foot` follows the list: sentences that belong to the section but are
 *  not label-and-value facts. */
export function Facts({ title, id, lead, foot, testId, children }: { title: string; id: string; lead?: ReactNode; foot?: ReactNode; testId?: string; children: ReactNode }) {
  return (
    <section className="home-section position-facts" aria-labelledby={id} data-testid={testId}>
      <h2 id={id}>{title}</h2>
      {lead}
      <dl className="facts">{children}</dl>
      {foot}
    </section>
  );
}

/** One fact; `null` is an unread figure, stated as unknown, never left blank. */
export function Fact({ label, value, unknown, binding = false }: { label: string; value: string | null; unknown: string; binding?: boolean }) {
  return (
    <>
      <dt className={binding ? 'tier-a' : 'tier-b'}>{label}</dt>
      <dd className={value === null ? 'value-unknown' : undefined} data-binding={binding ? 'true' : undefined}>
        {value === null && <Icon meaning="unknown" size={16} />}
        {value ?? unknown}
      </dd>
    </>
  );
}
