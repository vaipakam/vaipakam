import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  HealthFactorGauge,
  LTVBar,
  HF_LIQUIDATION_THRESHOLD,
  HF_INITIATION_MIN,
  LTV_VOLATILITY_THRESHOLD,
} from '../../src/components/app/RiskGauge';

describe('HealthFactorGauge', () => {
  it('renders an em-dash when value is null', () => {
    render(<HealthFactorGauge value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('uses the safe zone when HF >= initiation minimum', () => {
    const { container } = render(<HealthFactorGauge value={2.0} />);
    const gauge = container.querySelector('.risk-gauge')!;
    expect(gauge.className).toMatch(/hf-safe/);
    expect(gauge.getAttribute('aria-label')).toMatch(/Above initiation minimum/i);
    expect(screen.getByText('2.00')).toBeInTheDocument();
  });

  it('uses the warning zone between liquidation and initiation minimum', () => {
    const { container } = render(<HealthFactorGauge value={1.2} />);
    const gauge = container.querySelector('.risk-gauge')!;
    expect(gauge.className).toMatch(/hf-warning/);
    expect(gauge.getAttribute('aria-label')).toMatch(/below initiation minimum/i);
  });

  it('uses the danger zone when HF < liquidation threshold', () => {
    const { container } = render(<HealthFactorGauge value={0.5} />);
    const gauge = container.querySelector('.risk-gauge')!;
    expect(gauge.className).toMatch(/hf-danger/);
    expect(gauge.getAttribute('aria-label')).toMatch(/Liquidation imminent/i);
  });

  it('caps the fill bar at 100% for extreme HF values', () => {
    const { container } = render(<HealthFactorGauge value={10} />);
    const fill = container.querySelector('.risk-gauge-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('exposes liquidation + initiation thresholds as constants', () => {
    expect(HF_LIQUIDATION_THRESHOLD).toBe(1.0);
    expect(HF_INITIATION_MIN).toBe(1.5);
  });
});

describe('LTVBar', () => {
  it('renders an em-dash when percent is null', () => {
    render(<LTVBar percent={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('uses the safe zone when LTV is well below 80%', () => {
    const { container } = render(<LTVBar percent={50} />);
    const gauge = container.querySelector('.risk-gauge')!;
    expect(gauge.className).toMatch(/ltv-safe/);
    expect(gauge.getAttribute('aria-label')).toMatch(/Well under/i);
    expect(screen.getByText('50.00%')).toBeInTheDocument();
  });

  it('uses the warning zone between 80% and the volatility-collapse threshold', () => {
    const { container } = render(<LTVBar percent={95} />);
    const gauge = container.querySelector('.risk-gauge')!;
    expect(gauge.className).toMatch(/ltv-warning/);
    expect(gauge.getAttribute('aria-label')).toMatch(/Approaching/i);
  });

  it('uses the danger zone at the volatility-collapse threshold', () => {
    const { container } = render(<LTVBar percent={LTV_VOLATILITY_THRESHOLD} />);
    const gauge = container.querySelector('.risk-gauge')!;
    expect(gauge.className).toMatch(/ltv-danger/);
    expect(gauge.getAttribute('aria-label')).toMatch(/Volatility-collapse threshold reached/i);
  });

  it('caps the fill bar at 100% when LTV exceeds 120%', () => {
    const { container } = render(<LTVBar percent={200} />);
    const fill = container.querySelector('.risk-gauge-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('exposes the volatility-collapse threshold as a constant', () => {
    expect(LTV_VOLATILITY_THRESHOLD).toBe(110);
  });
});
