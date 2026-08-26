/**
 * Deterministic unit cover for `assertAcceptorCeilingLive` (Codex #1700 r8).
 *
 * The fork arm does NOT exercise this helper, contrary to what COVERAGE.md
 * claimed until now: lowering the displayed ceiling makes `FullTariffOptIn`
 * propagate `blocked: true`, so `resolveFullTariffInput` throws at the very
 * start of signing and neither the pre-sign nor the final-write call is ever
 * reached. A regression in this helper's config read, quote comparison, cache
 * publication or abort behaviour would have left that arm green.
 *
 * So the helper is asserted here instead, against a stubbed reader — which is
 * also the only tier that can drive branches the fork cannot reach at all
 * (kill switch flipping mid-submit, a quote turning unpriceable).
 */
import { describe, it, expect, vi } from 'vitest';
import { assertAcceptorCeilingLive } from './useAcceptTerms';
import { copy } from '../content/copy';

const ASSET = '0x1111111111111111111111111111111111111111' as const;
const DIAMOND = '0x2222222222222222222222222222222222222222' as const;

/** A publicClient stub whose `quoteCStar` / `getFeeEntitlementConfig` answers
 *  are dictated per test. Only the two selectors the helper reads matter. */
function stubClient(opts: {
  enabled?: boolean;
  cStar?: bigint;
  numeraireOk?: boolean;
  throwOn?: string;
}) {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (opts.throwOn === functionName) throw new Error('transport');
      if (functionName === 'getFeeEntitlementConfig') {
        return [opts.enabled ?? true, 0n, 0n] as const;
      }
      if (functionName === 'quoteCStar') {
        return [opts.cStar ?? 100n, opts.numeraireOk ?? true] as const;
      }
      throw new Error(`unexpected read: ${functionName}`);
    }),
  } as never;
}

const queryClient = () => ({ setQueryData: vi.fn() });

const run = (client: unknown, qc: unknown, over: Record<string, unknown> = {}) =>
  assertAcceptorCeilingLive({
    publicClient: client as never,
    diamondAddress: DIAMOND,
    lendingAsset: ASSET,
    amount: 1000n,
    durationDays: 30n,
    full: true,
    allowDowngrade: false,
    maxCStar: 150n,
    queryClient: qc as never,
    chainId: 84532,
    ...over,
  });

describe('assertAcceptorCeilingLive', () => {
  it('resolves when the live quote is at or under the ceiling', async () => {
    await expect(run(stubClient({ cStar: 150n }), queryClient())).resolves.toBeUndefined();
  });

  it('throws the ceiling message when the live quote has overtaken it', async () => {
    await expect(run(stubClient({ cStar: 151n }), queryClient())).rejects.toThrow(
      copy.tariff.ceilingOvertakenSubmit,
    );
  });

  it('publishes the fresh quote before throwing, so the card can offer the raise', async () => {
    const qc = queryClient();
    await expect(run(stubClient({ cStar: 200n }), qc)).rejects.toThrow();
    expect(qc.setQueryData).toHaveBeenCalledWith(
      ['cStarQuote', 84532, ASSET, '1000', 30],
      { cStar: 200n, numeraireOk: true },
    );
  });

  it('aborts when the kill switch went off mid-submit', async () => {
    await expect(
      run(stubClient({ enabled: false }), queryClient()),
    ).rejects.toThrow(copy.tariff.fullUnavailableNow);
  });

  it('aborts when the quote turned unpriceable mid-submit', async () => {
    await expect(
      run(stubClient({ numeraireOk: false }), queryClient()),
    ).rejects.toThrow(copy.tariff.fullUnavailableNow);
  });

  it('does nothing when Full was not opted into', async () => {
    const client = stubClient({ cStar: 999n });
    await expect(run(client, queryClient(), { full: false })).resolves.toBeUndefined();
    expect((client as unknown as { readContract: { mock: { calls: unknown[] } } }).readContract.mock.calls).toHaveLength(0);
  });

  it('does nothing when the user permitted a downgrade — the contract opens without Full', async () => {
    const client = stubClient({ cStar: 999n });
    await expect(
      run(client, queryClient(), { allowDowngrade: true }),
    ).resolves.toBeUndefined();
    expect((client as unknown as { readContract: { mock: { calls: unknown[] } } }).readContract.mock.calls).toHaveLength(0);
  });

  it('FAILS OPEN on a transport error — the contract enforces regardless', async () => {
    await expect(
      run(stubClient({ throwOn: 'quoteCStar' }), queryClient()),
    ).resolves.toBeUndefined();
  });
});
