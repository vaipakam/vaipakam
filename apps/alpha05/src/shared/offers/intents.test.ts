import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
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
    expect(standingReady([intent({ owner: me })], WETH, TLIQ, me.toUpperCase().replace('0X', '0x') as Hex)).toBeNull();
    expect(standingReady([intent({ owner: me }), intent()], WETH, TLIQ, me)?.lenders).toBe(1);
  });
});

describe('request terms every intent fill requires', () => {
  it('requires the full term’s interest and no partial repayment', () => {
    expect(intentRequestBlock({ fullTerm: true, allowsPartialRepay: false })).toBeNull();
    expect(intentRequestBlock({ fullTerm: false, allowsPartialRepay: false })).toBe('pro-rata');
    expect(intentRequestBlock({ fullTerm: true, allowsPartialRepay: true })).toBe('partial-repay');
  });
});

describe('reading the intents', () => {
  it('pages until every intent is read, and says how many were', async () => {
    const all = Array.from({ length: INTENT_PAGE + 3 }, () => intent());
    const calls: bigint[] = [];
    const blocks: (bigint | undefined)[] = [];
    const client = {
      getBlockNumber: async () => 77n,
      readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: [bigint, bigint]; blockNumber?: bigint }) => {
        blocks.push(blockNumber);
        if (functionName !== 'getActiveLenderIntents') return true;
        calls.push(args[0]);
        return [all.slice(Number(args[0]), Number(args[0] + args[1])), BigInt(all.length)];
      },
    } as unknown as PublicClient;
    const r = await readLenderIntents(client, WETH);
    expect(calls).toEqual([0n, BigInt(INTENT_PAGE)]);
    expect(r.scanned).toBe(all.length);
    expect(r.total).toBe(BigInt(all.length));
    // Every page and both switches are read at one block.
    expect(blocks).toHaveLength(4);
    expect(new Set(blocks)).toEqual(new Set([77n]));
    expect(intentMatching(r.switches)).toBe('on');
  });

  it('says matching is off when either switch is off, and unknown when one could not be read', async () => {
    const client = (matching: boolean | Error, intents: boolean | Error) =>
      ({
        getBlockNumber: async () => 1n,
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === 'getActiveLenderIntents') return [[], 0n];
          const v = functionName === 'getPartialFillEnabled' ? matching : intents;
          if (v instanceof Error) throw v;
          return v;
        },
      }) as unknown as PublicClient;
    expect(intentMatching((await readLenderIntents(client(false, true), WETH)).switches)).toBe('off');
    expect(intentMatching((await readLenderIntents(client(true, false), WETH)).switches)).toBe('off');
    expect(intentMatching((await readLenderIntents(client(new Error('x'), true), WETH)).switches)).toBe('unknown');
    expect(intentMatching((await readLenderIntents(client(new Error('x'), false), WETH)).switches)).toBe('off');
  });
});
