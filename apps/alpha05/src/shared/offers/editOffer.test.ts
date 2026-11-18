import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, zeroAddress as ZERO_ADDRESS, encodeEventTopics, parseAbi, type Abi, type Log } from 'viem';
import { OfferMutateFacetABI } from '@vaipakam/contracts/abis';
import {
  currentTerms,
  editBlockers,
  editChanged,
  editMove,
  editReceipt,
  editShape,
  measureEdit,
  termsProblems,
  type AmountWords,
  type EditFacts,
  type EditOfferRecord,
  type EditReview,
  type EditTerms,
} from './editOffer';
import { ratePrefill } from './WhyNotMatching';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const OTHER = '0x00000000000000000000000000000000000000e2' as Hex;
const TOKEN = '0x00000000000000000000000000000000000000a1' as Hex;
const COLL = '0x00000000000000000000000000000000000000a2' as Hex;
const VAULT = '0x00000000000000000000000000000000000000f1' as Hex;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const NOW = 1_800_000_000;

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`,
};
const words: AmountWords = (_a, v) => `${v}`;
const OPEN = { enabled: false, locked: false, delaySeconds: 0, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };

function record(p: Partial<EditOfferRecord> = {}): EditOfferRecord {
  return {
    id: 9n,
    creator: ME,
    offerType: 0,
    assetType: 0,
    collateralAssetType: 0,
    fillMode: 0,
    lendingAsset: TOKEN,
    collateralAsset: COLL,
    amount: 100n,
    amountMax: 200n,
    amountFilled: 0n,
    interestRateBps: 500n,
    interestRateBpsMax: 800n,
    collateralAmount: 300n,
    collateralAmountMax: 300n,
    collateralAmountFilled: 0n,
    durationDays: 30n,
    expiresAt: 0n,
    parallelSaleOrderHash: ZERO_HASH,
    refinanceTargetLoanId: 0n,
    backstopEligibleAfter: 0n,
    ...p,
  };
}

const with_ = (o: EditOfferRecord, p: Partial<EditTerms>): EditTerms => ({ ...currentTerms(o), ...p });

function facts(o: EditOfferRecord | null, p: Partial<EditFacts> = {}): EditFacts {
  return { offer: o, state: 'open', linkedLoanId: 0n, paused: false, protection: OPEN, minTermsAgeSec: 30n, chainNow: NOW, block: 1n, ...p };
}

function review(o: EditOfferRecord, terms: EditTerms, p: Partial<EditReview> = {}, f: Partial<EditFacts> = {}): EditReview {
  return {
    identity: 'id',
    offerId: o.id,
    terms,
    facts: facts(o, f),
    move: editMove(o, terms),
    balance: 1_000n,
    allowance: 0n,
    approvalSteps: 0,
    route: 'wallet',
    dryRun: null,
    readAt: 0,
    ...p,
  };
}

const short = (v: bigint) => `short:${v}`;

describe('editShape', () => {
  it('lets a lending offer change its rate, amount range and one collateral figure', () => {
    expect(editShape(record())).toEqual({ amount: true, amountRange: true, collateral: true, collateralRange: false });
  });
  it('gives a borrowing request a collateral range', () => {
    expect(editShape(record({ offerType: 1 })).collateralRange).toBe(true);
  });
  it('gives an all-or-nothing offer one amount', () => {
    expect(editShape(record({ fillMode: 1 })).amountRange).toBe(false);
  });
  it('fixes a refinance request’s amount and collateral', () => {
    expect(editShape(record({ offerType: 1, refinanceTargetLoanId: 4n }))).toEqual({ amount: false, amountRange: false, collateral: false, collateralRange: false });
  });
  it('offers no collateral figure for NFT collateral', () => {
    expect(editShape(record({ collateralAssetType: 1 })).collateral).toBe(false);
  });
});

describe('editMove', () => {
  it('pulls or releases a lending offer’s ceiling difference in the lending asset', () => {
    const o = record();
    expect(editMove(o, with_(o, { amountMax: 250n }))).toEqual({ kind: 'pull', asset: TOKEN, amount: 50n });
    expect(editMove(o, with_(o, { amountMax: 150n }))).toEqual({ kind: 'release', asset: TOKEN, amount: 50n });
    expect(editMove(o, with_(o, { amount: 150n }))).toEqual({ kind: 'none' });
  });
  it('moves nothing for a lending offer’s collateral or rate', () => {
    const o = record();
    expect(editMove(o, with_(o, { collateralAmount: 400n, collateralAmountMax: 400n, interestRateBps: 100n }))).toEqual({ kind: 'none' });
  });
  it('pulls or releases a request’s token collateral ceiling difference', () => {
    const o = record({ offerType: 1, collateralAmount: 300n, collateralAmountMax: 500n });
    expect(editMove(o, with_(o, { collateralAmountMax: 600n }))).toEqual({ kind: 'pull', asset: COLL, amount: 100n });
    expect(editMove(o, with_(o, { collateralAmountMax: 400n }))).toEqual({ kind: 'release', asset: COLL, amount: 100n });
    expect(editMove(o, with_(o, { amountMax: 900n }))).toEqual({ kind: 'none' });
  });
});

describe('termsProblems', () => {
  it('says when nothing changed', () => {
    const o = record();
    expect(termsProblems(o, currentTerms(o))).toEqual(['unchanged']);
  });
  it('checks only the clusters that change, as the protocol does', () => {
    const o = record({ amountFilled: 150n });
    expect(termsProblems(o, with_(o, { interestRateBps: 900n }))).toEqual(['rate-range']);
    expect(termsProblems(o, with_(o, { interestRateBpsMax: 10_001n }))).toEqual(['rate-high']);
    expect(termsProblems(o, with_(o, { interestRateBps: 0n, interestRateBpsMax: 0n }))).toEqual([]);
    expect(termsProblems(o, with_(o, { amountMax: 120n }))).toEqual(['amount-filled']);
    expect(termsProblems(o, with_(o, { amount: 0n }))).toEqual(['amount-zero']);
    expect(termsProblems(o, with_(o, { amount: 300n }))).toEqual(['amount-range']);
  });
  it('keeps one amount for an all-or-nothing offer and one collateral figure for a lending offer', () => {
    const aon = record({ fillMode: 1, amountMax: 100n });
    expect(termsProblems(aon, with_(aon, { amountMax: 150n }))).toEqual(['amount-single']);
    const o = record();
    expect(termsProblems(o, with_(o, { collateralAmountMax: 400n }))).toEqual(['collateral-single']);
  });
  it('refuses a request’s collateral below what is filled', () => {
    const o = record({ offerType: 1, collateralAmountMax: 500n, collateralAmountFilled: 450n });
    expect(termsProblems(o, with_(o, { collateralAmountMax: 400n }))).toEqual(['collateral-filled']);
  });
  it('refuses an amount or collateral change on a refinance request', () => {
    const o = record({ offerType: 1, refinanceTargetLoanId: 4n });
    expect(termsProblems(o, with_(o, { amountMax: 250n }))).toEqual(['frozen']);
    expect(termsProblems(o, with_(o, { interestRateBps: 400n }))).toEqual([]);
  });
});

describe('editBlockers', () => {
  const o = record();
  const t = with_(o, { interestRateBps: 400n });
  it('lets the creator change an open offer', () => {
    expect(editBlockers(review(o, t), ME, copy, short)).toEqual([]);
  });
  it('refuses an ended, unread or expired offer first', () => {
    expect(editBlockers(review(o, t, {}, { state: 'accepted' }), ME, copy, short)).toEqual(['offerEdit.filled']);
    expect(editBlockers(review(o, t, {}, { state: 'unknown' }), ME, copy, short)).toEqual(['offerEdit.unread']);
    expect(editBlockers(review(record({ expiresAt: BigInt(NOW) }), t), ME, copy, short)).toEqual(['offerEdit.expired']);
  });
  it('refuses another wallet, a pause, a linked listing and a sale lock', () => {
    expect(editBlockers(review(record({ creator: OTHER }), t), ME, copy, short)).toEqual(['offerEdit.notCreator']);
    expect(editBlockers(review(o, t, {}, { paused: true }), ME, copy, short)).toEqual(['offerEdit.paused']);
    expect(editBlockers(review(o, t, {}, { linkedLoanId: 3n }), ME, copy, short)).toEqual(['offerEdit.linked']);
    expect(editBlockers(review(record({ parallelSaleOrderHash: `0x${'1'.repeat(64)}` }), t), ME, copy, short)).toEqual(['offerEdit.saleLocked']);
  });
  it('refuses a rental offer', () => {
    expect(editBlockers(review(record({ assetType: 1 }), t), ME, copy, short)).toEqual(['offerEdit.rental']);
  });
  it('names a wallet shortfall for a change that adds funds', () => {
    const grow = with_(o, { amountMax: 2_000n });
    expect(editBlockers(review(o, grow, { balance: 1_000n }), ME, copy, short)).toEqual(['short:800']);
  });
  it('waits on the approval for the dry run, and stops on a refused one', () => {
    const grow = with_(o, { amountMax: 250n });
    expect(editBlockers(review(o, grow, { dryRun: 'after-approval' }), ME, copy, short)).toEqual([]);
    expect(editBlockers(review(o, t, { dryRun: { code: 'X', reason: 'no', reopensAt: null, remedy: null } }), ME, copy, short)).toEqual([
      'offerEdit.dryRunRefused:{"reason":"no"}',
    ]);
  });
});

describe('editChanged', () => {
  it('names a change of the offer, pause, funds or verdict', () => {
    const o = record();
    const t = with_(o, { interestRateBps: 400n });
    const a = review(o, t);
    expect(editChanged(a, a, copy)).toBeNull();
    expect(editChanged(a, review(record({ amountFilled: 10n }), t), copy)).toBe('offerEdit.changedOffer');
    expect(editChanged(a, review(record({ backstopEligibleAfter: 5n }), t), copy)).toBe('offerEdit.changedOffer');
    expect(editChanged(a, review(o, t, {}, { minTermsAgeSec: 999n }), copy)).toBe('offerEdit.changedOffer');
    expect(editChanged(a, review(o, t, {}, { paused: true }), copy)).toBe('offerEdit.changedPause');
    expect(editChanged(a, review(o, t, { balance: 1n }), copy)).toBe('repay.changedFunds');
    expect(editChanged(a, review(o, t, { dryRun: 'unread' }), copy)).toBe('offerEdit.changedVerdict');
    // A protection delay changed under the review reopens it, though the route reads alike.
    const guarded = { ...OPEN, enabled: true, delaySeconds: 3600 };
    const g = review(o, t, { route: 'queued' }, { protection: guarded });
    expect(editChanged(g, review(o, t, { route: 'queued' }, { protection: { ...guarded, delaySeconds: 7200 } }), copy)).toBe('queue.changedAccount');
  });
});

describe('editReceipt', () => {
  it('states each figure before and after, the term unchanged, and that nothing moves for a rate change', () => {
    const o = record();
    const r = editReceipt(review(o, with_(o, { interestRateBps: 400n })), words, copy);
    const rows = Object.fromEntries(r.rows.map((x) => [x.label, x.value]));
    const rate = 'offerEdit.fromTo:{"before":"home.rateRange:{\\"min\\":\\"5%\\",\\"max\\":\\"8%\\"}","after":"home.rateRange:{\\"min\\":\\"4%\\",\\"max\\":\\"8%\\"}"}';
    expect(rows['offerEdit.rowRate']).toEqual({ kind: 'text', text: rate, exact: rate });
    expect(rows['offerEdit.rowTerm']).toEqual({ kind: 'text', text: 'offerEdit.termSame:{"days":"30"}' });
    expect(rows['offerEdit.rowMoves']).toEqual({ kind: 'text', text: 'offerEdit.movesNothing' });
    expect(r.consequences.some((c) => typeof c === 'string' && c.startsWith('offerEdit.termsAge:'))).toBe(true);
    expect(r.prompts).toBe(1);
  });
  it('states a pull, the approval and its put-back', () => {
    const o = record();
    const r = editReceipt(review(o, with_(o, { amountMax: 250n }), { approvalSteps: 1, dryRun: 'after-approval' }), words, copy);
    expect(r.rows.find((x) => x.label === 'offerEdit.rowPull')).toMatchObject({ value: { kind: 'amount', asset: TOKEN, amount: 50n }, movesOut: true });
    expect(r.consequences).toEqual(expect.arrayContaining(['offerEdit.pullHeld', 'offerEdit.dryRunAfterApproval', 'offerEdit.approvalBack']));
    expect(r.prompts).toBe(2);
  });
  it('states a release and where it lands', () => {
    const o = record();
    const r = editReceipt(review(o, with_(o, { amountMax: 150n })), words, copy);
    expect(r.rows.find((x) => x.label === 'offerEdit.rowRelease')).toMatchObject({ value: { kind: 'amount', asset: TOKEN, amount: 50n } });
    expect(r.rows.find((x) => x.label === 'offerCancel.rowTo')).toBeDefined();
  });
  it('reads a change from the raw figures, and gives exact words, when the short words agree', () => {
    const o = record();
    const short: AmountWords = (_a, v, exact) => (exact ? `${v}` : 'about 100');
    const r = editReceipt(review(o, with_(o, { amountMax: 201n })), short, copy);
    const row = r.rows.find((x) => x.label === 'offerEdit.rowAmount');
    expect(row?.binding).toBe(true);
    expect(row?.value).toMatchObject({ kind: 'text', text: expect.stringMatching(/^offerEdit\.fromTo:/), exact: expect.stringContaining('201') });
    const same = editReceipt(review(o, with_(o, { interestRateBps: 400n })), short, copy).rows.find((x) => x.label === 'offerEdit.rowAmount');
    expect(same?.binding).toBe(false);
    expect(same?.value).toMatchObject({ text: expect.stringMatching(/^offerEdit\.same:/) });
  });
  it('says a backstop opt-in ends', () => {
    const o = record({ backstopEligibleAfter: 5n });
    expect(editReceipt(review(o, with_(o, { interestRateBps: 400n })), words, copy).consequences).toContain('offerEdit.backstopEnds');
  });
});

const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

function modifiedLog(offerId: bigint, t: EditTerms): Log {
  const abi = OfferMutateFacetABI as Abi;
  const topics = encodeEventTopics({ abi, eventName: 'OfferModified', args: { offerId, creator: ME } });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
    [t.amount, t.amountMax, t.interestRateBps, t.interestRateBpsMax, t.collateralAmount, t.collateralAmountMax, ZERO_ADDRESS],
  );
  return { address: DIAMOND, topics, data } as unknown as Log;
}

function transferLog(token: Hex, from: Hex, to: Hex, value: bigint): Log {
  const topics = encodeEventTopics({ abi: TRANSFER, eventName: 'Transfer', args: { from, to } });
  return { address: token, topics, data: encodeAbiParameters([{ type: 'uint256' }], [value]) } as unknown as Log;
}

describe('measureEdit', () => {
  const o = record();
  it('reports no change when the logs record none', () => {
    expect(measureEdit(review(o, with_(o, { interestRateBps: 400n })), [], DIAMOND, ME, words, copy)[0]!.status).toBe('not-done');
  });
  it('checks the recorded figures against the review', () => {
    const t = with_(o, { interestRateBps: 400n });
    expect(measureEdit(review(o, t), [modifiedLog(9n, t)], DIAMOND, ME, words, copy)).toEqual([{ status: 'done', label: 'offerEdit.legChanged:{"id":"9"}' }]);
    expect(measureEdit(review(o, t), [modifiedLog(9n, with_(o, { interestRateBps: 450n }))], DIAMOND, ME, words, copy)[0]!.status).toBe('not-done');
  });
  it('measures what left the wallet for a pull', () => {
    const t = with_(o, { amountMax: 250n });
    const legs = measureEdit(review(o, t), [modifiedLog(9n, t), transferLog(TOKEN, ME, VAULT, 50n)], DIAMOND, ME, words, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'done']);
    const short = measureEdit(review(o, t), [modifiedLog(9n, t), transferLog(TOKEN, ME, VAULT, 20n)], DIAMOND, ME, words, copy);
    expect(short[1]!.status).toBe('unknown');
  });
  it('measures a release that reached the wallet', () => {
    const t = with_(o, { amountMax: 150n });
    const legs = measureEdit(review(o, t), [modifiedLog(9n, t), transferLog(TOKEN, VAULT, ME, 50n)], DIAMOND, ME, words, copy);
    expect(legs.map((l) => l.status)).toEqual(['done', 'done']);
    expect(legs[1]!.label).toBe('offerEdit.legReleased:{"what":"50"}');
  });
});

describe('ratePrefill', () => {
  it('moves the bound on the counterparty’s side to their nearest bound', () => {
    expect(ratePrefill({ kind: 'rate', theirs: 450n, mine: 500n, theirsHigh: false })).toEqual({ rateMin: '4.5' });
    expect(ratePrefill({ kind: 'rate', theirs: 900n, mine: 800n, theirsHigh: true })).toEqual({ rateMax: '9' });
  });
});
