import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Abi, type Log } from 'viem';
import { VaultOutflowFacetABI } from '@vaipakam/contracts/abis';
import { bookRowFrom, type BookRow } from '../offers/book';
import { BORROWER, LENDER, TLIQ, WETH } from '../offers/testOffer';
import { deskLadder } from './markets';
import {
  bandState,
  INCENTIVE_CLASS,
  capacityText,
  MATCH,
  MATCH_OK,
  matchBlockers,
  matchChanged,
  matchReceipt,
  measureMatch,
  makesPair,
  overlapPairs,
  ratesMeet,
  pairKey,
  refusalText,
  shareAtMost,
  shareText,
  type MatchBandRead,
  type MatchReview,
  type MatchSettings,
} from './matchBand';

type Hex = `0x${string}`;

const ZERO = '0x0000000000000000000000000000000000000000';
const ME: Hex = '0x4444444444444444444444444444444444444444';
const VAULT: Hex = '0x5555555555555555555555555555555555555555';
const LENDER_VAULT: Hex = '0x6666666666666666666666666666666666666666';
const DIAMOND: Hex = '0x7777777777777777777777777777777777777777';
const MARKET = { lending: getAddress(WETH), collateral: getAddress(TLIQ), durationDays: 30 };

function row(over: Record<string, unknown> = {}): BookRow {
  return bookRowFrom({
    offerId: 1,
    status: 'active',
    creator: LENDER,
    offerType: 0,
    lendingAsset: WETH,
    collateralAsset: TLIQ,
    assetType: 0,
    collateralAssetType: 0,
    tokenId: '0',
    collateralTokenId: '0',
    collateralQuantity: '0',
    quantity: '0',
    amount: '1000',
    amountMax: '1000',
    amountFilled: '0',
    interestRateBps: 500,
    interestRateBpsMax: 500,
    collateralAmount: '5000',
    durationDays: 30,
    prepayAsset: ZERO,
    expiresAt: 0,
    isSaleVehicle: false,
    isOffsetVehicle: false,
    refinanceTargetLoanId: 0,
    positionFlow: null,
    ...over,
  });
}

