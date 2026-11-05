import { Link } from 'react-router-dom';
import { useCopy } from '../copy/useCopy';
import type { Verdict } from '../eligibility/types';

export interface Action {
  id: string;
  label: string;
  verdict: Verdict;
  /** Where the action starts: a route, or a handler for an in-page step. */
  to?: string;
  onStart?: () => void;
  primary?: boolean;
}

/**
 * RB-ACTION, RB-ELIG — the actions a page offers, each rendered FROM its
 * verdict: open shows the control; closed shows the control disabled with
 * every refusal (tier A), when it may lift and the remedy this session can
 * drive; unknown withholds the control and says WHY its inputs are not read
 * (the verdict's own reason: a read not made yet, or the failure it met),
 * never a bare "checking" that outlives the attempt. A handler never
 * re-derives eligibility.
 */
export function ActionList({ actions }: { actions: readonly Action[] }) {
  const { text, format } = useCopy();
  return (
    <ul className="actions">
      {actions.map((a) => {
        const cls = `btn${a.primary ? ' btn-primary' : ''}`;
        const open = a.verdict.state === 'open';
        return (
          <li key={a.id} data-verdict={a.verdict.state}>
            {a.verdict.state === 'unknown' ? (
              <span className="tier-b action-withheld">{a.label}: {text('action.withheld')}</span>
            ) : a.to && open ? (
              <Link className={cls} to={a.to}>
                {a.label}
              </Link>
            ) : (
              <button type="button" className={cls} disabled={!open} aria-disabled={!open} onClick={open ? a.onStart : undefined}>
                {a.label}
              </button>
            )}
            {a.verdict.state !== 'open' && (
              <ul className="refusals tier-a">
                {a.verdict.refusals.map((r) => (
                  <li key={r.code} data-code={r.code}>
                    {r.reason}
                    {r.reopensAt !== null && <> {format('action.reopens', { when: new Date(r.reopensAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' })}</>}
                    {r.remedy && (
                      <>
                        {' '}
                        <Link to={r.remedy.to}>{r.remedy.label}</Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
