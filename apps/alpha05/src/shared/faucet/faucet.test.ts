import { describe, expect, it } from 'vitest';
import type { SupportedChain } from '../../chain/chains';
import { faucetAssets, freshTokenId } from './faucet';

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
