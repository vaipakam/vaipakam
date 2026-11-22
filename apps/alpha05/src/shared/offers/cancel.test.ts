import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { OfferCancelFacetABI, VaultOutflowFacetABI } from '@vaipakam/contracts/abis';
import {
  CANCEL_COOLDOWN_SECONDS,
  cancelBlockers,
  cancelChanged,
  cancelReceipt,
  cancelRefund,
  cooldownEnds,
  isExpired,
  measureCancel,
  refundLeg,
  type CancelFacts,
  type CancelOffer,
  type CancelReview,
  type CancelWords,
} from './cancel';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const OTHER = '0x00000000000000000000000000000000000000e2' as Hex;
const TOKEN = '0x00000000000000000000000000000000000000a1' as Hex;
const COLL = '0x00000000000000000000000000000000000000a2' as Hex;
const NFT = '0x00000000000000000000000000000000000000b1' as Hex;
const VAULT = '0x00000000000000000000000000000000000000f1' as Hex;
const NOW = 1_800_000_000;

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`,
};
const words: CancelWords = { amount: (_a, v) => `${v}`, nft: (_a, _t, id, q) => `nft#${id}x${q}` };
const OPEN = { enabled: false, locked: false, delaySeconds: 0, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };
const PROTECTED = {
  enabled: true,
  locked: false,
  delaySeconds: 2 * 86_400,
  requireCosign: false,
  retired: false,
  controller: '0x0000000000000000000000000000000000000000' as const,
};

function offer(p: Partial<CancelOffer> = {}): CancelOffer {
  return {
    id: 9n,
    creator: ME,
    offerType: 0,
    accepted: false,
    assetType: 0,
    collateralAssetType: 0,
    lendingAsset: TOKEN,
    amount: 100n,
    amountMax: 0n,
    amountFilled: 0n,
    tokenId: 0n,
    quantity: 0n,
    durationDays: 30n,
    prepayAsset: TOKEN,
    collateralAsset: COLL,
    collateralAmount: 50n,
    collateralAmountMax: 0n,
    collateralAmountFilled: 0n,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    createdAt: BigInt(NOW - 3600),
    expiresAt: 0n,
    refinanceCarryOver: false,
    rentalBufferBpsAtCreate: 500,
    ...p,
  };
}

function review(o: CancelOffer | null, p: Partial<CancelFacts> = {}, r: Partial<CancelReview> = {}): CancelReview {
  const facts: CancelFacts = { offer: o, state: 'open', linkedLoanId: 0n, paused: false, protection: OPEN, chainNow: NOW, ...p };
  const route = facts.protection === null ? 'unknown' : 'credit';
  return { identity: 'i', offerId: 9n, facts, refund: o === null ? null : cancelRefund(o, facts.linkedLoanId), route, dryRun: null, readAt: 0, ...r };
}

