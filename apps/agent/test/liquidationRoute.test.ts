import type { PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { buildLiquidationRoute, parseLiquidationRouteBody } from '../src/liquidationRoute';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const COLL = '0x0000000000000000000000000000000000000c01' as const;
const PRIN = '0x0000000000000000000000000000000000000b01' as const;

const loanClient = (loan: Record<string, unknown> | Error) =>
  ({
    readContract: async () => {
      if (loan instanceof Error) throw loan;
      return loan;
    },
  }) as unknown as PublicClient;

const activeLoan = {
  status: 0,
  assetType: 0,
  collateralAssetType: 0,
  principalAsset: PRIN,
  collateralAsset: COLL,
  collateralAmount: 10n ** 18n,
};

describe('parseLiquidationRouteBody', () => {
  it('accepts a chain id and a decimal loan id only', () => {
    expect(parseLiquidationRouteBody({ chainId: 84532, loanId: '21' })).toEqual({ chainId: 84532, loanId: '21' });
    for (const bad of [
      null,
      {},
      { chainId: '84532', loanId: '21' },
      { chainId: 84532, loanId: 21 },
      { chainId: 84532, loanId: '0' },
      { chainId: 84532, loanId: '0x15' },
      { chainId: -1, loanId: '21' },
    ]) {
      expect(parseLiquidationRouteBody(bad)).toBeNull();
    }
  });
});

describe('buildLiquidationRoute (#2463)', () => {
  it('sizes the sale from the chain exactly as triggerDefault does: full collateral, sold for principal, by the Diamond', async () => {
    const orchestrate = vi.fn().mockResolvedValue({
      ranked: [{ kind: 'testnetMock', expectedOutput: 2970n, call: { adapterIdx: 0n, data: '0x' } }],
      calls: [{ adapterIdx: 0n, data: '0x' }],
      failed: ['zeroex', 'oneinch', 'univ3', 'balancerv2'],
    });
    const out = await buildLiquidationRoute(
      { client: loanClient(activeLoan), diamond: DIAMOND, zeroExApiKey: 'k0', orchestrate },
      { chainId: 84532, loanId: '21' },
    );
    expect(orchestrate).toHaveBeenCalledWith({ zeroExApiKey: 'k0', oneInchApiKey: undefined }, expect.anything(), {
      chainId: 84532,
      sellToken: COLL,
      buyToken: PRIN,
      sellAmount: 10n ** 18n,
      taker: DIAMOND,
      slippageBps: 600,
    });
    expect(out).toEqual({
      kind: 'ok',
      body: {
        chainId: 84532,
        loanId: '21',
        sellToken: COLL,
        buyToken: PRIN,
        sellAmount: '1000000000000000000',
        calls: [{ adapterIdx: '0', data: '0x' }],
        ranked: [{ kind: 'testnetMock', expectedOutput: '2970' }],
        failed: ['zeroex', 'oneinch', 'univ3', 'balancerv2'],
      },
    });
  });

  it('builds nothing for a loan the swap branch would never reach', async () => {
    const orchestrate = vi.fn();
    const cases: [Record<string, unknown>, string][] = [
      [{ ...activeLoan, status: 3 }, 'loan-not-active'],
      [{ ...activeLoan, assetType: 1 }, 'not-an-erc20-swap'],
      [{ ...activeLoan, collateralAssetType: 1 }, 'not-an-erc20-swap'],
      [{ ...activeLoan, collateralAmount: 0n }, 'no-collateral'],
    ];
    for (const [loan, code] of cases) {
      const out = await buildLiquidationRoute({ client: loanClient(loan), diamond: DIAMOND, orchestrate }, { chainId: 84532, loanId: '21' });
      expect(out).toMatchObject({ kind: 'error', code });
    }
    expect(orchestrate).not.toHaveBeenCalled();
  });

  it('says the loan could not be read rather than building from a guess', async () => {
    const out = await buildLiquidationRoute(
      { client: loanClient(new Error('rpc down')), diamond: DIAMOND, orchestrate: vi.fn() },
      { chainId: 84532, loanId: '21' },
    );
    expect(out).toEqual({ kind: 'error', status: 502, code: 'loan-unreadable' });
  });
});
