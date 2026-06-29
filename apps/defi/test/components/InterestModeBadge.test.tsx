import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InterestModeBadge } from '../../src/components/app/InterestModeBadge';

/*
 * #797 — the at-a-glance interest-mode chip must say full-term vs pro-rata
 * (and pick the partial-repay-qualified tooltip), and must render NOTHING when
 * the mode doesn't apply (non-ERC-20 principal ⇒ `undefined`). Identity-`t`
 * mock so we assert on the i18n keys the component chose, not the localized
 * copy.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: () => Promise.resolve() },
  }),
}));

describe('InterestModeBadge — #797 interest-mode chip', () => {
  it('renders the full-term label + tooltip when fullTermInterest is true', () => {
    render(<InterestModeBadge fullTermInterest />);
    const badge = screen.getByText('interestMode.fullTerm');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'interestMode.fullTermTip');
  });

  it('uses the partial-repay-qualified tooltip for a full-term offer that allows partial repay', () => {
    render(<InterestModeBadge fullTermInterest allowsPartialRepay />);
    const badge = screen.getByText('interestMode.fullTerm');
    expect(badge).toHaveAttribute('title', 'interestMode.fullTermPartialTip');
  });

  it('renders the pro-rata label + tooltip when fullTermInterest is false', () => {
    render(<InterestModeBadge fullTermInterest={false} />);
    const badge = screen.getByText('interestMode.proRata');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'interestMode.proRataTip');
  });

  it('ignores allowsPartialRepay for a pro-rata offer (always the pro-rata tooltip)', () => {
    render(<InterestModeBadge fullTermInterest={false} allowsPartialRepay />);
    expect(screen.getByText('interestMode.proRata')).toHaveAttribute(
      'title',
      'interestMode.proRataTip',
    );
  });

  it('renders nothing when the mode does not apply (undefined)', () => {
    const { container } = render(<InterestModeBadge />);
    expect(container).toBeEmptyDOMElement();
  });
});