describe('cancelRefund', () => {
  it('returns a lending offer’s unlent amount, using the range top when it has one', () => {
    expect(cancelRefund(offer(), 0n)).toEqual({ kind: 'erc20', asset: TOKEN, amount: 100n });
    expect(cancelRefund(offer({ amount: 100n, amountMax: 300n, amountFilled: 120n }), 0n)).toEqual({ kind: 'erc20', asset: TOKEN, amount: 180n });
    expect(cancelRefund(offer({ amount: 100n, amountFilled: 100n }), 0n)).toEqual({ kind: 'none' });
  });
  it('returns a lending offer’s NFT, one for an ERC-721 and the quantity for an ERC-1155', () => {
    expect(cancelRefund(offer({ assetType: 1, lendingAsset: NFT, tokenId: 4n }), 0n)).toEqual({ kind: 'nft', asset: NFT, assetType: 1, tokenId: 4n, quantity: 1n });
    expect(cancelRefund(offer({ assetType: 2, lendingAsset: NFT, tokenId: 4n, quantity: 3n }), 0n)).toEqual({ kind: 'nft', asset: NFT, assetType: 2, tokenId: 4n, quantity: 3n });
  });
  it('returns a request’s unused collateral, or its pledged NFT', () => {
    expect(cancelRefund(offer({ offerType: 1, collateralAmountMax: 80n, collateralAmountFilled: 30n }), 0n)).toEqual({ kind: 'erc20', asset: COLL, amount: 50n });
    expect(cancelRefund(offer({ offerType: 1, collateralAssetType: 1, collateralAsset: NFT, collateralTokenId: 2n }), 0n)).toEqual({
      kind: 'nft',
      asset: NFT,
      assetType: 1,
      tokenId: 2n,
      quantity: 1n,
    });
  });
  it('sizes a rental request’s prepay and buffer at the stamped rate', () => {
    // 10 a day for 30 days = 300, plus 5% = 315.
    expect(cancelRefund(offer({ offerType: 1, assetType: 1, amount: 10n, durationDays: 30n, rentalBufferBpsAtCreate: 500 }), 0n)).toEqual({
      kind: 'erc20',
      asset: TOKEN,
      amount: 315n,
    });
    expect(cancelRefund(offer({ offerType: 1, assetType: 1, rentalBufferBpsAtCreate: 0 }), 0n)).toEqual({ kind: 'measured', why: 'buffer' });
  });
  it('does not size an offer tied to a loan, or a refinance request that carries its collateral', () => {
    expect(cancelRefund(offer(), 5n)).toEqual({ kind: 'measured', why: 'linked' });
    expect(cancelRefund(offer({ offerType: 1, refinanceCarryOver: true }), 0n)).toEqual({ kind: 'measured', why: 'carryOver' });
  });
  it('does not take an unread loan link as no link', () => {
    expect(cancelRefund(offer({ offerType: 1 }), null)).toEqual({ kind: 'measured', why: 'linkUnread' });
  });
});

describe('expiry and cool-down', () => {
  it('reads expiry from the chain’s clock, with zero meaning no expiry', () => {
    expect(isExpired(offer({ expiresAt: 0n }), NOW)).toBe(false);
    expect(isExpired(offer({ expiresAt: BigInt(NOW) }), NOW)).toBe(true);
    expect(isExpired(offer({ expiresAt: BigInt(NOW + 1) }), NOW)).toBe(false);
  });
  it('binds the cool-down only to an unfilled, unexpired offer in its first five minutes', () => {
    const fresh = offer({ createdAt: BigInt(NOW - 10) });
    expect(cooldownEnds(fresh, NOW)).toBe(NOW - 10 + CANCEL_COOLDOWN_SECONDS);
    expect(cooldownEnds(offer({ createdAt: BigInt(NOW - 10), amountFilled: 1n }), NOW)).toBeNull();
    expect(cooldownEnds(offer({ createdAt: BigInt(NOW - 10), expiresAt: BigInt(NOW) }), NOW)).toBeNull();
    expect(cooldownEnds(offer({ createdAt: BigInt(NOW - CANCEL_COOLDOWN_SECONDS) }), NOW)).toBeNull();
  });
});

describe('cancelBlockers', () => {
  it('lets the creator cancel an open offer past the cool-down', () => {
    expect(cancelBlockers(review(offer()), ME, copy)).toEqual([]);
  });
  it('refuses a filled, cancelled or unread offer first', () => {
    expect(cancelBlockers(review(offer(), { state: 'accepted' }), ME, copy)).toEqual(['offerCancel.filled']);
    expect(cancelBlockers(review(offer(), { state: 'sale-consumed' }), ME, copy)).toEqual(['offerCancel.sold']);
    expect(cancelBlockers(review(null, { state: 'cancelled' }), ME, copy)).toEqual(['offerCancel.cancelled']);
    expect(cancelBlockers(review(offer(), { state: 'unknown' }), ME, copy)).toEqual(['offerCancel.unread']);
  });
  it('closes during a pause and says when the pause is unread', () => {
    expect(cancelBlockers(review(offer(), { paused: true }), ME, copy)).toEqual(['offerCancel.paused']);
    expect(cancelBlockers(review(offer(), { paused: null }), ME, copy)).toEqual(['offerCancel.pauseUnread']);
  });
  it('lets anyone clean up an expired offer, and only the creator cancel an unexpired one', () => {
    expect(cancelBlockers(review(offer()), OTHER, copy)).toEqual(['offerCancel.notCreator']);
    expect(cancelBlockers(review(offer({ expiresAt: BigInt(NOW - 1) }), { state: 'expired' }), OTHER, copy)).toEqual([]);
  });
  it('names the time the cool-down ends', () => {
    const [b] = cancelBlockers(review(offer({ createdAt: BigInt(NOW - 10) })), ME, copy);
    expect(b).toMatch(/^offerCancel\.cooldown:/);
  });
  it('stops on a refused or unread dry run', () => {
    expect(cancelBlockers(review(offer(), {}, { dryRun: 'unread' }), ME, copy)).toEqual(['offerCancel.dryRunUnread']);
    expect(cancelBlockers(review(offer(), {}, { dryRun: { code: 'X', reason: 'no', reopensAt: null, remedy: null } }), ME, copy)).toEqual([
      'offerCancel.dryRunRefused:{"reason":"no"}',
    ]);
  });
});

