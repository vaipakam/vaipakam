import { describe, expect, it } from 'vitest';
import {
  bindingWindow,
  inviteLink,
  parseInviterReferrals,
  recordLagSec,
} from './referrals';

const A = '0x00000000000000000000000000000000000000a1';
const USDC = '0x00000000000000000000000000000000000000c1';
const TX = `0x${'ab'.repeat(32)}`;

const share = (outcome: string, extra: Record<string, unknown> = {}) => ({
  loanId: '7',
  offerId: '107',
  newUser: A,
  asset: USDC,
  share: '50',
  outcome,
  blockNumber: 12,
  txHash: TX,
  settledAt: 1_700_000_000,
  ...extra,
});

const body = (over: Record<string, unknown> = {}) => ({
  chainId: 84532,
  inviter: '0xaa',
  indexedThroughBlock: 20,
  invited: {
    rows: [{ wallet: A, boundAt: 1_699_000_000, boundTx: TX, endsAt: 1_715_000_000, loansWithShare: 1 }],
    truncated: false,
  },
  received: { rows: [share('paid')], truncated: false, totals: [{ asset: USDC, amount: '50' }] },
  sentToReserve: { rows: [share('payment-failed')], truncated: true },
  ...over,
});

describe('parseInviterReferrals', () => {
  it('accepts a well-formed body and keeps the truncation flags', () => {
    const r = parseInviterReferrals(body(), 84532);
    expect(r?.received.totals).toEqual([{ asset: USDC, amount: '50' }]);
    expect(r?.sentToReserve.truncated).toBe(true);
    expect(r?.sentToReserve.rows[0].outcome).toBe('payment-failed');
  });

  it('refuses a body for another chain', () => {
    expect(parseInviterReferrals(body(), 1)).toBeNull();
  });

  it('refuses the whole list when one row is unreadable, rather than understate it', () => {
    const bad = body({ received: { rows: [share('paid'), share('paid', { share: '1.5' })], truncated: false, totals: [] } });
    expect(parseInviterReferrals(bad, 84532)).toBeNull();
  });

  it('refuses a reason it does not know, and a redirect in the paid list', () => {
    expect(parseInviterReferrals(body({ sentToReserve: { rows: [share('mystery')], truncated: false } }), 84532)).toBeNull();
    expect(parseInviterReferrals(body({ received: { rows: [share('delivered-short')], truncated: false, totals: [] } }), 84532)).toBeNull();
  });

  it('keeps a withheld total as withheld', () => {
    const r = parseInviterReferrals(body({ received: { rows: [share('paid')], truncated: true, totals: null } }), 84532);
    expect(r?.received.totals).toBeNull();
  });

  it('keeps a record that has not started as not started', () => {
    expect(parseInviterReferrals(body({ indexedThroughBlock: null }), 84532)?.indexedThroughBlock).toBeNull();
  });
});

describe('bindingWindow', () => {
  it('runs until its end time inclusive, against chain time', () => {
    expect(bindingWindow(1000, 1000)).toEqual({ ended: false, daysLeft: 0 });
    expect(bindingWindow(1000, 1001)).toEqual({ ended: true, daysLeft: 0 });
  });

  it('rounds the days left up', () => {
    expect(bindingWindow(86_400 + 3600, 0).daysLeft).toBe(2);
    expect(bindingWindow(86_400, 0).daysLeft).toBe(1);
  });
});

describe('inviteLink', () => {
  it('carries the address only', () => {
    expect(inviteLink('https://app.example/', A)).toBe(`https://app.example/invite/${A}`);
  });
});

describe('recordLagSec', () => {
  it('is unknown when either timestamp is', () => {
    expect(recordLagSec(null, 5)).toBeNull();
    expect(recordLagSec(5, null)).toBeNull();
  });

  it('never reads a record as ahead of the chain', () => {
    expect(recordLagSec(100, 160)).toBe(0);
    expect(recordLagSec(1000, 400)).toBe(600);
  });
});