// A lender accepts from its rate up to 10%, a borrower from 1% up to its
// rate, so a pair's ranges meet exactly where the ladder says they cross.
const ask = (id: number, rate: number, creator: Hex = LENDER) => row({ offerId: id, interestRateBps: rate, interestRateBpsMax: 1000, creator });
const bid = (id: number, rate: number, creator: Hex = BORROWER) => row({ offerId: id, offerType: 1, interestRateBps: 100, interestRateBpsMax: rate, creator });
const fixed = (id: number, offerType: number, rate: number, creator: Hex) =>
  row({ offerId: id, offerType, interestRateBps: rate, interestRateBpsMax: rate, creator });

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}(${Object.values(v).join(',')})`,
};
const words = (asset: Hex, v: bigint, exact = false) => `${v}${exact ? '!' : ''}@${asset.slice(0, 6)}`;

const SETTINGS: MatchSettings = { switchOn: true, lifBps: 20n, matcherBps: 100n, capacityLimited: false };
const OK = { code: MATCH_OK, amount: 1000n, rateBps: 450n, collateral: 5000n };

describe('the overlapping pairs', () => {
  it('pairs every lender offer at or below the best bid with every request at or above the best ask, best priced first', () => {
    const ladder = deskLadder([ask(1, 400), ask(2, 420), ask(3, 600), bid(4, 500), bid(5, 410), bid(6, 300)], MARKET, 0);
    expect(ladder.crossed).toBe(true);
    const { pairs, more } = overlapPairs(ladder, null);
    // Asks 1 (400) and 2 (420) sit under the best bid (500); bids 4 (500)
    // and 5 (410) sit over the best ask (400); 2 against 5 does not overlap.
    expect(pairs.map(pairKey)).toEqual(['1-4', '1-5', '2-4']);
    expect(more).toBe(false);
  });

  it('leaves out a pair from one wallet, and says when more pairs stand behind the limit', () => {
    const ladder = deskLadder([ask(1, 400), ask(2, 400, ME), bid(3, 500, ME), bid(4, 450)], MARKET, 0);
    const all = overlapPairs(ladder, null);
    expect(all.pairs.map(pairKey)).toEqual(['1-3', '1-4', '2-4']);
    const cut = overlapPairs(ladder, null, 2);
    expect(cut.pairs.map(pairKey)).toEqual(['1-3', '1-4']);
    expect(cut.more).toBe(true);
  });

  it('leaves out a pair holding an offer the viewer posted, and says so', () => {
    // Matching one's own offer would put one's own funds into the loan, so
    // the band never offers it as a gas-only match.
    const ladder = deskLadder([ask(1, 400), ask(2, 400, ME), bid(3, 500, ME), bid(4, 450)], MARKET, 0);
    const mine = overlapPairs(ladder, ME.toUpperCase());
    expect(mine.pairs.map(pairKey)).toEqual(['1-4']);
    expect(mine.ownLeftOut).toBe(true);
    expect(overlapPairs(ladder, null).ownLeftOut).toBe(false);
    expect(makesPair({ ask: ask(2, 400, ME), bid: bid(4, 450) }, ME)).toBe(true);
    expect(makesPair({ ask: ask(1, 400), bid: bid(4, 450) }, ME)).toBe(false);
    expect(makesPair({ ask: ask(1, 400), bid: bid(3, 500, ME) }, null)).toBe(false);
    const only = overlapPairs(deskLadder([ask(1, 400, ME), bid(2, 500)], MARKET, 0), ME);
    expect(only).toEqual({ pairs: [], more: false, crossed: true, ownLeftOut: true });
    expect(bandState(only, { settings: SETTINGS, verdicts: [] }).kind).toBe('own-only');
  });

  it('finds none when the sides do not overlap', () => {
    expect(overlapPairs(deskLadder([ask(1, 600), bid(2, 500)], MARKET, 0), null)).toEqual({ pairs: [], more: false, crossed: false, ownLeftOut: false });
    expect(overlapPairs(deskLadder([ask(1, 600)], MARKET, 0), null)).toEqual({ pairs: [], more: false, crossed: false, ownLeftOut: false });
  });

  it('keeps only pairs whose rate ranges meet, as the protocol’s match rule asks', () => {
    // A fixed 4% offer and a fixed 5% request cross on the ladder, but no
    // one rate is in both ranges, so the protocol refuses the pair.
    const ladder = deskLadder([fixed(1, 0, 400, LENDER), fixed(2, 1, 500, BORROWER)], MARKET, 0);
    expect(ladder.crossed).toBe(true);
    expect(overlapPairs(ladder, null)).toEqual({ pairs: [], more: false, crossed: true, ownLeftOut: false });
    expect(ratesMeet(fixed(1, 0, 450, LENDER), fixed(2, 1, 450, BORROWER))).toBe(true);
    expect(ratesMeet(ask(1, 400), fixed(2, 1, 500, BORROWER))).toBe(true);
    expect(ratesMeet(fixed(1, 0, 400, LENDER), bid(2, 500))).toBe(true);
    expect(ratesMeet(fixed(1, 0, 600, LENDER), bid(2, 500))).toBe(false);
  });
});

describe('what the band shows', () => {
  const ladder = deskLadder([ask(1, 400), ask(2, 420), bid(3, 500)], MARKET, 0);
  const found = overlapPairs(ladder, null);
  const read = (settings: Partial<MatchSettings>, verdicts: MatchBandRead['verdicts']): MatchBandRead => ({ settings: { ...SETTINGS, ...settings }, verdicts });

  it('states the switch, unread or off, before anything else', () => {
    expect(bandState(found, read({ switchOn: null }, [null, null])).kind).toBe('switch-unread');
    expect(bandState(found, read({ switchOn: false }, [null, null])).kind).toBe('switch-off');
    expect(bandState({ pairs: [], crossed: false, ownLeftOut: false }, read({ switchOn: false }, [])).kind).toBe('switch-off');
    expect(bandState({ pairs: [], crossed: false, ownLeftOut: false }, read({}, [])).kind).toBe('no-overlap');
    expect(bandState({ pairs: [], crossed: true, ownLeftOut: false }, read({}, [])).kind).toBe('no-rate');
  });

  it('offers the first pair the protocol confirms, naming the best-priced pair’s refusal when it is not that one', () => {
    const top = bandState(found, read({}, [OK, { ...OK, code: 5 }]));
    expect(top).toMatchObject({ kind: 'ready', top: null });
    const second = bandState(found, read({}, [{ ...OK, code: 18 }, OK]));
    expect(second.kind).toBe('ready');
    if (second.kind === 'ready') {
      expect(pairKey(second.pair)).toBe('2-3');
      expect(second.top).toMatchObject({ code: 18 });
    }
  });

  it('says why the best-priced pair is refused when none can be matched, or that its preview was unread', () => {
    expect(
      bandState(
        found,
        read({}, [
          { ...OK, code: 6 },
          { ...OK, code: 4 },
        ]),
      ),
    ).toMatchObject({ kind: 'none', code: 6 });
    expect(bandState(found, read({}, [null, null]))).toMatchObject({ kind: 'none', code: null });
  });
});

describe('the share and the capacity', () => {
  it('is at most the matcher’s part of the full fee, rounded down as the protocol rounds it', () => {
    // 0.2% of 1e18 is 2e15; 1% of that is 2e13.
    expect(shareAtMost(10n ** 18n, 20n, 100n)).toBe(2n * 10n ** 13n);
    expect(shareAtMost(999n, 20n, 100n)).toBe(0n);
    expect(shareText(10n ** 18n, WETH, SETTINGS, words, copy)).toBe('matchBand.shareAtMost(20000000000000@0x4200,1)');
    expect(shareText(10n ** 18n, WETH, { ...SETTINGS, matcherBps: null }, words, copy)).toBe('matchBand.shareUnread');
  });

  it('names whose capacity a match counts against, or that no limit is in force', () => {
    expect(capacityText({ ...SETTINGS, capacityLimited: true }, copy)).toBe('matchBand.capacityYours');
    expect(capacityText(SETTINGS, copy)).toBe('matchBand.capacityNone');
    expect(capacityText({ ...SETTINGS, capacityLimited: null }, copy)).toBe('matchBand.capacityUnread');
  });

  it('words every refusal code, and an unknown one by its number', () => {
    expect(refusalText(18, copy)).toBe('matchBand.codeCapacity');
    expect(refusalText(25, copy)).toBe('matchBand.codeFresh');
    expect(refusalText(26, copy)).toBe('matchBand.codeOther(26)');
  });
});

function review(over: Partial<MatchReview> = {}): MatchReview {
  return {
    identity: 'me',
    pair: { ask: ask(1, 400), bid: bid(3, 500) },
    sender: ME,
    verdict: OK,
    settings: SETTINGS,
    vault: VAULT,
    dryRun: null,
    readAt: 1,
    ...over,
  };
}

describe('the review', () => {
  it('blocks on the switch, the preview and the dry run, in that order', () => {
    expect(matchBlockers(review({ settings: { ...SETTINGS, switchOn: false }, verdict: null }), copy)).toEqual(['matchBand.switchOff']);
    expect(matchBlockers(review({ verdict: null }), copy)).toEqual(['matchBand.previewUnread']);
    expect(matchBlockers(review({ verdict: { ...OK, code: 19 } }), copy)).toEqual(['matchBand.refused(matchBand.codePaused)']);
    expect(matchBlockers(review({ dryRun: 'unread' }), copy)).toEqual(['matchBand.dryRunUnread']);
    expect(matchBlockers(review({ dryRun: { code: 'X', reason: 'no', reopensAt: null, remedy: null } }), copy)).toEqual(['matchBand.dryRunRefused(no)']);
    expect(matchBlockers(review(), copy)).toEqual([]);
    // A sender who posted either offer would put its own funds in the loan.
    expect(matchBlockers(review({ pair: { ask: ask(1, 400, ME), bid: bid(3, 500) } }), copy)).toEqual(['matchBand.ownPair']);
    expect(matchBlockers(review({ pair: { ask: ask(1, 400), bid: bid(3, 500, ME) } }), copy)).toEqual(['matchBand.ownPair']);
  });

  it('notices a change in the terms, the switch, the share, the capacity and the verdict', () => {
    expect(matchChanged(review(), review(), copy)).toBeNull();
    expect(matchChanged(review(), review({ verdict: { ...OK, amount: 999n } }), copy)).toBe('matchBand.changedTerms');
    expect(matchChanged(review(), review({ settings: { ...SETTINGS, switchOn: false } }), copy)).toBe('matchBand.changedSwitch');
    expect(matchChanged(review(), review({ settings: { ...SETTINGS, matcherBps: 200n } }), copy)).toBe('matchBand.changedShare');
    expect(matchChanged(review(), review({ settings: { ...SETTINGS, capacityLimited: true } }), copy)).toBe('matchBand.changedCapacity');
    expect(matchChanged(review(), review({ dryRun: 'unread' }), copy)).toBe('matchBand.changedVerdict');
  });

  it('states the pair, the loan’s terms, the share as a bound, the gas and the capacity, and that the loan is theirs', () => {
    const r = matchReceipt(review(), words, copy);
    expect(r.rows.map((x) => x.label)).toEqual([
      'matchBand.rowPair',
      'matchBand.rowAmount',
      'matchBand.rowRate',
      'matchBand.rowCollateral',
      'matchBand.rowTerm',
      'matchBand.rowShare',
      'matchBand.rowYouPay',
      'matchBand.rowCapacity',
    ]);
    expect(r.rows[0]!.value).toMatchObject({ text: 'matchBand.pair(1,3,0x1111…1111,0x2222…2222)' });
    expect(r.consequences).toEqual(['matchBand.loanIsTheirs', 'matchBand.shareConditional', 'matchBand.race']);
    expect(r.prompts).toBe(1);
    const unread = matchReceipt(review({ verdict: null }), words, copy);
    expect(unread.rows[1]!.value).toEqual({ kind: 'unknown', why: 'matchBand.previewUnread' });
  });
});

describe('the outcome', () => {
  const matched = (matcher: Hex, lenderOfferId = 1n): Log =>
    ({
      address: DIAMOND,
      topics: encodeEventTopics({ abi: MATCH, eventName: 'OfferMatched', args: { lenderOfferId, borrowerOfferId: 3n, loanId: 9n } } as never),
      data: encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
        [matcher, 1000n, 450n, 0n, 2n, 1000n, true],
      ),
    }) as unknown as Log;
  // The lender vault's own record of a payment out of it.
  const outflow = (to: Hex, delivered: bigint, over: { owner?: Hex; asset?: Hex; class_?: number; address?: Hex } = {}): Log =>
    ({
      address: over.address ?? DIAMOND,
      topics: encodeEventTopics({
        abi: VaultOutflowFacetABI as Abi,
        eventName: 'VaultOutflow',
        args: { owner: over.owner ?? LENDER, vault: LENDER_VAULT, asset: over.asset ?? WETH },
      } as never),
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint256' }],
        [0n, delivered, delivered, to, over.class_ ?? INCENTIVE_CLASS, 0, 1n],
      ),
    }) as unknown as Log;
  const REFUND_TO_OWNER = 0;
  const PRINCIPAL_TO_BORROWER = 14;

  it('reads the match and the incentive the lender vault paid to the wallet or the vault', () => {
    const legs = measureMatch(
      review(),
      [matched(ME), outflow(ME, 2n), outflow(VAULT, 1n), outflow(BORROWER, 997n, { class_: PRINCIPAL_TO_BORROWER })],
      DIAMOND,
      ME,
      words,
      copy,
    );
    expect(legs).toEqual([
      { status: 'done', label: 'matchBand.legOpened(9,1000@0x4200,4.5)' },
      { status: 'done', label: 'matchBand.legShare(3@0x4200)' },
    ]);
  });

  it('says no match when the logs carry none for this pair and sender, and no share when none arrived', () => {
    expect(measureMatch(review(), [matched(BORROWER)], DIAMOND, ME, words, copy)[0]).toMatchObject({ status: 'not-done' });
    expect(measureMatch(review(), [matched(ME, 2n)], DIAMOND, ME, words, copy)[0]).toMatchObject({ status: 'not-done' });
    for (const other of [
      outflow(ME, 5n, { asset: TLIQ }),
      outflow(ME, 5n, { owner: BORROWER }),
      outflow(ME, 5n, { address: LENDER_VAULT }),
      outflow(BORROWER, 5n),
    ]) {
      expect(measureMatch(review(), [matched(ME), other], DIAMOND, ME, words, copy)[1]).toMatchObject({ status: 'not-done', reason: 'matchBand.legNoShare' });
    }
  });

  it('counts neither an offer refund to a sender who is the lender nor the loan amount to one who is the borrower', () => {
    const lender = review({ pair: { ask: ask(1, 400, ME), bid: bid(3, 500) } });
    expect(
      measureMatch(
        lender,
        [matched(ME), outflow(ME, 20n, { owner: ME, class_: REFUND_TO_OWNER }), outflow(ME, 2n, { owner: ME })],
        DIAMOND,
        ME,
        words,
        copy,
      )[1],
    ).toEqual({ status: 'done', label: 'matchBand.legShare(2@0x4200)' });
    const borrower = review({ pair: { ask: ask(1, 400), bid: bid(3, 500, ME) } });
    expect(
      measureMatch(borrower, [matched(ME), outflow(VAULT, 998n, { class_: PRINCIPAL_TO_BORROWER }), outflow(ME, 2n)], DIAMOND, ME, words, copy)[1],
    ).toEqual({
      status: 'done',
      label: 'matchBand.legShare(2@0x4200)',
    });
  });
});
