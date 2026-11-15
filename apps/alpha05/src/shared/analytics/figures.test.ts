/**
 * RW-74 / RW-75 — the public figures are read at one block, each group is
 * settled on its own, and a lifetime total is shown as the parts it is made
 * of plus the assets the protocol cannot value.
 */
import { describe, expect, it } from 'vitest';
import { ContractFunctionRevertedError, type PublicClient } from 'viem';
import type { SupportedChain } from '../../chain/chains';
import { custodyOf, headlineParts, rateOrNone, readProtocolFigures, type AssetLifetime } from './figures';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000D1' as Hex;
const WETH = '0x00000000000000000000000000000000000000E1' as Hex;
const ODD = '0x00000000000000000000000000000000000000E2' as Hex;
const chain: SupportedChain = {
  chainId: 84532,
  name: 'Base Sepolia',
  rpcEndpoints: [],
  blockExplorer: 'https://sepolia.basescan.org',
  testnet: true,
  nativeGasSymbol: 'ETH',
  diamondAddress: DIAMOND,
  deployBlock: 7,
};
const E18 = 10n ** 18n;

const row = (asset: Hex, lent: bigint, paid: bigint, lentValue: AssetLifetime['lentValue'], interestValue: AssetLifetime['interestValue']): AssetLifetime => ({
  asset,
  principalLent: lent,
  interestPaid: paid,
  lentValue,
  interestValue,
});

describe('headlineParts', () => {
  it('adds up the valued assets and names the refused and unread ones', () => {
    const rows = [row(WETH, 5n, 1n, { kind: 'value', value: 100n }, { kind: 'value', value: 20n }), row(ODD, 9n, 0n, { kind: 'refused' }, { kind: 'refused' })];
    expect(headlineParts(rows, 'lent', 100n)).toEqual({ valued: 100n, refused: [ODD], unread: [], matches: true });
    // An asset with nothing paid is not a remainder, whatever its valuation.
    expect(headlineParts(rows, 'interest', 20n)).toEqual({ valued: 20n, refused: [], unread: [], matches: true });
    expect(headlineParts(rows, 'lent', 101n).matches).toBe(false);
    const unread = [row(WETH, 5n, 0n, { kind: 'unread', reason: 'timeout' }, { kind: 'value', value: 0n })];
    expect(headlineParts(unread, 'lent', 0n)).toEqual({ valued: 0n, refused: [], unread: [WETH], matches: null });
  });
});

describe('rateOrNone and custodyOf', () => {
  it('says there is no rate when there is nothing to divide by', () => {
    expect(rateOrNone(0n, 0n)).toEqual({ kind: 'none' });
    expect(rateOrNone(0n, 3n)).toEqual({ kind: 'rate', bps: 0n });
  });
  it('tells an unset, a contract-held and an outside treasury apart', () => {
    expect(custodyOf('0x0000000000000000000000000000000000000000', DIAMOND)).toEqual({ kind: 'unset' });
    expect(custodyOf(DIAMOND.toLowerCase(), DIAMOND).kind).toBe('diamond');
    expect(custodyOf(WETH, DIAMOND)).toEqual({ kind: 'external', address: WETH });
  });
});

describe('readProtocolFigures', () => {
  it('reads every figure at one block and states a failed group on its own', async () => {
    const blocks: (bigint | undefined)[] = [];
    const answers: Record<string, unknown> = {
      getNumeraireSymbol: '0x5553440000000000000000000000000000000000000000000000000000000000',
      getProtocolStats: [3n, 1n, 2n, 4n, 500n * E18, 5n * E18, 2500n, 800n],
      getProtocolTVL: [0n, 0n, 1n],
      getGlobalCounts: [5n, 9n],
      getLifetimeLendingAssets: [WETH, ODD],
      getTreasury: DIAMOND,
      getTreasuryFeeBps: 200n,
      getLoanInitiationFeeBps: 20n,
      getTreasuryMetrics: [1n, 2n, 3n, 4n],
      getTreasuryConvertConfig: [[{ asset: WETH, bps: 10000 }], 0n, 0n, 0n],
    };
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({
        number: blockNumber ?? 1000n,
        timestamp: blockNumber === undefined ? 1_900_000_000n : 1_800_000_000n,
      }),
      readContract: async ({ functionName, args, blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
        blocks.push(blockNumber);
        if (functionName === 'getProtocolHealth') throw new Error('upstream timeout');
        if (functionName === 'getLifetimeLendingTotals') return args![0] === WETH ? [10n, 1n] : [7n, 0n];
        if (functionName === 'getNumeraireValue') {
          if (args![0] === ODD) throw new ContractFunctionRevertedError({ abi: [], functionName: 'getNumeraireValue' });
          return (args![1] as bigint) * 50n * E18;
        }
        if (functionName === 'symbol') return 'TOK';
        if (functionName === 'decimals') return 18;
        if (!(functionName in answers)) throw new Error(`unexpected ${functionName}`);
        return answers[functionName];
      },
    } as unknown as PublicClient;
    const f = await readProtocolFigures(client, chain);
    expect(f.block.number).toBe(1000n);
    expect(f.deployedAt).toEqual({ ok: true, value: 1_800_000_000n });
    expect(f.symbol).toEqual({ ok: true, value: 'USD' });
    expect(f.health.ok).toBe(false);
    expect(f.health.ok ? null : f.health.reason).toBe('upstream timeout');
    expect(f.stats.ok && f.stats.value.defaultRateBps).toBe(2500n);
    expect(f.offersPosted).toEqual({ ok: true, value: 9n });
    expect(f.custody).toEqual({ ok: true, value: { kind: 'diamond', address: DIAMOND } });
    expect(f.convert.ok && f.convert.value.targets).toEqual([{ asset: WETH, bps: 10000 }]);
    const rows = f.assets.ok ? f.assets.value.rows : [];
    expect(rows.map((r) => [r.lentValue.kind, r.interestValue.kind])).toEqual([
      ['value', 'value'],
      ['refused', 'refused'],
    ]);
    // Every Diamond read named the same block (the token reads carry none).
    const diamondBlocks = blocks.filter((b) => b !== undefined);
    expect(new Set(diamondBlocks)).toEqual(new Set([1000n]));
  });
});
