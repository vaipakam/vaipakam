import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { DEFAULT_INPUT, lifecycleTerms } from '../post/postModel';
import { INTENT_PAGE, intentMatching, intentRequestBlock, intentTermDays, intentTermsBlock, readLenderIntents, standingReady, type IntentSummary } from './intents';

type Hex = `0x${string}`;
const WETH = '0x4200000000000000000000000000000000000006' as Hex;
const TLIQ = '0x3333333333333333333333333333333333333333' as Hex;
const OTHER = '0x5555555555555555555555555555555555555555' as Hex;
const E18 = 10n ** 18n;
const NOW = 1_800_000_000n;
const DAY = 86_400n;

function intent(over: Partial<IntentSummary> = {}): IntentSummary {
  return {
    owner: '0x1111111111111111111111111111111111111111',
    lendingAsset: WETH,
    collateralAsset: TLIQ,
    maxExposure: 10n * E18,
    minRateBps: 500n,
    maxInitLtvBps: 7000,
    maxDurationDays: 30,
    minFillAmount: E18 / 10n,
    requiresKeeperAuth: false,
    livePrincipal: 0n,
    availableCapital: 2n * E18,
    lendUntil: 0n,
    acceptsProRata: false,
    ...over,
  };
}

describe('what lenders stand ready to lend on a pair', () => {
  it('names the most one lender can lend: the smaller of un-lent capital and room under the cap', () => {
    const r = standingReady(
      [
        intent(),
        intent({ maxExposure: 3n * E18, livePrincipal: 2n * E18, availableCapital: 5n * E18, minRateBps: 400n, maxDurationDays: 90, maxInitLtvBps: 6000 }),
      ],
      WETH,
      TLIQ.toUpperCase().replace('0X', '0x') as Hex,
      NOW,
    );
    expect(r).toEqual({ lenders: 2, largest: 2n * E18, minRateBps: 400n, maxDays: 90, maxLtvBps: 7000 });
  });
  it('leaves out other pairs and intents that cannot lend their smallest fill', () => {
    const r = standingReady(
      [intent({ collateralAsset: OTHER }), intent({ availableCapital: E18 / 20n }), intent({ maxExposure: E18, livePrincipal: E18 })],
      WETH,
      TLIQ,
      NOW,
    );
    expect(r).toBeNull();
  });
  it('leaves out the reader’s own intents, which can never fill their own request', () => {
    const me = '0x2222222222222222222222222222222222222222' as Hex;
    expect(standingReady([intent({ owner: me })], WETH, TLIQ, NOW, { exclude: me.toUpperCase().replace('0X', '0x') as Hex })).toBeNull();
    expect(standingReady([intent({ owner: me }), intent()], WETH, TLIQ, NOW, { exclude: me })?.lenders).toBe(1);
  });
});

describe('lenders that choose their fillers', () => {
  it('are kept apart from the lenders any filler may fill against', () => {
    const rows = [intent(), intent({ requiresKeeperAuth: true, minRateBps: 100n })];
    expect(standingReady(rows, WETH, TLIQ, NOW)?.lenders).toBe(2);
    expect(standingReady(rows, WETH, TLIQ, NOW, { limited: false })?.minRateBps).toBe(intent().minRateBps);
    expect(standingReady(rows, WETH, TLIQ, NOW, { limited: true })?.minRateBps).toBe(100n);
    expect(standingReady([intent()], WETH, TLIQ, NOW, { limited: true })).toBeNull();
  });
  it('leaves out the intents of owners that cannot fill now', () => {
    const agg = '0x3333333333333333333333333333333333333333' as Hex;
    expect(standingReady([intent({ owner: agg }), intent()], WETH, TLIQ, NOW, { unavailable: [agg.toLowerCase()] })?.lenders).toBe(1);
  });
});

