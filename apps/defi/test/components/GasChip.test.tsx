import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GasChip } from '../../src/components/app/GasChip';

describe('GasChip', () => {
  // 21_000 gas × 30 gwei → 0.00063 ETH total
  //   21_000 * 30_000_000_000 = 630_000_000_000_000 wei
  //   formatUnits(630_000_000_000_000, 18) = "0.00063"
  const STANDARD_GAS = 21_000n;
  const THIRTY_GWEI = 30_000_000_000n; // 30 * 1e9 wei

  it('renders native amount + symbol when no USD price is supplied', () => {
    const { container } = render(
      <GasChip
        gasUnits={STANDARD_GAS}
        gasPriceWei={THIRTY_GWEI}
        nativeSymbol="ETH"
      />,
    );
    expect(container.textContent).toMatch(/0\.00063\s*ETH/);
    // No USD qualifier when nativePriceUsd is undefined.
    expect(container.textContent).not.toMatch(/\$/);
  });

  it('appends the USD qualifier when nativePriceUsd is supplied', () => {
    // 0.00063 ETH × $3000/ETH = $1.89
    const { container } = render(
      <GasChip
        gasUnits={STANDARD_GAS}
        gasPriceWei={THIRTY_GWEI}
        nativeSymbol="ETH"
        nativePriceUsd={3000}
      />,
    );
    expect(container.textContent).toMatch(/0\.00063\s*ETH/);
    expect(container.textContent).toMatch(/\(~ \$1\.89\)/);
  });

  it('honours non-18-dec nativeDecimals when explicitly set', () => {
    // 21_000 × 30 gwei at 6-decimal native → much larger display
    //   630_000_000_000_000 / 10^6 = 630_000_000 native units
    const { container } = render(
      <GasChip
        gasUnits={STANDARD_GAS}
        gasPriceWei={THIRTY_GWEI}
        nativeDecimals={6}
        nativeSymbol="USDC"
      />,
    );
    // The chip should reflect the wider precision shift.
    expect(container.textContent).toMatch(/630000000\s*USDC/);
  });

  it('renders the pending placeholder when gasUnits is null', () => {
    const { container } = render(
      <GasChip
        gasUnits={null}
        gasPriceWei={THIRTY_GWEI}
        nativeSymbol="ETH"
      />,
    );
    const span = container.querySelector('span')!;
    expect(span.className).toMatch(/gas-chip-pending/);
    expect(container.textContent).toMatch(/—\s*ETH/);
  });

  it('renders the pending placeholder when gasPriceWei is null', () => {
    const { container } = render(
      <GasChip
        gasUnits={STANDARD_GAS}
        gasPriceWei={null}
        nativeSymbol="ETH"
      />,
    );
    const span = container.querySelector('span')!;
    expect(span.className).toMatch(/gas-chip-pending/);
  });

  it('renders the pending placeholder when gasUnits is undefined', () => {
    const { container } = render(
      <GasChip gasPriceWei={THIRTY_GWEI} nativeSymbol="ETH" />,
    );
    expect(container.querySelector('.gas-chip-pending')).toBeInTheDocument();
  });

  it('omits the USD qualifier on a non-finite nativePriceUsd', () => {
    const { container } = render(
      <GasChip
        gasUnits={STANDARD_GAS}
        gasPriceWei={THIRTY_GWEI}
        nativeSymbol="ETH"
        nativePriceUsd={Number.NaN}
      />,
    );
    expect(container.textContent).not.toMatch(/\$/);
  });

  it('exposes the accessible name through role=status + aria-label', () => {
    const { container } = render(
      <GasChip
        gasUnits={STANDARD_GAS}
        gasPriceWei={THIRTY_GWEI}
        nativeSymbol="ETH"
      />,
    );
    const status = container.querySelector('.gas-chip')!;
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-label', 'Estimated network fee');
  });

  it('honours an ariaLabel override (e.g. cross-chain CCIP fee)', () => {
    const { container } = render(
      <GasChip
        gasUnits={STANDARD_GAS}
        gasPriceWei={THIRTY_GWEI}
        nativeSymbol="ETH"
        ariaLabel="Cross-chain CCIP fee"
      />,
    );
    expect(container.querySelector('.gas-chip')).toHaveAttribute(
      'aria-label',
      'Cross-chain CCIP fee',
    );
  });

  it('passes through className', () => {
    const { container } = render(
      <GasChip
        gasUnits={STANDARD_GAS}
        gasPriceWei={THIRTY_GWEI}
        nativeSymbol="ETH"
        className="extra"
      />,
    );
    const status = container.querySelector('.gas-chip')!;
    expect(status.className).toMatch(/gas-chip/);
    expect(status.className).toMatch(/extra/);
  });

  it('trims trailing zeros from the native amount for cleaner display', () => {
    // 50_000 × 40 gwei = 2_000_000_000_000_000 wei = 0.002 ETH
    const { container } = render(
      <GasChip
        gasUnits={50_000n}
        gasPriceWei={40_000_000_000n}
        nativeSymbol="ETH"
      />,
    );
    // formatUnits(2e15, 18) = "0.002" — already trimmed by the helper,
    // verify trailing zeros don't leak into the display.
    expect(container.textContent).toMatch(/0\.002\s*ETH/);
    expect(container.textContent).not.toMatch(/0\.00200/);
  });
});
