import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RiskDisclosures } from '../../src/components/app/RiskDisclosures';

/*
 * #796 — the in-kind settlement disclosure line must appear when (and only when)
 * the offer/loan's collateral settles in-kind on default. Mock react-i18next so
 * `t` returns the key (identity), letting us assert which disclosure lines the
 * component decided to render without depending on the localized copy.
 * `resolvedLanguage: 'en'` keeps the English-original notice/modal out of the way.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: () => Promise.resolve() },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

describe('RiskDisclosures — #796 in-kind settlement line', () => {
  it('renders the in-kind disclosure when collateralInKind is true', () => {
    render(<RiskDisclosures collateralInKind />);
    expect(
      screen.getByText('riskDisclosures.collateralInKind'),
    ).toBeInTheDocument();
  });

  it('omits the in-kind disclosure when collateralInKind is false', () => {
    render(<RiskDisclosures collateralInKind={false} />);
    expect(
      screen.queryByText('riskDisclosures.collateralInKind'),
    ).not.toBeInTheDocument();
  });

  it('omits the in-kind disclosure when collateralInKind is undefined (liquid / non-offer surfaces)', () => {
    render(<RiskDisclosures />);
    expect(
      screen.queryByText('riskDisclosures.collateralInKind'),
    ).not.toBeInTheDocument();
  });

  it('renders the in-kind line alongside the full-term interest line', () => {
    render(<RiskDisclosures collateralInKind fullTermInterest />);
    expect(
      screen.getByText('riskDisclosures.collateralInKind'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('riskDisclosures.fullTermInterest'),
    ).toBeInTheDocument();
  });
});