describe('request terms every intent fill requires', () => {
  const fits = { useFullTermInterest: true, allowsPartialRepay: false, allowsPrepayListing: false, periodicInterestCadence: 0 };
  it('refuses partial repayment on full-term interest, listing consent and an interest schedule for every intent', () => {
    expect(intentRequestBlock(fits)).toBeNull();
    // Pro-rata depends on the lenders' opt-in, so it is not a block for all.
    expect(intentRequestBlock({ ...fits, useFullTermInterest: false })).toBeNull();
    expect(intentRequestBlock({ ...fits, useFullTermInterest: false, allowsPartialRepay: true })).toBeNull();
    expect(intentRequestBlock({ ...fits, allowsPartialRepay: true })).toBe('partial-repay');
    expect(intentRequestBlock({ ...fits, allowsPrepayListing: true })).toBe('prepay-listing');
    expect(intentRequestBlock({ ...fits, periodicInterestCadence: 1 })).toBe('cadence');
    expect(intentRequestBlock({ ...fits, periodicInterestCadence: 4 })).toBe('cadence');
  });
  it('checks in the protocol’s order', () => {
    expect(intentTermsBlock({ acceptsProRata: false }, { ...fits, useFullTermInterest: false, periodicInterestCadence: 2 })).toBe('pro-rata');
    expect(intentRequestBlock({ ...fits, allowsPartialRepay: true, periodicInterestCadence: 2 })).toBe('partial-repay');
  });
  it('reads the terms as the request form builds them', () => {
    expect(intentRequestBlock(lifecycleTerms(DEFAULT_INPUT))).toBeNull();
    expect(intentRequestBlock(lifecycleTerms({ ...DEFAULT_INPUT, cadence: 1 }))).toBe('cadence');
  });
});

describe('lend-until and pro-rata (#3618, #3619)', () => {
  const fits = { useFullTermInterest: true, allowsPartialRepay: false, allowsPrepayListing: false, periodicInterestCadence: 0 };
  it('shortens the longest term by the end date, in whole days from the reading', () => {
    expect(intentTermDays(intent({ maxDurationDays: 60 }), NOW)).toBe(60);
    expect(intentTermDays(intent({ maxDurationDays: 60, lendUntil: NOW + 2n * DAY }), NOW)).toBe(2);
    expect(intentTermDays(intent({ maxDurationDays: 60, lendUntil: NOW + 2n * DAY - 1n }), NOW)).toBe(1);
    expect(intentTermDays(intent({ maxDurationDays: 60, lendUntil: NOW + DAY - 1n }), NOW)).toBe(0);
    expect(intentTermDays(intent({ maxDurationDays: 30, lendUntil: NOW + 90n * DAY }), NOW)).toBe(30);
    expect(intentTermDays(intent({ lendUntil: NOW }), NOW)).toBe(0);
  });
  it('states the term limit an end date leaves, and leaves out a lender with no day left', () => {
    const r = standingReady([intent({ maxDurationDays: 60, lendUntil: NOW + 2n * DAY })], WETH, TLIQ, NOW);
    expect(r?.maxDays).toBe(2);
    expect(standingReady([intent({ lendUntil: NOW + DAY - 1n })], WETH, TLIQ, NOW)).toBeNull();
  });
  it('counts only lenders who opted in for a pro-rata request', () => {
    const rows = [intent(), intent({ acceptsProRata: true, minRateBps: 900n })];
    const proRata = { ...fits, useFullTermInterest: false };
    expect(standingReady(rows, WETH, TLIQ, NOW, { request: fits })?.lenders).toBe(2);
    expect(standingReady(rows, WETH, TLIQ, NOW, { request: proRata })?.lenders).toBe(1);
    expect(standingReady(rows, WETH, TLIQ, NOW, { request: proRata })?.minRateBps).toBe(900n);
    expect(standingReady([intent()], WETH, TLIQ, NOW, { request: proRata })).toBeNull();
    expect(intentTermsBlock({ acceptsProRata: true }, { ...proRata, allowsPartialRepay: true })).toBeNull();
    expect(intentTermsBlock({ acceptsProRata: true }, { ...fits, allowsPartialRepay: true })).toBe('partial-repay');
  });
});

