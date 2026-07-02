import { describe, expect, it } from 'vitest';
import { baseEligibilityItems, sanctionsAllowsProceed } from '../src/lib/eligibility';

const base = {
  address: '0xabc',
  connect: () => {},
  chainName: 'Base Sepolia',
  isCorrectChain: true,
  switchChain: () => {},
  consent: true,
};

describe('baseEligibilityItems', () => {
  it('omits sanctions row when wallet passes', () => {
    const items = baseEligibilityItems({
      ...base,
      isSanctioned: false,
      sanctionsLoading: false,
    });
    expect(items.some((i) => i.id === 'sanctions')).toBe(false);
  });

  it('shows a soft block row when wallet is flagged', () => {
    const items = baseEligibilityItems({
      ...base,
      isSanctioned: true,
      sanctionsLoading: false,
    });
    const row = items.find((i) => i.id === 'sanctions');
    expect(row?.label).toBe('This wallet cannot open new positions');
    expect(row?.ok).toBe(false);
  });

  it('shows loading row while screening is in flight', () => {
    const items = baseEligibilityItems({
      ...base,
      isSanctioned: false,
      sanctionsLoading: true,
    });
    expect(items.find((i) => i.id === 'sanctions')?.label).toBe('Checking wallet eligibility…');
  });

  it('fails closed when sanctions screening cannot be verified', () => {
    const items = baseEligibilityItems({
      ...base,
      isSanctioned: false,
      sanctionsLoading: false,
      sanctionsUnverified: true,
    });
    const row = items.find((i) => i.id === 'sanctions');
    expect(row?.label).toBe('Could not verify wallet eligibility');
    expect(row?.ok).toBe(false);
  });
});

describe('sanctionsAllowsProceed', () => {
  it('blocks while loading, flagged, or unverified', () => {
    expect(sanctionsAllowsProceed({ isSanctioned: false, sanctionsLoading: true })).toBe(false);
    expect(sanctionsAllowsProceed({ isSanctioned: true, sanctionsLoading: false })).toBe(false);
    expect(
      sanctionsAllowsProceed({ isSanctioned: false, sanctionsLoading: false, sanctionsUnverified: true }),
    ).toBe(false);
    expect(sanctionsAllowsProceed({ isSanctioned: false, sanctionsLoading: false })).toBe(true);
  });
});