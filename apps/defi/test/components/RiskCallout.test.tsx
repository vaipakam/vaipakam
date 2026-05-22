import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RiskCallout } from '../../src/components/app/RiskCallout';

/*
 * RiskDisclosures + RiskConsentLabel rely on react-i18next (`Trans` +
 * `useTranslation`). To keep this unit test focused on RiskCallout's
 * own behaviour (consent state, accessibility, extra-content slot),
 * mock the i18n surface at module scope and let the children render
 * lightweight stand-ins. The localisation of RiskDisclosures itself
 * is covered by its own tests (when added) + the i18n snapshot suite.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  // Some children use `withTranslation` / `Translation` indirectly via
  // the Trans component — add stubs to keep imports green.
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

/*
 * RiskDisclosures imports from `../../lib/marketingUrl` — pure utility,
 * no React state — so it doesn't need mocking. The component renders
 * static i18n keys (mocked to identity above) + a link element.
 */

describe('RiskCallout', () => {
  it('renders the consent checkbox unchecked when consent=false', () => {
    render(<RiskCallout consent={false} onConsentChange={() => {}} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('renders the consent checkbox checked when consent=true', () => {
    render(<RiskCallout consent={true} onConsentChange={() => {}} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('calls onConsentChange with the new state when toggled', () => {
    const onConsentChange = vi.fn();
    render(<RiskCallout consent={false} onConsentChange={onConsentChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onConsentChange).toHaveBeenCalledTimes(1);
    expect(onConsentChange).toHaveBeenCalledWith(true);
  });

  it('passes through unchecking — onConsentChange called with false', () => {
    const onConsentChange = vi.fn();
    render(<RiskCallout consent={true} onConsentChange={onConsentChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onConsentChange).toHaveBeenCalledWith(false);
  });

  it('disables the checkbox when disabled=true', () => {
    render(
      <RiskCallout
        consent={false}
        onConsentChange={() => {}}
        disabled
      />,
    );
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('does not fire onConsentChange when the checkbox is disabled', () => {
    const onConsentChange = vi.fn();
    render(
      <RiskCallout
        consent={false}
        onConsentChange={onConsentChange}
        disabled
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onConsentChange).not.toHaveBeenCalled();
  });

  it('wires aria-required so screen readers announce the consent gate', () => {
    render(<RiskCallout consent={false} onConsentChange={() => {}} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute(
      'aria-required',
      'true',
    );
  });

  it('exposes the colour-band wrapper as an aria-labelled region', () => {
    const { container } = render(
      <RiskCallout consent={false} onConsentChange={() => {}} />,
    );
    const region = container.querySelector('.risk-callout')!;
    expect(region).toHaveAttribute('role', 'region');
    // aria-labelledby must point at a non-empty id.
    const labelledBy = region.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = container.querySelector(`#${labelledBy}`);
    expect(heading).toBeInTheDocument();
  });

  it('renders an extra slot between the disclosures body and the consent row', () => {
    render(
      <RiskCallout
        consent={false}
        onConsentChange={() => {}}
        extra={<div data-testid="extra-slot">haircut: 5%</div>}
      />,
    );
    const extra = screen.getByTestId('extra-slot');
    expect(extra).toBeInTheDocument();
    expect(extra).toHaveTextContent('haircut: 5%');
  });

  it('appends a caller-provided className to the wrapper', () => {
    const { container } = render(
      <RiskCallout
        consent={false}
        onConsentChange={() => {}}
        className="extra-class"
      />,
    );
    const region = container.querySelector('.risk-callout')!;
    expect(region.className).toContain('risk-callout');
    expect(region.className).toContain('extra-class');
  });

  it('generates unique label-input id pairs across multiple instances', () => {
    const { container } = render(
      <div>
        <RiskCallout consent={false} onConsentChange={() => {}} />
        <RiskCallout consent={false} onConsentChange={() => {}} />
      </div>,
    );
    const checkboxes = container.querySelectorAll(
      'input[type="checkbox"]',
    );
    expect(checkboxes).toHaveLength(2);
    const idA = checkboxes[0].getAttribute('id');
    const idB = checkboxes[1].getAttribute('id');
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });
});
