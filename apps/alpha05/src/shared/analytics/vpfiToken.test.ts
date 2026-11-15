/**
 * RW-60 — the VPFI token's facts come from the token the protocol names, at
 * the page's block; only the home network reports a cap and a minter.
 */
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import type { SupportedChain } from '../../chain/chains';
import { mintable, readVpfiToken } from './vpfiToken';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000D1' as Hex;
const TOKEN = '0x00000000000000000000000000000000000000F1' as Hex;
const MINTER = '0x00000000000000000000000000000000000000F2' as Hex;
const chain: SupportedChain = {
  chainId: 31337,
  name: 'Anvil',
  rpcEndpoints: [],
  blockExplorer: 'https://explorer.example',
  testnet: true,
  nativeGasSymbol: 'ETH',
  diamondAddress: DIAMOND,
  deployBlock: 1,
};
const E18 = 10n ** 18n;

function client(home: boolean, token: Hex = TOKEN, failing: string[] = []) {
  const calls: { fn: string; block?: bigint }[] = [];
  const c = {
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      calls.push({ fn: functionName, block: blockNumber });
      if (failing.includes(functionName)) throw new Error(`${functionName} timed out`);
      const answers: Record<string, unknown> = {
        getVPFIToken: token,
        isCanonicalVpfiChain: home,
        name: 'Vaipakam DeFi Token',
        symbol: 'VPFI',
        decimals: 18,
        totalSupply: 23_000_000n * E18,
        owner: MINTER,
        paused: false,
        cap: 230_000_000n * E18,
        INITIAL_MINT: 23_000_000n * E18,
        minter: DIAMOND,
      };
      return answers[functionName];
    },
  } as unknown as PublicClient;
  return { c, calls };
}

describe('readVpfiToken', () => {
  it('reads the cap, the launch mint and the minter on the home network, all at the page block', async () => {
    const { c, calls } = client(true);
    const r = await readVpfiToken(c, chain, 77n);
    expect(r.kind).toBe('token');
    if (r.kind !== 'token') return;
    expect(r.facts.home).toBe(true);
    expect(r.facts.homeFacts?.cap).toEqual({ ok: true, value: 230_000_000n * E18 });
    expect(r.facts.homeFacts?.minter).toEqual({ ok: true, value: DIAMOND });
    expect(mintable(r.facts.homeFacts!, r.facts.supply)).toBe(207_000_000n * E18);
    expect(new Set(calls.map((x) => x.block))).toEqual(new Set([77n]));
  });

  it('reads no cap on a bridged network, and states a failed fact on its own', async () => {
    const { c, calls } = client(false, TOKEN, ['decimals']);
    const r = await readVpfiToken(c, chain, 77n);
    if (r.kind !== 'token') throw new Error('expected a token');
    expect(r.facts.homeFacts).toBeNull();
    expect(calls.some((x) => x.fn === 'cap' || x.fn === 'minter')).toBe(false);
    expect(r.facts.decimals).toEqual({ ok: false, reason: 'decimals timed out' });
    expect(r.facts.supply.ok).toBe(true);
  });

  it('says there is no token when the protocol names none', async () => {
    const { c } = client(true, '0x0000000000000000000000000000000000000000');
    expect(await readVpfiToken(c, chain, 77n)).toEqual({ kind: 'none' });
  });

  it('never calls an unread token address unset: a failed read throws, so the page says unread', async () => {
    const { c } = client(true, TOKEN, ['getVPFIToken']);
    await expect(readVpfiToken(c, chain, 77n)).rejects.toThrow('getVPFIToken timed out');
  });

  it('never reads a negative mintable figure, and none when a figure is unread', () => {
    expect(mintable({ cap: { ok: true, value: 5n }, initialMint: { ok: true, value: 0n }, minter: { ok: true, value: MINTER } }, { ok: true, value: 9n })).toBe(
      0n,
    );
    expect(
      mintable({ cap: { ok: false, reason: 'x' }, initialMint: { ok: true, value: 0n }, minter: { ok: true, value: MINTER } }, { ok: true, value: 9n }),
    ).toBeNull();
  });
});
