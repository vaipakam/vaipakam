import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AutoLifecycleLoanCapsCard from '../../src/components/app/AutoLifecycleLoanCapsCard';

/*
 * #799 — the auto-lifecycle caps card must keep two best-effort signals visible:
 *  (1) a persistent best-effort warning WHILE caps are enabled (not just on the
 *      enable transition), and
 *  (2) a keeper kill-switch warning when the holder's keeper can't act, because
 *      an enabled cap is then inert.
 * Identity-`t` mock asserts on the i18n keys; the diamond read hook is mocked so
 * the card renders deterministic cap state without a chain.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: () => Promise.resolve() },
  }),
}));

const refinanceEnabled = {
  enabled: true,
  maxRateBps: 1500,
  maxNewExpiry: 0n,
  setter: '0x0000000000000000000000000000000000000000',
};
const extendDisabled = {
  enabled: false,
  minRateBps: 0,
  maxRateBps: 0,
  maxNewExpiry: 0n,
  setter: '0x0000000000000000000000000000000000000000',
};

vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondContract: () => null,
  useDiamondRead: () => ({
    getAutoRefinanceCaps: async () => refinanceEnabled,
    getAutoExtendBorrowerCaps: async () => extendDisabled,
    getAutoExtendLenderCaps: async () => extendDisabled,
  }),
}));

describe('AutoLifecycleLoanCapsCard — #799 best-effort persistence + keeper kill-switch', () => {
  it('shows the keeper kill-switch warning when the holder keeper cannot act', () => {
    render(
      <AutoLifecycleLoanCapsCard loanId={1n} isBorrower isLender={false} keeperCannotAct />,
    );
    expect(
      screen.getByText('autoLifecycleLoanCaps.keeperOffWarning'),
    ).toBeInTheDocument();
  });

  it('omits the keeper kill-switch warning when the keeper can act', () => {
    render(
      <AutoLifecycleLoanCapsCard
        loanId={1n}
        isBorrower
        isLender={false}
        keeperCannotAct={false}
      />,
    );
    expect(
      screen.queryByText('autoLifecycleLoanCaps.keeperOffWarning'),
    ).not.toBeInTheDocument();
  });

  it('shows the best-effort warning persistently while a saved cap is enabled', async () => {
    render(<AutoLifecycleLoanCapsCard loanId={1n} isBorrower isLender={false} />);
    // The refinance editor seeds `enabled` from the saved (already-enabled) cap,
    // so the best-effort warning must render even though this is not a fresh
    // false→true transition.
    expect(
      await screen.findByText('autoLifecycleLoanCaps.bestEffortWarning'),
    ).toBeInTheDocument();
  });

  it('renders nothing when the connected wallet holds neither side', () => {
    const { container } = render(
      <AutoLifecycleLoanCapsCard loanId={1n} isBorrower={false} isLender={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
