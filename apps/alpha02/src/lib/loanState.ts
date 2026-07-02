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

export interface LoanStateView {
  state: LoanUiState;
  label: string;
  badge: 'ok' | 'warn' | 'danger' | 'neutral';
}

const DUE_SOON_DAYS = 3;

export function loanStateView(loan: IndexedLoan): LoanStateView {
  switch (loan.status) {
    case 'repaid':
      return { state: 'repaid', label: 'Repaid', badge: 'ok' };
    case 'defaulted':
    case 'liquidated':
      return { state: 'defaulted', label: 'Defaulted', badge: 'danger' };
    case 'settled':
    case 'internal_matched':
      return { state: 'closed', label: 'Closed', badge: 'neutral' };
    case 'fallback_pending':
      return { state: 'closed', label: 'Being settled', badge: 'warn' };
    case 'active': {
      const remaining = daysRemaining(loan.startTime, loan.durationDays);
      if (remaining < 0) {
        return { state: 'overdue', label: 'Past due', badge: 'danger' };
      }
      if (remaining <= DUE_SOON_DAYS) {
        return {
          state: 'due-soon',
          label: remaining === 0 ? 'Due today' : `Due in ${remaining} day${remaining === 1 ? '' : 's'}`,
          badge: 'warn',
        };
      }
      return { state: 'on-track', label: `Due in ${remaining} days`, badge: 'ok' };
    }
  }
}
