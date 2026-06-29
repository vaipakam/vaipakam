import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InterestImplicationWarning } from '../../src/components/app/InterestImplicationWarning';

/*
 * #797 — the Direct-preclose and Refinance interest warnings must reflect the
 * OLD loan's actual interest mode: full-term copy for a full-term loan, the
 * pro-rata variant when the loan charges pro-rata, and the conservative
 * full-term default when the mode is unknown. Kinds whose copy isn't
 * full-term-specific (early-withdrawal / transfer / offset) never swap.
 * Identity-`t` mock so we assert on the chosen i18n keys.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: () => Promise.resolve() },
  }),
}));

describe('InterestImplicationWarning — #797 mode-aware copy', () => {
  it('refinance defaults to the full-term body when the mode is unknown', () => {
    render(<InterestImplicationWarning kind="refinance" />);
    expect(screen.getByText('interestWarning.refinanceBody')).toBeInTheDocument();
  });

  it('refinance shows the full-term body for a full-term loan', () => {
    render(<InterestImplicationWarning kind="refinance" fullTermInterest />);
    expect(screen.getByText('interestWarning.refinanceBody')).toBeInTheDocument();
    expect(screen.getByText('interestWarning.refinanceTitle')).toBeInTheDocument();
  });

  it('refinance is NOT mode-aware — always full-term, even for a pro-rata loan (Codex #810 r1 P1)', () => {
    // The on-chain RefinanceFacet always computes the old-loan payoff via
    // fullTermInterest(), so refinance copy must never switch to pro-rata.
    render(<InterestImplicationWarning kind="refinance" fullTermInterest={false} />);
    expect(screen.getByText('interestWarning.refinanceBody')).toBeInTheDocument();
    expect(
      screen.queryByText('interestWarning.refinanceBodyProRata'),
    ).not.toBeInTheDocument();
  });

  it('preclose-direct swaps to the pro-rata body for a pro-rata loan', () => {
    render(<InterestImplicationWarning kind="preclose-direct" fullTermInterest={false} />);
    expect(
      screen.getByText('interestWarning.precloseDirectBodyProRata'),
    ).toBeInTheDocument();
  });

  it('preclose-direct keeps the full-term body for a full-term loan', () => {
    render(<InterestImplicationWarning kind="preclose-direct" fullTermInterest />);
    expect(screen.getByText('interestWarning.precloseDirectBody')).toBeInTheDocument();
  });

  it('preclose-transfer has no pro-rata variant — body is unchanged even when pro-rata', () => {
    render(<InterestImplicationWarning kind="preclose-transfer" fullTermInterest={false} />);
    expect(screen.getByText('interestWarning.precloseTransferBody')).toBeInTheDocument();
  });

  it('early-withdrawal copy is mode-independent', () => {
    render(<InterestImplicationWarning kind="early-withdrawal" fullTermInterest={false} />);
    expect(screen.getByText('interestWarning.earlyWithdrawalBody')).toBeInTheDocument();
  });
});