describe('reading the intents', () => {
  /** A client whose gates read as given (open unless named), with an
   *  optional list and a set of aggregator owners. */
  const gated = (gates: Partial<Record<string, boolean | Error>>, rows: IntentSummary[] = [], aggregators: string[] | Error = [], listed: (r: IntentSummary) => boolean = () => true) => {
    const open: Record<string, boolean> = {
      paused: false,
      getPartialFillEnabled: true,
      isLenderIntentEnabled: true,
      keepersPaused: false,
      aggregatorAdaptersPaused: false,
    };
    const blocks: (bigint | undefined)[] = [];
    const client = {
      getBlockNumber: async () => 77n,
      getBlock: async () => ({ timestamp: NOW }),
      readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }) => {
        blocks.push(blockNumber);
        if (functionName === 'getActiveLenderIntents') {
          const [o, n] = args as [bigint, bigint];
          return [rows.slice(Number(o), Number(o + n)).filter(listed), BigInt(rows.length)];
        }
        if (functionName === 'isAggregatorAdapter') {
          if (aggregators instanceof Error) throw aggregators;
          return aggregators.includes(String(args[0]).toLowerCase());
        }
        const v = functionName in gates ? gates[functionName]! : open[functionName];
        if (v instanceof Error) throw v;
        return v;
      },
    } as unknown as PublicClient;
    return { client, blocks };
  };

  it('pages until every intent is read, and reads every page and gate at one block', async () => {
    const all = Array.from({ length: INTENT_PAGE + 3 }, () => intent());
    const { client, blocks } = gated({}, all);
    const r = await readLenderIntents(client, WETH);
    expect(r.scanned).toBe(all.length);
    expect(r.total).toBe(BigInt(all.length));
    // Two pages and five gates, all at one block.
    expect(blocks).toHaveLength(7);
    expect(new Set(blocks)).toEqual(new Set([77n]));
    expect(intentMatching(r)).toBe('on');
  });

  it('keeps paging past a short page the feed trimmed (closed lend-until windows)', async () => {
    const closed = intent({ lendUntil: 1n });
    const live = intent({ owner: '0x2222222222222222222222222222222222222222' });
    const all = [...Array.from({ length: INTENT_PAGE }, (_, i) => (i === 0 ? closed : intent())), live];
    const { client } = gated({}, all, [], (r) => r !== closed);
    const r = await readLenderIntents(client, WETH);
    expect(r.intents).toContain(live);
    expect(r.intents).not.toContain(closed);
    expect(r.scanned).toBe(all.length);
    expect(r.total).toBe(BigInt(all.length));
  });

  it('says halted, off, paused or unknown from the gates, in the protocol’s order', async () => {
    const said = async (gates: Partial<Record<string, boolean | Error>>) => intentMatching(await readLenderIntents(gated(gates).client, WETH));
    const x = new Error('x');
    expect(await said({ paused: true })).toBe('halted');
    // The global pause outranks a switch off, and a switch off the keeper pause.
    expect(await said({ paused: true, getPartialFillEnabled: false })).toBe('halted');
    expect(await said({ getPartialFillEnabled: false })).toBe('off');
    expect(await said({ isLenderIntentEnabled: false })).toBe('off');
    expect(await said({ isLenderIntentEnabled: false, keepersPaused: true })).toBe('off');
    expect(await said({ keepersPaused: true })).toBe('paused');
    expect(await said({ paused: x })).toBe('unknown');
    expect(await said({ getPartialFillEnabled: x, isLenderIntentEnabled: false })).toBe('off');
    expect(await said({ keepersPaused: x })).toBe('unknown');
    expect(await said({ aggregatorAdaptersPaused: x })).toBe('unknown');
    expect(await said({})).toBe('on');
  });

  it('names the aggregator owners only while aggregators are paused', async () => {
    const agg = '0x3333333333333333333333333333333333333333' as Hex;
    const rows = [intent({ owner: agg }), intent()];
    expect((await readLenderIntents(gated({}, rows, [agg.toLowerCase()]).client, WETH)).pausedOwners).toEqual([]);
    const paused = await readLenderIntents(gated({ aggregatorAdaptersPaused: true }, rows, [agg.toLowerCase()]).client, WETH);
    expect(paused.pausedOwners).toEqual([agg.toLowerCase()]);
    expect(intentMatching(paused)).toBe('on');
    const unread = await readLenderIntents(gated({ aggregatorAdaptersPaused: true }, rows, new Error('x')).client, WETH);
    expect(unread.pausedOwners).toBeNull();
    expect(intentMatching(unread)).toBe('unknown');
  });
});
