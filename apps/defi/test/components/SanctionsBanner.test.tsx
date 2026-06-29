import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SanctionsBanner } from '../../src/components/app/SanctionsBanner';

/*
 * #800 — the sanctions banner must appear ONLY when the screened address is
 * actually flagged, and must stay silent while the read is loading, when the
 * address is clean, and when no address is connected (the fail-open posture
 * that mirrors the protocol). Identity-`t` mock asserts on the i18n keys; the
 * sanctions hook is mocked so we drive each state deterministically.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: () => Promise.resolve() },
  }),
}));

const sanctionsState = vi.hoisted(() => ({ current: { isSanctioned: false, loading: false } }));
vi.mock('../../src/hooks/useSanctionsCheck', () => ({
  useSanctionsCheck: () => sanctionsState.current,
}));

describe('SanctionsBanner — #800 sanctions banner visibility', () => {
  beforeEach(() => {
    sanctionsState.current = { isSanctioned: false, loading: false };
  });

  it('renders the banner when the screened address is flagged', () => {
    sanctionsState.current = { isSanctioned: true, loading: false };
    render(<SanctionsBanner address="0x1111111111111111111111111111111111111111" label="your wallet" />);
    expect(screen.getByText('banners.sanctionsMatchTitle')).toBeInTheDocument();
    expect(screen.getByText('banners.sanctionsMatchLine1')).toBeInTheDocument();
  });

  it('renders nothing when the address is clean', () => {
    sanctionsState.current = { isSanctioned: false, loading: false };
    const { container } = render(
      <SanctionsBanner address="0x2222222222222222222222222222222222222222" label="your wallet" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the sanctions read is loading', () => {
    sanctionsState.current = { isSanctioned: true, loading: true };
    const { container } = render(
      <SanctionsBanner address="0x3333333333333333333333333333333333333333" label="your wallet" />,
    );
    // Even with isSanctioned true, a still-loading read must not flash the banner.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no address is connected', () => {
    sanctionsState.current = { isSanctioned: false, loading: false };
    const { container } = render(<SanctionsBanner address={null} label="your wallet" />);
    expect(container).toBeEmptyDOMElement();
  });
});