describe('cancelChanged', () => {
  it('names a change of state, return, route, pause or verdict', () => {
    const a = review(offer());
    expect(cancelChanged(a, review(offer()), copy)).toBeNull();
    expect(cancelChanged(a, review(offer(), { state: 'accepted' }), copy)).toBe('offerCancel.changedOffer');
    expect(cancelChanged(a, review(offer({ amountFilled: 10n })), copy)).toBe('offerCancel.changedOffer');
    // The return is freed in a vault whatever the account's protection, so
    // turning it on changes no route.
    expect(cancelChanged(a, review(offer(), { protection: PROTECTED }), copy)).toBeNull();
    expect(cancelChanged(a, review(offer(), { paused: true }), copy)).toBe('offerCancel.changedPause');
    expect(cancelChanged(a, review(offer(), {}, { dryRun: 'unread' }), copy)).toBe('offerCancel.changedVerdict');
  });
});

describe('cancelReceipt', () => {
  const rowText = (r: ReturnType<typeof cancelReceipt>, label: string) => {
    const row = r.rows.find((x) => x.label === label);
    return row && row.value.kind === 'text' ? row.value.text : row?.value.kind;
  };
  it('states what returns and that it is freed in the creator’s vault', () => {
    const r = cancelReceipt(review(offer()), ME, words, copy);
    expect(r.title).toBe('offerCancel.title');
    expect(rowText(r, 'offerCancel.rowReturns')).toBe('100');
    expect(rowText(r, 'offerCancel.rowTo')).toBe('payout.toCredit');
    expect(r.consequences).toContain('offerCancel.positionRetired');
    expect(r.consequences).toContain('offerCancel.race');
    expect(r.consequences).toContain('offerCancel.noApproval');
  });
  it('frees the return in the vault whatever the creator’s protection: nothing is queued', () => {
    const r = cancelReceipt(review(offer(), { protection: PROTECTED }), ME, words, copy);
    expect(rowText(r, 'offerCancel.rowTo')).toBe('payout.toCredit');
    expect(r.consequences).not.toContain('payout.queuedNote');
  });
  it('says a clean-up of someone else’s offer frees the return in the token holder’s vault', () => {
    const o = offer({ creator: OTHER, expiresAt: BigInt(NOW - 1) });
    const r = cancelReceipt(review(o, { state: 'expired', protection: PROTECTED }), ME, words, copy);
    expect(r.title).toBe('offerCancel.titleCleanup');
    expect(rowText(r, 'offerCancel.rowTo')).toBe('offerCancel.toHolderVault');
    expect(r.consequences.some((c) => typeof c === 'string' && c.startsWith('offerCancel.cleanupNotYours:'))).toBe(true);
    // The payee's own route notes speak to the payee, not to the reader.
    expect(r.consequences).not.toContain('payout.queuedNote');
  });
  it('states a return it cannot size as unknown, never as a figure', () => {
    const r = cancelReceipt(review(offer(), { linkedLoanId: 3n }), ME, words, copy);
    const row = r.rows.find((x) => x.label === 'offerCancel.rowReturns')!;
    expect(row.value).toEqual({ kind: 'unknown', why: 'offerCancel.measuredLinked' });
  });
  it('says the filled part stays filled', () => {
    const r = cancelReceipt(review(offer({ amountMax: 300n, amountFilled: 100n })), ME, words, copy);
    expect(r.consequences).toContain('offerCancel.partFilled');
  });
});

