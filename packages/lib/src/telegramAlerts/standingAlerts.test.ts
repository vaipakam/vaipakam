/**
 * #3681 — the three standing-instruction alerts: what the parser admits (no
 * shortfall without a due time, no amount on a top-up's "reserve empty", a
 * shortfall only on a short-reserve skip), and what the rendered message
 * states (the figures it was given, an unread health factor said as unread,
 * the agent's own link) in every locale.
 */
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from './hfCopy';
import { parseAddressedAlert, renderTelegramAlert, type AddressedAlert } from './message';
import { STANDING_INSTRUCTIONS, STANDING_SKIP_REASONS, standingSkipReason } from './standingCopy';

const WALLET = '0xAbC0000000000000000000000000000000000001';
const DUE = 1_800_000_000;
const ctx = { locale: 'en', chainName: 'Base Sepolia', appOrigin: 'https://app.example' };
const msg = (alert: Record<string, unknown>) => ({ chainId: 84532, wallet: WALLET, alert });
const parse = (alert: Record<string, unknown>) => parseAddressedAlert(msg(alert));
const render = (alert: Record<string, unknown>, locale = 'en') =>
  renderTelegramAlert(parse(alert) as AddressedAlert, { ...ctx, locale }).text;
const utc = new Date(DUE * 1000).toISOString().slice(0, 16).replace('T', ' ');

const low = (over: Record<string, unknown> = {}) => ({ kind: 'standingReserveLow', loanId: 5, instruction: 'repay', missing: '12.5 USDC', dueAt: DUE, ...over });
const topUp = (over: Record<string, unknown> = {}) => ({ kind: 'standingTopUp', loanId: 5, amount: '0.4 WETH', hfBefore: 1.12, hfAfter: 1.4, reserveLeft: '0.6 WETH', ...over });
const skipped = (over: Record<string, unknown> = {}) => ({ kind: 'standingSkipped', loanId: 5, instruction: 'interest', reason: 'loanBusy', missing: null, ...over });

describe('standing-instruction alerts: parsing', () => {
  it('accepts every well-formed shape', () => {
    const shapes = [
      low(),
      low({ instruction: 'interest' }),
      low({ missing: null }),
      low({ missing: null, dueAt: null }),
      low({ instruction: 'topUp', missing: null, dueAt: null }),
      topUp(),
      topUp({ hfAfter: null }),
      ...STANDING_INSTRUCTIONS.flatMap((instruction) => STANDING_SKIP_REASONS.map((reason) => skipped({ instruction, reason }))),
      skipped({ instruction: 'repay', reason: 'reserveShort', missing: '3 USDC' }),
    ];
    for (const a of shapes) expect(parse(a), JSON.stringify(a)).not.toBeNull();
  });

  it('refuses a shape that would state something the chain did not show', () => {
    // A shortfall needs the time it is measured against.
    expect(parse(low({ dueAt: null }))).toBeNull();
    // A top-up spends no known amount at no known time.
    expect(parse(low({ instruction: 'topUp', missing: null, dueAt: DUE }))).toBeNull();
    expect(parse(low({ instruction: 'topUp', missing: '1 WETH', dueAt: null }))).toBeNull();
    // Only a short reserve carries a shortfall.
    expect(parse(skipped({ reason: 'paused', missing: '1 USDC' }))).toBeNull();
    // An unknown instruction or reason, or a missing figure.
    expect(parse(low({ instruction: 'liquidate' }))).toBeNull();
    expect(parse(skipped({ reason: 'whatever' }))).toBeNull();
    expect(parse(topUp({ amount: null }))).toBeNull();
    expect(parse(topUp({ reserveLeft: undefined }))).toBeNull();
    expect(parse(topUp({ hfBefore: -1 }))).toBeNull();
    expect(parse(topUp({ hfAfter: Number.POSITIVE_INFINITY }))).toBeNull();
  });

  it('refuses free text that could carry a link, and leaders a bare domain', () => {
    expect(parse(topUp({ amount: '1 https://evil.example' }))).toBeNull();
    expect(parse(low({ missing: 'a:b' }))).toBeNull();
    const a = parse(topUp({ amount: '2 USDC.e' }))!.alert as { amount: string };
    expect(a.amount).toBe('2 USDC․e');
  });

  it('maps the contract skip codes in order, and refuses an unknown one', () => {
    expect(standingSkipReason(1)).toBe('holderChanged');
    expect(standingSkipReason(3)).toBe('reserveShort');
    expect(standingSkipReason(8)).toBe('notConsolidated');
    expect(standingSkipReason(0)).toBeNull();
    expect(standingSkipReason(9)).toBeNull();
  });
});

describe('standing-instruction alerts: rendering', () => {
  it('states the shortfall, the due time in UTC, and the all-or-nothing rule for a repayment', () => {
    const text = render(low());
    expect(text).toContain('12.5 USDC short');
    expect(text).toContain(utc);
    expect(text).toContain('whole repayment');
    expect(text).toContain('https://app.example/loans/5');
  });

  it('says an interest payment pays what the reserve holds', () => {
    expect(render(low({ instruction: 'interest' }))).toContain('the rest stays owed');
  });

  it('says an empty reserve as empty, with no figure', () => {
    expect(render(low({ missing: null }))).toContain('payment reserve for loan #5 on Base Sepolia is empty');
    expect(render(low({ instruction: 'topUp', missing: null, dueAt: null }))).toContain('collateral reserve');
  });

  it('states every top-up figure, and an unread health factor as not read', () => {
    const text = render(topUp());
    for (const part of ['0.4 WETH', '1.12', '1.40', '0.6 WETH']) expect(text).toContain(part);
    expect(render(topUp({ hfAfter: null }))).toContain('not read');
  });

  it('says a skip moved nothing, and why', () => {
    const text = render(skipped());
    expect(text).toContain('automatic interest payment');
    expect(text).toContain('nothing moved');
    expect(text).toContain('swap-to-repay order');
    expect(render(skipped({ instruction: 'repay', reason: 'reserveShort', missing: '3 USDC' }))).toContain('short by 3 USDC');
  });

  it('renders every shape in every locale, each with its figures and the link', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const a of [low(), low({ missing: null }), low({ instruction: 'topUp', missing: null, dueAt: null }), topUp(), topUp({ hfAfter: null }), ...STANDING_SKIP_REASONS.map((reason) => skipped({ reason }))]) {
        const text = render(a, locale);
        expect(text, `${locale} ${JSON.stringify(a)}`).toContain('https://app.example/loans/5');
        expect(text).toContain('5');
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('null');
      }
      expect(render(low(), locale)).toContain('12.5 USDC');
      expect(render(topUp(), locale)).toContain('0.6 WETH');
      if (locale !== 'en') expect(render(topUp(), locale)).not.toBe(render(topUp(), 'en'));
    }
  });
});
