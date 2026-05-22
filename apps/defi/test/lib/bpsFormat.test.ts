import { describe, it, expect } from 'vitest';
import { formatBps, bpsToDisplay, bpsToTooltip } from '../../src/lib/bpsFormat';

// Pin locale to 'en' for the legacy assertions — the runtime
// default (Node 22 in CI, JSDOM in local) returns 'en' but pinning
// it explicitly removes the implicit-default fragility.
const EN: { locale: string } = { locale: 'en' };

describe('formatBps', () => {
  it('renders typical interest-rate BPS at default precision 2', () => {
    expect(formatBps(505, EN)).toEqual({
      display: '5.05 %',
      tooltip: '5.05 % (505 bps)',
    });
  });

  it('renders treasury-fee 100 bps as 1.00 %', () => {
    expect(formatBps(100, EN)).toEqual({
      display: '1.00 %',
      tooltip: '1.00 % (100 bps)',
    });
  });

  it('renders sub-1% (LIF 10 bps) without losing the leading zero', () => {
    expect(formatBps(10, EN)).toEqual({
      display: '0.10 %',
      tooltip: '0.10 % (10 bps)',
    });
  });

  it('renders 0 explicitly (zero-rate offer)', () => {
    expect(formatBps(0, EN)).toEqual({
      display: '0.00 %',
      tooltip: '0.00 % (0 bps)',
    });
  });

  it('renders negative bps for downgrade-indicator chips', () => {
    // Intl.NumberFormat renders the minus as U+2212 ("MINUS SIGN")
    // in many locales, falling back to ASCII hyphen-minus on others;
    // both reads are valid.  We match the value-shape, not the byte.
    const r = formatBps(-50, EN);
    expect(r.display).toMatch(/^[-−]0\.50 %$/);
    expect(r.tooltip).toMatch(/^[-−]0\.50 % \([-−]50 bps\)$/);
  });

  it('honours custom precision 1 (compact HF / LTV chips)', () => {
    // 505 / 100 = 5.05; with min/maxFractionDigits=1 → "5.1"
    expect(formatBps(505, { ...EN, precision: 1 })).toEqual({
      display: '5.1 %',
      tooltip: '5.1 % (505 bps)',
    });
  });

  it('honours custom precision 3 (tier-comparison tables)', () => {
    expect(formatBps(12, { ...EN, precision: 3 })).toEqual({
      display: '0.120 %',
      tooltip: '0.120 % (12 bps)',
    });
  });

  it('drops the BPS qualifier when withBpsHint=false', () => {
    expect(formatBps(505, { ...EN, withBpsHint: false })).toEqual({
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
    expect(bpsToDisplay(505, EN)).toBe('5.05 %');
  });

  it('bpsToTooltip convenience returns just the tooltip string', () => {
    expect(bpsToTooltip(505, EN)).toBe('5.05 % (505 bps)');
  });

  it('routes through Intl.NumberFormat for non-English locales (French uses comma decimal)', () => {
    const r = formatBps(505, { locale: 'fr' });
    // French formatting: "5,05 %" (NB: Intl uses NBSP between number
    // and percent; we keep the explicit ASCII space in our suffix
    // glyph — the value-shape is `5,05 [SPACE] %`).
    expect(r.display).toMatch(/^5,05 %$/);
    expect(r.tooltip).toMatch(/^5,05 % \(505 bps\)$/);
  });
});