function cancelledLog(offerId: bigint, creator: Hex): Log {
  const topics = encodeEventTopics({ abi: OfferCancelFacetABI as Abi, eventName: 'OfferCanceled', args: { offerId, creator } });
  return { address: DIAMOND, topics, data: '0x' } as unknown as Log;
}

function outflowLog(owner: Hex, asset: Hex, delivered: bigint, opts: { to?: Hex; ref?: bigint; tokenId?: bigint; class_?: number } = {}): Log {
  const args = {
    owner,
    vault: VAULT,
    asset,
    tokenId: opts.tokenId ?? 0n,
    amount: delivered,
    delivered,
    to: opts.to ?? VAULT,
    class_: opts.class_ ?? 20,
    reason: 1,
    ref: opts.ref ?? 9n,
  };
  const abi = VaultOutflowFacetABI as Abi;
  const event = abi.find((e) => e.type === 'event' && e.name === 'VaultOutflow') as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName: 'VaultOutflow', args } as never);
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => (args as Record<string, unknown>)[i.name]));
  return { address: DIAMOND, topics, data } as unknown as Log;
}

function heldLog(offerId: bigint, holder: Hex, asset: Hex, amount: bigint, tokenId = 0n): Log {
  const abi = OfferCancelFacetABI as Abi;
  const args = { offerId, positionToken: 5n, holder, asset, tokenId, amount };
  const event = abi.find((e) => e.type === 'event' && e.name === 'OfferRefundHeld') as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName: 'OfferRefundHeld', args } as never);
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => (args as Record<string, unknown>)[i.name]));
  return { address: DIAMOND, topics, data } as unknown as Log;
}

