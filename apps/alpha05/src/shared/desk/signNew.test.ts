import { describe, expect, it } from 'vitest';
import { parseStoredOrderJson, canonicalOrderJson } from '@vaipakam/lib/signedOfferWire';
import { createParams } from '../post/postModel';
import type { IndexerPoster } from '../reads/world/indexerClient';
import {
  identityOf,
  listSignedOrder,
  refusalSentence,
  signBlockers,
  signDraftFrom,
  signedOrderFrom,
  signNewReceipt,
  stakeShortfall,
  type SignReview,
} from './signNew';
import { bookAnswer, orderHashOf, randomNonce, signedOfferDomain } from './signedOrder';
import { checkTicket, DEFAULT_TICKET, ticketDraft, type TicketContext, type TicketInput } from './ticket';

type Hex = `0x${string}`;

const WETH = '0x00000000000000000000000000000000000000A1' as Hex;
const LIQ = '0x00000000000000000000000000000000000000B2' as Hex;
const ME = '0x00000000000000000000000000000000000000C3' as Hex;
const DIAMOND = '0x00000000000000000000000000000000000000e5' as Hex;
const market = { lending: WETH, collateral: LIQ, durationDays: 30 };
const ctx: TicketContext = {
  connected: true,
  sameNetwork: true,
  market,
  config: { maxDurationDays: 365n },
  decimals: { lending: 18, collateral: 6 },
  terms: 'ready',
};
const NOW = 1_000_000n;

