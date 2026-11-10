import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { INTENT_PAGE, readLenderIntents, standingReady, type IntentSummary } from './intents';

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
});

describe('reading the intents', () => {
  it('pages until every intent is read, and says how many were', async () => {
    const all = Array.from({ length: INTENT_PAGE + 3 }, () => intent());
    const calls: bigint[] = [];
    const client = {
      readContract: async ({ args }: { args: [bigint, bigint] }) => {
        calls.push(args[0]);
        return [all.slice(Number(args[0]), Number(args[0] + args[1])), BigInt(all.length)];
      },
    } as unknown as PublicClient;
    const r = await readLenderIntents(client, WETH);
    expect(calls).toEqual([0n, BigInt(INTENT_PAGE)]);
    expect(r.scanned).toBe(all.length);
    expect(r.total).toBe(BigInt(all.length));
  });
});