describe('measureCancel', () => {
  it('reports no cancel when the logs record none', () => {
    const legs = measureCancel(review(offer()), [], DIAMOND, ME, words, copy);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.status).toBe('not-done');
  });
  it('measures the return the protocol freed in the creator’s vault against the review', () => {
    const legs = measureCancel(review(offer()), [cancelledLog(9n, ME), outflowLog(ME, TOKEN, 100n)], DIAMOND, ME, words, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'done']);
    expect(legs[1]!.label).toBe('offerCancel.legFreed:{"what":"100"}');
  });
  it('flags a return short of the review, and one never recorded', () => {
    const short = measureCancel(review(offer()), [cancelledLog(9n, ME), outflowLog(ME, TOKEN, 60n)], DIAMOND, ME, words, copy);
    expect(short[1]!.status).toBe('unknown');
    expect((short[1] as { reason?: string }).reason).toMatch(/^payout\.freedOther:/);
    const none = measureCancel(review(offer()), [cancelledLog(9n, ME)], DIAMOND, ME, words, copy);
    expect(none[1]!.status).toBe('not-done');
  });
  it('ignores a record for another offer, another class or another owner', () => {
    const logs = [cancelledLog(9n, ME), outflowLog(ME, TOKEN, 100n, { ref: 8n }), outflowLog(ME, TOKEN, 100n, { class_: 2 }), outflowLog(OTHER, TOKEN, 100n)];
    expect(measureCancel(review(offer()), logs, DIAMOND, ME, words, copy)[1]!.status).toBe('not-done');
  });
  it('measures a refund the protocol released in the creator’s own vault (a refinance request)', () => {
    const legs = measureCancel(review(offer()), [cancelledLog(9n, ME), outflowLog(ME, TOKEN, 100n, { class_: 19 })], DIAMOND, ME, words, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'done']);
    expect(legs[1]!.label).toBe('offerCancel.legFreed:{"what":"100"}');
  });
  it('says a refund kept for the offer token’s holder as held, never as nothing returned', () => {
    const o = offer({ creator: OTHER, expiresAt: BigInt(NOW - 1) });
    const HOLDER = '0x00000000000000000000000000000000000000c3' as Hex;
    const legs = measureCancel(review(o, { state: 'expired' }), [cancelledLog(9n, OTHER), heldLog(9n, HOLDER, TOKEN, 100n)], DIAMOND, ME, words, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'done']);
    expect(legs[1]!.label).toMatch(/^offerCancel\.legHeld:/);
    expect(legs[1]!.label).toContain('"what":"100"');
    // The reader holds the token: said to them.
    const mine = measureCancel(review(o, { state: 'expired' }), [cancelledLog(9n, OTHER), heldLog(9n, ME, TOKEN, 100n)], DIAMOND, ME, words, copy);
    expect(mine[1]!.label).toBe('offerCancel.legHeldMine:{"what":"100"}');
    // Held short of the review: said beside it.
    const short = measureCancel(review(o, { state: 'expired' }), [cancelledLog(9n, OTHER), heldLog(9n, HOLDER, TOKEN, 60n)], DIAMOND, ME, words, copy);
    expect(short[1]!.status).toBe('unknown');
    // Another offer's hold is not this one's.
    const other = measureCancel(review(o, { state: 'expired' }), [cancelledLog(9n, OTHER), heldLog(8n, HOLDER, TOKEN, 100n)], DIAMOND, ME, words, copy);
    expect(other[1]!.status).toBe('not-done');
  });
  it('names the holder’s vault when the return left the creator’s own', () => {
    const HOLDER_VAULT = '0x00000000000000000000000000000000000000f2' as Hex;
    const mine = measureCancel(review(offer()), [cancelledLog(9n, ME), outflowLog(ME, TOKEN, 100n, { to: HOLDER_VAULT })], DIAMOND, ME, words, copy);
    expect(mine[1]!.label).toBe('offerCancel.legFreedHolder:{"what":"100"}');
    const o = offer({ creator: OTHER, expiresAt: BigInt(NOW - 1) });
    const theirs = measureCancel(review(o, { state: 'expired' }), [cancelledLog(9n, OTHER), outflowLog(OTHER, TOKEN, 100n)], DIAMOND, ME, words, copy);
    expect(theirs[1]!.label).toBe('offerCancel.legFreedHolder:{"what":"100"}');
  });
  it('measures a return it could not size from what the protocol recorded', () => {
    const legs = measureCancel(review(offer(), { linkedLoanId: 3n }), [cancelledLog(9n, ME), outflowLog(ME, TOKEN, 42n)], DIAMOND, ME, words, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'done']);
    expect(legs[1]!.label).toBe('offerCancel.legFreed:{"what":"42"}');
  });
  it('measures an NFT a linked offer returns, rather than leaving it unmeasured', () => {
    const o = offer({ assetType: 1, lendingAsset: NFT, tokenId: 4n });
    const legs = measureCancel(review(o, { linkedLoanId: 3n }), [cancelledLog(9n, ME), outflowLog(ME, NFT, 1n, { tokenId: 4n })], DIAMOND, ME, words, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'done']);
    expect(legs[1]!.label).toBe('offerCancel.legFreed:{"what":"nft#4x1"}');
  });
  it('says a measured return moved nothing when nothing was freed', () => {
    const legs = measureCancel(review(offer(), { linkedLoanId: 3n }), [cancelledLog(9n, ME)], DIAMOND, ME, words, copy);
    expect(legs[1]).toEqual({ status: 'done', label: 'offerCancel.legNothingMine' });
    const nft = offer({ assetType: 1, lendingAsset: NFT, tokenId: 4n });
    expect(measureCancel(review(nft, { linkedLoanId: 3n }), [cancelledLog(9n, ME)], DIAMOND, ME, words, copy)[1]).toEqual({
      status: 'done',
      label: 'offerCancel.legNothingMine',
    });
  });
});

describe('refundLeg', () => {
  it('measures the asset the offer itself can return when the refund was not sized', () => {
    const measured = { kind: 'measured', why: 'linked' } as const;
    expect(refundLeg(offer(), measured)).toEqual({ kind: 'erc20', asset: TOKEN });
    expect(refundLeg(offer({ assetType: 2, lendingAsset: NFT, tokenId: 4n }), measured)).toEqual({ kind: 'nft', asset: NFT, assetType: 2, tokenId: 4n });
    expect(refundLeg(offer({ offerType: 1 }), measured)).toEqual({ kind: 'erc20', asset: COLL });
    expect(refundLeg(offer({ offerType: 1, collateralAssetType: 1, collateralAsset: NFT, collateralTokenId: 7n }), measured)).toEqual({
      kind: 'nft',
      asset: NFT,
      assetType: 1,
      tokenId: 7n,
    });
    expect(refundLeg(offer({ offerType: 1, assetType: 1 }), measured)).toEqual({ kind: 'erc20', asset: TOKEN });
  });
});