function draftOf(patch: Partial<TicketInput> = {}) {
  const input: TicketInput = { ...DEFAULT_TICKET, amount: '0.5', collateral: '250', rate: '6', mode: 'sign', ...patch };
  const checked = checkTicket(input, ctx);
  if (!checked.ok) throw new Error(`ticket blocked: ${checked.blocker.code}`);
  return ticketDraft(input, checked, market, NOW);
}

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}(${Object.values(v).join(',')})`,
};
const amount = (asset: Hex, v: bigint) => `${v} of ${asset.slice(-2)}`;

describe('the ticket in sign mode (OFF-59)', () => {
  it('fills all or none whatever was picked for posting, and keeps that pick for posting', () => {
    const input: TicketInput = { ...DEFAULT_TICKET, amount: '0.5', collateral: '250', rate: '6', fillMode: 'partial', minFill: 'ignored', mode: 'sign' };
    const checked = checkTicket(input, ctx);
    expect(checked).toMatchObject({ ok: true, minFill: 5n * 10n ** 17n, amount: 5n * 10n ** 17n });
    if (!checked.ok) throw new Error('blocked');
    expect(ticketDraft(input, checked, market, NOW).parsed.fillMode).toBe('aon');
    expect(input.fillMode).toBe('partial');
  });

  it('refuses an order that never lapses, since only an on-chain cancel would stop it', () => {
    expect(checkTicket({ ...DEFAULT_TICKET, amount: '0.5', collateral: '250', rate: '6', expiry: 'never', mode: 'sign' }, ctx)).toEqual({
      ok: false,
      blocker: { code: 'sign-never' },
    });
    // Posting it is another matter: a posted offer is cancelled like any other.
    expect(checkTicket({ ...DEFAULT_TICKET, amount: '0.5', collateral: '250', rate: '6', expiry: 'never', mode: 'post' }, ctx)).toMatchObject({ ok: true });
  });

  it('reads a ticket typed before sign mode as posting', () => {
    const { mode: _drop, ...old } = { ...DEFAULT_TICKET, amount: '0.5', collateral: '250', rate: '6', fillMode: 'partial' as const, minFill: '0.1' };
    void _drop;
    expect(checkTicket(old, ctx)).toMatchObject({ ok: true, minFill: 10n ** 17n });
  });
});

describe('signedOrderFrom', () => {
  it('signs the terms a posted offer would send, in the wire form the book stores', () => {
    const draft = draftOf();
    const o = signedOrderFrom(draft, ME, 42n);
    const p = createParams(draft.parsed, draft.pair, draft.expiresAt, draft.side);
    expect(o).toMatchObject({
      offerType: '0',
      lendingAsset: WETH.toLowerCase(),
      collateralAsset: LIQ.toLowerCase(),
      amount: String(p.amount),
      amountMax: String(p.amountMax),
      collateralAmount: '250000000',
      collateralAmountMax: '250000000',
      interestRateBps: '600',
      interestRateBpsMax: '600',
      durationDays: '30',
      fillMode: '1',
      creatorFull: false,
      creatorMaxCStar: '0',
      signer: ME.toLowerCase(),
      nonce: '42',
    });
    // The signature lapses with the order.
    expect(o.deadline).toBe(o.expiresAt);
    expect(BigInt(o.expiresAt)).toBe(NOW + 7n * 86_400n);
    // It is the canonical wire form: the book's own reader takes it as is.
    expect(parseStoredOrderJson(canonicalOrderJson(o))).toEqual({ order: o });
  });

  it('carries a borrower’s whole collateral as one figure', () => {
    const o = signedOrderFrom(draftOf({ side: 'borrower' }), ME, 1n);
    expect(o).toMatchObject({ offerType: '1', collateralAmount: '250000000', collateralAmountMax: '250000000', amount: o.amountMax });
  });

  it('refuses every shape a signed order cannot carry', () => {
    const d = draftOf();
    expect(() => signedOrderFrom({ ...d, expiresAt: 0n }, ME, 1n)).toThrow('expiry');
    expect(() => signedOrderFrom({ ...d, parsed: { ...d.parsed, fillMode: 'partial' } }, ME, 1n)).toThrow('one size');
    expect(() => signedOrderFrom({ ...d, parsed: { ...d.parsed, amount: 1n } }, ME, 1n)).toThrow('one size');
    expect(() => signedOrderFrom({ ...d, parsed: { ...d.parsed, collateralFloor: 1n } }, ME, 1n)).toThrow('one size');
    expect(() => signedOrderFrom({ ...d, parsed: { ...d.parsed, guardBps: 500 } }, ME, 1n)).toThrow('price guard');
    expect(() => signedOrderFrom({ ...d, pair: { ...d.pair, leg: { kind: 'erc721', tokenId: 1n } } }, ME, 1n)).toThrow('token collateral');
  });
});

describe('randomNonce and the domain', () => {
  it('reads 16 random bytes as one number', () => {
    expect(randomNonce((b) => b.fill(0xff))).toBe((1n << 128n) - 1n);
    expect(randomNonce((b) => b.fill(0))).toBe(0n);
    expect(randomNonce()).not.toBe(randomNonce());
  });

  it('binds the signature to one network and one deployment', () => {
    expect(signedOfferDomain(84532, DIAMOND)).toEqual({ name: 'Vaipakam SignedOffer', version: '1', chainId: 84532, verifyingContract: DIAMOND });
  });
});

describe('the review', () => {
  const sign = signDraftFrom(draftOf(), 84532, ME, 9n);
  const read = (free: SignReview['free'], chainNow = NOW + 10n): SignReview => ({ chainNow, free, readAt: 1 });

  it('is built once, for one wallet on one network', () => {
    expect(sign.identity).toBe(identityOf(84532, ME));
    expect(sign.orderHash).toBe(orderHashOf(sign.order));
  });

  it('stops the signature only for what would make it pointless or wrong', () => {
    const me = identityOf(84532, ME);
    expect(signBlockers(sign, read({ kind: 'read', amount: 0n }), { identity: me, bookConfigured: true })).toEqual([]);
    expect(signBlockers(sign, null, { identity: me, bookConfigured: false })).toEqual(['no-book']);
    expect(signBlockers(sign, null, { identity: identityOf(1, ME), bookConfigured: true })).toEqual(['identity']);
    expect(signBlockers(sign, read({ kind: 'read', amount: 0n }, BigInt(sign.order.expiresAt)), { identity: me, bookConfigured: true })).toEqual(['lapsed']);
  });

  it('states what the vault lacks, and never guesses an unread balance', () => {
    expect(stakeShortfall(sign, read({ kind: 'read', amount: 10n ** 17n }))).toBe(4n * 10n ** 17n);
    expect(stakeShortfall(sign, read({ kind: 'read', amount: 10n ** 18n }))).toBe(0n);
    expect(stakeShortfall(sign, read({ kind: 'unread', reason: 'rpc down' }))).toBeNull();
  });

  it('receipt: the order, its lapse, the whole fill, nothing set aside, the stake from the vault, and the vault now', () => {
    const r = signNewReceipt(sign, read({ kind: 'read', amount: 10n ** 17n }), amount, copy);
    expect(r.prompts).toBe(1);
    expect(r.rows.map((x) => x.label)).toEqual([
      'signNew.rowOrder',
      'signNew.rowLapses',
      'signNew.rowFills',
      'signNew.rowNow',
      'signNew.rowAtFill',
      'signNew.rowFree',
    ]);
    expect(r.rows[4]).toMatchObject({ value: { kind: 'amount', asset: WETH.toLowerCase(), amount: 5n * 10n ** 17n }, binding: true, movesOut: true });
    expect(r.consequences).toContain('signedOrders.onlyWay');
    expect(r.consequences).toContain(`signNew.short(${4n * 10n ** 17n} of a1)`);
    const unread = signNewReceipt(sign, read({ kind: 'unread', reason: 'rpc down' }), amount, copy);
    expect(unread.rows[5]!.value).toEqual({ kind: 'unknown', why: 'rpc down' });
    expect(unread.consequences.some((c) => typeof c === 'string' && c.startsWith('signNew.short'))).toBe(false);
  });
});

describe('listing on the offer book', () => {
  const sign = signDraftFrom(draftOf(), 84532, ME, 9n);
  const rec = { identity: sign.identity, chainId: 84532, order: sign.order, orderHash: sign.orderHash, signature: '0xabcd' as Hex };
  const poster = (answer: () => Promise<{ status: number; body: unknown }>, seen: unknown[] = []): IndexerPoster => ({
    origin: 'https://index.test',
    postJson: async (path, body) => {
      seen.push({ path, body });
      return answer();
    },
  });

  it('posts the order and its signature, and reads the answer by status', async () => {
    const seen: unknown[] = [];
    expect(
      await listSignedOrder(
        poster(async () => ({ status: 201, body: { chainId: 84532, orderHash: sign.orderHash.toUpperCase().replace('0X', '0x') } }), seen),
        rec,
      ),
    ).toEqual({
      kind: 'listed',
      orderHash: sign.orderHash,
      fresh: true,
    });
    expect(seen).toEqual([{ path: '/signed-offers', body: { chainId: 84532, order: sign.order, signature: '0xabcd' } }]);
    expect(
      await listSignedOrder(
        poster(async () => ({ status: 200, body: { orderHash: sign.orderHash } })),
        rec,
      ),
    ).toMatchObject({ kind: 'listed', fresh: false });
    expect(
      await listSignedOrder(
        poster(async () => ({ status: 409, body: { error: 'nonce-used' } })),
        rec,
      ),
    ).toEqual({ kind: 'refused', code: 'nonce-used' });
  });

  it('never reads a listing that names another order, a 5xx or no answer as anything but unknown', async () => {
    expect(
      (
        await listSignedOrder(
          poster(async () => ({ status: 201, body: { orderHash: `0x${'1'.repeat(64)}` } })),
          rec,
        )
      ).kind,
    ).toBe('unknown');
    expect(
      (
        await listSignedOrder(
          poster(async () => ({ status: 503, body: { error: 'chain-not-configured' } })),
          rec,
        )
      ).kind,
    ).toBe('unknown');
    expect(
      (
        await listSignedOrder(
          poster(async () => ({ status: 400, body: null })),
          rec,
        )
      ).kind,
    ).toBe('unknown');
    expect(
      await listSignedOrder(
        poster(async () => {
          throw new Error('offline');
        }),
        rec,
      ),
    ).toEqual({ kind: 'unknown', reason: 'offline' });
  });

  it('bookAnswer needs the order it was sent', () => {
    expect(bookAnswer(201, { orderHash: sign.orderHash }, sign.orderHash)).toEqual({ kind: 'listed', orderHash: sign.orderHash, fresh: true });
    expect(bookAnswer(201, {}, sign.orderHash).kind).toBe('unknown');
    expect(bookAnswer(429, { error: 'rate-limited' }, sign.orderHash)).toEqual({ kind: 'refused', code: 'rate-limited' });
  });

  it('names the refusals the book shares with the chain, and quotes any other', () => {
    expect(refusalSentence('bad-signature', copy)).toBe('signNew.refusedSignature');
    expect(refusalSentence('order-consumed', copy)).toBe('signNew.refusedUsed');
    expect(refusalSentence('expired', copy)).toBe('signNew.refusedLapsed');
    expect(refusalSentence('ranged-collateral-ratio', copy)).toBe('signNew.refusedCode(ranged-collateral-ratio)');
  });
});
