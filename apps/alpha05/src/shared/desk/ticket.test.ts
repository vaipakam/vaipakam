import { describe, expect, it } from 'vitest';
import { createParams } from '../post/postModel';
import { balanceText, checkTicket, DEFAULT_TICKET, stakeField, ticketDraft, type TicketContext, type TicketInput } from './ticket';

const WETH = '0x00000000000000000000000000000000000000a1' as const;
const LIQ = '0x00000000000000000000000000000000000000b2' as const;
const market = { lending: WETH, collateral: LIQ, durationDays: 30 };
const ready: TicketContext = {
  connected: true,
  sameNetwork: true,
  market,
  config: { maxDurationDays: 365n },
  decimals: { lending: 18, collateral: 6 },
  terms: 'ready',
};
const filled: TicketInput = { ...DEFAULT_TICKET, amount: '1.5', collateral: '3000', rate: '7.25' };

describe('checkTicket (OFF-74)', () => {
  it('parses every figure exactly when nothing is in the way', () => {
    expect(checkTicket(filled, ready)).toEqual({ ok: true, amount: 15n * 10n ** 17n, minFill: 15n * 10n ** 17n, collateral: 3_000_000_000n, rateBps: 725n });
  });

  it('reports only the first blocker, in the fixed order', () => {
    const empty = DEFAULT_TICKET;
    expect(checkTicket(empty, { ...ready, connected: false })).toEqual({ ok: false, blocker: { code: 'connect' } });
    expect(checkTicket(empty, { ...ready, sameNetwork: false })).toEqual({ ok: false, blocker: { code: 'network' } });
    expect(checkTicket(empty, { ...ready, market: null })).toEqual({ ok: false, blocker: { code: 'no-market' } });
    expect(checkTicket(empty, { ...ready, config: null })).toEqual({ ok: false, blocker: { code: 'loading' } });
    expect(checkTicket(empty, { ...ready, terms: 'loading' })).toEqual({ ok: false, blocker: { code: 'loading' } });
    expect(checkTicket(empty, { ...ready, decimals: { failed: 'rpc down' } })).toEqual({ ok: false, blocker: { code: 'unread', reason: 'rpc down' } });
    expect(checkTicket(empty, { ...ready, config: { maxDurationDays: 14n } })).toEqual({ ok: false, blocker: { code: 'term-closed', maxDays: 14n } });
    expect(checkTicket(empty, ready)).toEqual({ ok: false, blocker: { code: 'field', field: 'amount', error: 'empty' } });
    expect(checkTicket({ ...filled, collateral: '1.0000001' }, ready)).toEqual({
      ok: false,
      blocker: { code: 'field', field: 'collateral', error: 'decimals' },
    });
    expect(checkTicket({ ...filled, rate: '101' }, ready)).toEqual({ ok: false, blocker: { code: 'rate', error: 'high' } });
    expect(checkTicket({ ...filled, fillMode: 'partial' }, ready)).toEqual({ ok: false, blocker: { code: 'field', field: 'minFill', error: 'empty' } });
    expect(checkTicket({ ...filled, fillMode: 'partial', minFill: '1.5' }, ready)).toEqual({ ok: false, blocker: { code: 'min-fill' } });
    expect(checkTicket({ ...filled, fillMode: 'ioc', minFill: '0.5', expiry: 'never' }, ready)).toEqual({
      ok: false,
      blocker: { code: 'fill', block: 'ioc-open' },
    });
    expect(checkTicket(filled, { ...ready, terms: { failed: 'no answer' } })).toEqual({ ok: false, blocker: { code: 'terms-unread', reason: 'no answer' } });
  });

  it('never rounds a typed amount: more decimals than the token has stop the ticket', () => {
    expect(checkTicket({ ...filled, amount: '0.0000000000000000001' }, ready)).toEqual({
      ok: false,
      blocker: { code: 'field', field: 'amount', error: 'decimals' },
    });
  });
});

describe('the smallest single fill', () => {
  it('all or none reads no smallest fill and posts one amount', () => {
    const checked = checkTicket({ ...filled, minFill: 'not read' }, ready);
    expect(checked).toMatchObject({ ok: true, minFill: 15n * 10n ** 17n });
  });

  it('a partial ticket posts from the smallest fill to the whole amount, so a match can fill a part', () => {
    const input: TicketInput = { ...filled, fillMode: 'partial', minFill: '0.25' };
    const checked = checkTicket(input, ready);
    if (!checked.ok) throw new Error('expected ok');
    const d = ticketDraft(input, checked, market, 1n);
    expect([d.parsed.amount, d.parsed.amountMax]).toEqual([25n * 10n ** 16n, 15n * 10n ** 17n]);
    expect(d.parsed.collateralFloor).toBe(d.parsed.collateral);
    expect(createParams(d.parsed, d.pair, d.expiresAt, d.side)).toMatchObject({ amount: 25n * 10n ** 16n, amountMax: 15n * 10n ** 17n, fillMode: 0 });
  });
});

describe('ticketDraft', () => {
  it('posts one amount at the market’s term with the guided flows’ defaults and an expiry from the chain clock', () => {
    const checked = checkTicket({ ...filled, side: 'borrower', fillMode: 'aon', expiry: '1d' }, ready);
    if (!checked.ok) throw new Error('expected ok');
    const d = ticketDraft({ ...filled, side: 'borrower', fillMode: 'aon', expiry: '1d' }, checked, market, 1_000n);
    expect(d.side).toBe('borrower');
    expect(d.expiresAt).toBe(1_000n + 86_400n);
    expect(d.parsed).toMatchObject({
      amountMax: d.parsed.amount,
      collateralFloor: d.parsed.collateral,
      durationDays: 30,
      cadence: 0,
      tariff: null,
      guardBps: null,
      fullTerm: true,
      allowsPartialRepay: false,
    });
    const params = createParams(d.parsed, d.pair, d.expiresAt, d.side);
    expect(params).toMatchObject({
      offerType: 1,
      lendingAsset: WETH,
      collateralAsset: LIQ,
      durationDays: 30n,
      interestRateBps: 725n,
      interestRateBpsMax: 725n,
      fillMode: 1,
    });
  });

  it('an offer that never lapses stores no expiry', () => {
    const checked = checkTicket({ ...filled, expiry: 'never' }, ready);
    if (!checked.ok) throw new Error('expected ok');
    expect(ticketDraft({ ...filled, expiry: 'never' }, checked, market, 5n).expiresAt).toBe(0n);
  });
});

describe('fill to balance', () => {
  it('fills the field posting locks, with every digit of the balance', () => {
    expect(stakeField('lender')).toBe('amount');
    expect(stakeField('borrower')).toBe('collateral');
    expect(balanceText(1_234_567_890_123_456_789n, 18)).toBe('1.234567890123456789');
    expect(balanceText(5_000_000n, 6)).toBe('5');
  });
});
