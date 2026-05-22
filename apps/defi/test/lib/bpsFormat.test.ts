import { describe, it, expect } from 'vitest';
import { formatBps, bpsToDisplay, bpsToTooltip } from '../../src/lib/bpsFormat';

describe('formatBps', () => {
  it('renders typical interest-rate BPS at default precision 2', () => {
    expect(formatBps(505)).toEqual({
      display: '5.05 %',
      tooltip: '5.05 % (505 bps)',
    });
  });

  it('renders treasury-fee 100 bps as 1.00 %', () => {
    expect(formatBps(100)).toEqual({
      display: '1.00 %',
      tooltip: '1.00 % (100 bps)',
    });
  });

  it('renders sub-1% (LIF 10 bps) without losing the leading zero', () => {
    expect(formatBps(10)).toEqual({
      display: '0.10 %',
      tooltip: '0.10 % (10 bps)',
    });
  });

  it('renders 0 explicitly (zero-rate offer)', () => {
    expect(formatBps(0)).toEqual({
      display: '0.00 %',
      tooltip: '0.00 % (0 bps)',
    });
  });

  it('renders negative bps for downgrade-indicator chips', () => {
    expect(formatBps(-50)).toEqual({
      display: '-0.50 %',
      tooltip: '-0.50 % (-50 bps)',
    });
  });

  it('honours custom precision 1 (compact HF / LTV chips)', () => {
    // 505 / 100 = 5.05; toFixed(1) → "5.1" (rounds half-up on V8 / SpiderMonkey)
    expect(formatBps(505, { precision: 1 })).toEqual({
      display: '5.1 %',
      tooltip: '5.1 % (505 bps)',
    });
  });

  it('honours custom precision 3 (tier-comparison tables)', () => {
    expect(formatBps(12, { precision: 3 })).toEqual({
      display: '0.120 %',
      tooltip: '0.120 % (12 bps)',
    });
  });

  it('drops the BPS qualifier when withBpsHint=false', () => {
    expect(formatBps(505, { withBpsHint: false })).toEqual({
      display: '5.05 %',
      tooltip: '5.05 %',
    });
  });

  it('renders an em-dash placeholder when bps is NaN', () => {
    expect(formatBps(Number.NaN)).toEqual({
      display: '— %',
      tooltip: '—',
    });
  });

  it('renders an em-dash placeholder when bps is Infinity', () => {
    expect(formatBps(Number.POSITIVE_INFINITY)).toEqual({
      display: '— %',
      tooltip: '—',
    });
  });

  it('bpsToDisplay convenience returns just the display string', () => {
    expect(bpsToDisplay(505)).toBe('5.05 %');
  });

  it('bpsToTooltip convenience returns just the tooltip string', () => {
    expect(bpsToTooltip(505)).toBe('5.05 % (505 bps)');
  });
});
