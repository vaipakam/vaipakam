import { describe, expect, it } from 'vitest';
import type { SupportedChain } from '../../chain/chains';
import { encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress, type Log } from 'viem';
import { faucetAssets, freshTokenId, mintLogged, mintVerdict } from './faucet';

const chain = (chainId: number, testnet: boolean): SupportedChain => ({
  chainId,
  name: 'x',
  rpcEndpoints: [],
  blockExplorer: 'https://x',
  testnet,
  nativeGasSymbol: 'ETH',
  diamondAddress: '0x0000000000000000000000000000000000000001',
  deployBlock: 0,
});

describe('faucetAssets', () => {
  it('offers priced and unpriced test tokens and rentable NFTs on a testnet that publishes them', () => {
    const assets = faucetAssets(chain(84532, true));
    expect(assets).not.toBeNull();
    const erc20 = assets!.filter((a) => a.kind === 'erc20');
    expect(erc20.filter((a) => a.kind === 'erc20' && a.priced).length).toBeGreaterThanOrEqual(2);
    expect(erc20.filter((a) => a.kind === 'erc20' && !a.priced).length).toBeGreaterThanOrEqual(2);
    expect(assets!.filter((a) => a.kind === 'nft').length).toBeGreaterThanOrEqual(1);
    for (const a of assets!) expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
  it('offers nothing on a mainnet, whatever its record holds', () => {
    expect(faucetAssets(chain(84532, false))).toBeNull();
  });
  it('offers nothing on a chain whose record publishes no test assets', () => {
    expect(faucetAssets(chain(999_999, true))).toBeNull();
  });
});

describe('freshTokenId', () => {
  it('draws above the reserved low range', () => {
    expect(freshTokenId(() => 0)).toBe(1_000_000n);
    expect(freshTokenId(() => 0.5) > 1_000_000n).toBe(true);
  });
});

describe('the token mint outcome', () => {
  const token = '0x00000000000000000000000000000000000000aa' as const;
  const me = '0x00000000000000000000000000000000000000bb' as const;
  const transfer = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const log = (from: `0x${string}`, to: `0x${string}`, value: bigint, address: `0x${string}` = token) =>
    ({
      address,
      topics: encodeEventTopics({ abi: transfer, eventName: 'Transfer', args: { from, to } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    }) as unknown as Log;

  it('finds the mint in the transaction logs, only from the zero address, to the sender, on the token', () => {
    expect(mintLogged([log(zeroAddress, me, 1000n)], token, me, 1000n)).toBe(true);
    expect(mintLogged([log(me, me, 1000n)], token, me, 1000n)).toBe(false);
    expect(mintLogged([log(zeroAddress, me, 1000n, '0x00000000000000000000000000000000000000cc')], token, me, 1000n)).toBe(false);
    expect(mintLogged([log(zeroAddress, me, 999n)], token, me, 1000n)).toBe(false);
  });

  it('a shortfall the mint log contradicts is unknown; only an unrecorded one is not done', () => {
    expect(mintVerdict(1000n, 1000n, true)).toBe('done');
    expect(mintVerdict(500n, 1000n, true)).toBe('unknown');
    expect(mintVerdict(500n, 1000n, false)).toBe('not-done');
  });
});
