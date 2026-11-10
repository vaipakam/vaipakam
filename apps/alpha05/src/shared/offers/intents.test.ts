import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { DEFAULT_INPUT, lifecycleTerms } from '../post/postModel';
import { INTENT_PAGE, intentMatching, intentRequestBlock, readLenderIntents, standingReady, type IntentSummary } from './intents';

type Hex = `0x${string}`;
const WETH = '0x4200000000000000000000000000000000000006' as Hex;
const TLIQ = '0x3333333333333333333333333333333333333333' as Hex;
const OTHER = '0x5555555555555555555555555555555555555555' as Hex;
const E18 = 10n ** 18n;

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
    );
    expect(r).toEqual({ lenders: 2, largest: 2n * E18, minRateBps: 400n, maxDays: 90, maxLtvBps: 7000 });
  });
  it('leaves out other pairs and intents that cannot lend their smallest fill', () => {
    const r = standingReady(
      [intent({ collateralAsset: OTHER }), intent({ availableCapital: E18 / 20n }), intent({ maxExposure: E18, livePrincipal: E18 })],
      WETH,
      TLIQ,
    );
    expect(r).toBeNull();
  });
  it('leaves out the reader’s own intents, which can never fill their own request', () => {
    const me = '0x2222222222222222222222222222222222222222' as Hex;
    expect(standingReady([intent({ owner: me })], WETH, TLIQ, { exclude: me.toUpperCase().replace('0X', '0x') as Hex })).toBeNull();
    expect(standingReady([intent({ owner: me }), intent()], WETH, TLIQ, { exclude: me })?.lenders).toBe(1);
  });
});

describe('lenders that choose their fillers', () => {
  it('are kept apart from the lenders any filler may fill against', () => {
    const rows = [intent(), intent({ requiresKeeperAuth: true, minRateBps: 100n })];
    expect(standingReady(rows, WETH, TLIQ)?.lenders).toBe(2);
    expect(standingReady(rows, WETH, TLIQ, { limited: false })?.minRateBps).toBe(intent().minRateBps);
    expect(standingReady(rows, WETH, TLIQ, { limited: true })?.minRateBps).toBe(100n);
    expect(standingReady([intent()], WETH, TLIQ, { limited: true })).toBeNull();
  });
  it('leaves out the intents of owners that cannot fill now', () => {
    const agg = '0x3333333333333333333333333333333333333333' as Hex;
    expect(standingReady([intent({ owner: agg }), intent()], WETH, TLIQ, { unavailable: [agg.toLowerCase()] })?.lenders).toBe(1);
  });
});

describe('request terms every intent fill requires', () => {
  const fits = { useFullTermInterest: true, allowsPartialRepay: false, allowsPrepayListing: false, periodicInterestCadence: 0 };
  it('requires the full term’s interest, no partial repayment, no listing consent and no interest schedule', () => {
    expect(intentRequestBlock(fits)).toBeNull();
    expect(intentRequestBlock({ ...fits, useFullTermInterest: false })).toBe('pro-rata');
    expect(intentRequestBlock({ ...fits, allowsPartialRepay: true })).toBe('partial-repay');
    expect(intentRequestBlock({ ...fits, allowsPrepayListing: true })).toBe('prepay-listing');
    expect(intentRequestBlock({ ...fits, periodicInterestCadence: 1 })).toBe('cadence');
    expect(intentRequestBlock({ ...fits, periodicInterestCadence: 4 })).toBe('cadence');
  });
  it('checks in the protocol’s order', () => {
    expect(intentRequestBlock({ ...fits, useFullTermInterest: false, periodicInterestCadence: 2 })).toBe('pro-rata');
    expect(intentRequestBlock({ ...fits, allowsPartialRepay: true, periodicInterestCadence: 2 })).toBe('partial-repay');
  });
  it('reads the terms as the request form builds them', () => {
    expect(intentRequestBlock(lifecycleTerms(DEFAULT_INPUT))).toBeNull();
    expect(intentRequestBlock(lifecycleTerms({ ...DEFAULT_INPUT, cadence: 1 }))).toBe('cadence');
  });
});

describe('reading the intents', () => {
  /** A client whose gates read as given (open unless named), with an
   *  optional list and a set of aggregator owners. */
  const gated = (gates: Partial<Record<string, boolean | Error>>, rows: IntentSummary[] = [], aggregators: string[] | Error = []) => {
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
      readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }) => {
        blocks.push(blockNumber);
        if (functionName === 'getActiveLenderIntents') {
          const [o, n] = args as [bigint, bigint];
          return [rows.slice(Number(o), Number(o + n)), BigInt(rows.length)];
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
