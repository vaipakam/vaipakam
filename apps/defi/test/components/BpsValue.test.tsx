import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BpsValue } from '../../src/components/app/BpsValue';

// BpsValue calls `useTranslation()` to read the active locale. Mock the
// hook at module scope so the suite stays focused on the component's
// behaviour; pin the mock to `en` so the test assertions don't depend
// on the runtime's default-locale resolution.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() },
  }),
}));

describe('BpsValue', () => {
  it('renders the display percent in the visible slot', () => {
    render(<BpsValue bps={505} />);
    expect(screen.getByText('5.05 %')).toBeInTheDocument();
  });

  it('wires the tooltip with both percent and bps qualifier', () => {
    const { container } = render(<BpsValue bps={505} />);
    const span = container.querySelector('span')!;
    expect(span).toHaveAttribute('title', '5.05 % (505 bps)');
  });

  it('honours custom precision', () => {
    render(<BpsValue bps={1234} precision={1} />);
    expect(screen.getByText('12.3 %')).toBeInTheDocument();
  });

  it('drops the bps qualifier from the tooltip when withBpsHint=false', () => {
    const { container } = render(<BpsValue bps={505} withBpsHint={false} />);
    const span = container.querySelector('span')!;
    expect(span).toHaveAttribute('title', '5.05 %');
  });

  it('omits the title attribute entirely when withTitle=false', () => {
    const { container } = render(<BpsValue bps={505} withTitle={false} />);
    const span = container.querySelector('span')!;
    expect(span).not.toHaveAttribute('title');
  });

  it('passes through className', () => {
    const { container } = render(<BpsValue bps={505} className="extra" />);
    const span = container.querySelector('span')!;
    expect(span.className).toBe('extra');
  });

  it('renders the em-dash placeholder for NaN inputs', () => {
    const { container } = render(<BpsValue bps={Number.NaN} />);
    const span = container.querySelector('span')!;
    expect(span.textContent).toBe('— %');
    expect(span).toHaveAttribute('title', '—');
  });
});
