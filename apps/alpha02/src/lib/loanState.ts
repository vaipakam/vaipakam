/**
 * Plain-language loan state for Basic mode — human labels first,
 * numbers optional (Journey M2 acceptance check). Derived from the
 * indexer row's status + timing; HF-level nuance arrives with the
 * on-chain risk reads in a later alpha02 iteration.
 */
import type { IndexedLoan } from '../data/indexer';
import { daysRemaining } from './format';

export type LoanUiState =
  | 'on-track'
  | 'due-soon'
  | 'overdue'
  | 'repaid'
  | 'defaulted'
  | 'closed';

/** Stable catalog key for the state's display label. `state` alone is
 *  not enough — 'closed' covers both a settled loan ("Closed") and a
 *  failed-default one still settling ("Being settled") — so the label
 *  is keyed separately. `dueInDays` is the parameterised key (needs the
 *  day count). Consumers resolve these through copy.loanState so the
 *  badge text is translatable. */
export type LoanStateLabelKey =
  | 'repaid'
  | 'defaulted'
  | 'closed'
  | 'beingSettled'
  | 'pastDue'
  | 'dueToday'
  | 'dueInDays';

export interface LoanStateView {
  state: LoanUiState;
  /** Catalog key for the display label (resolve via loanStateLabel). */
  labelKey: LoanStateLabelKey;
  /** Whole days remaining — set only for labelKey === 'dueInDays'. */
  daysRemaining: number | null;
  /** English fallback label — used only when no catalog is supplied
   *  (kept so the pure module stays renderable/testable on its own). */
  label: string;
  badge: 'ok' | 'warn' | 'danger' | 'neutral';
}

/** The subset of copy.loanState needed to render a state label. Passed
 *  in (not imported) so this module stays framework-free and pure. */
export interface LoanStateLabels {
  repaid: string;
  defaulted: string;
  closed: string;
  beingSettled: string;
  pastDue: string;
  dueToday: string;
  dueInDays: (n: number) => string;
}

const DUE_SOON_DAYS = 3;

export function loanStateView(loan: IndexedLoan): LoanStateView {
  switch (loan.status) {
    case 'repaid':
      return { state: 'repaid', labelKey: 'repaid', daysRemaining: null, label: 'Repaid', badge: 'ok' };
    case 'defaulted':
    case 'liquidated':
      return { state: 'defaulted', labelKey: 'defaulted', daysRemaining: null, label: 'Defaulted', badge: 'danger' };
    case 'settled':
    case 'internal_matched':
      return { state: 'closed', labelKey: 'closed', daysRemaining: null, label: 'Closed', badge: 'neutral' };
    case 'fallback_pending':
      return { state: 'closed', labelKey: 'beingSettled', daysRemaining: null, label: 'Being settled', badge: 'warn' };
    case 'active': {
      const remaining = daysRemaining(loan.startTime, loan.durationDays);
      if (remaining < 0) {
        return { state: 'overdue', labelKey: 'pastDue', daysRemaining: null, label: 'Past due', badge: 'danger' };
      }
      if (remaining <= DUE_SOON_DAYS) {
        return {
          state: 'due-soon',
          labelKey: remaining === 0 ? 'dueToday' : 'dueInDays',
          daysRemaining: remaining === 0 ? null : remaining,
          label: remaining === 0 ? 'Due today' : `Due in ${remaining} day${remaining === 1 ? '' : 's'}`,
          badge: 'warn',
        };
      }
      return { state: 'on-track', labelKey: 'dueInDays', daysRemaining: remaining, label: `Due in ${remaining} days`, badge: 'ok' };
    }
  }
}

/** Resolve a state view to its translated badge label. The `dueInDays`
 *  key is parameterised by the day count; every other key is a direct
 *  lookup. */
export function loanStateLabel(view: LoanStateView, labels: LoanStateLabels): string {
  if (view.labelKey === 'dueInDays') return labels.dueInDays(view.daysRemaining ?? 0);
  return labels[view.labelKey];
}
