import { describe, expect, it } from 'vitest';
import { balanceLines } from './balances';

type Hex = `0x${string}`;
const USDC: Hex = '0x00000000000000000000000000000000000000a1';
const WETH: Hex = '0x00000000000000000000000000000000000000b2';
const NFT: Hex = '0x00000000000000000000000000000000000000c3';

describe('balanceLines', () => {
  it('keeps free, waiting and lent apart per token, each from its own figure', () => {
    const lines = balanceLines(
      [
        { standard: 'erc20', asset: USDC, withdrawable: 100n },
        { standard: 'erc721', asset: NFT, withdrawable: 1n },
      ],
      [
        { lendingAsset: USDC, availableCapital: 40n, active: true },
        { lendingAsset: usdcLower(), availableCapital: 10n, active: false },
      ],
      [
        { principalAsset: USDC, principal: 500n, assetType: 0 },
        { principalAsset: WETH, principal: 7n, assetType: 0 },
        { principalAsset: NFT, principal: 1n, assetType: 1 },
      ],
    );
    expect(lines).toEqual([
      { asset: USDC, free: 100n, waiting: 50n, inLoans: 500n },
      { asset: WETH, free: 0n, waiting: 0n, inLoans: 7n },
    ]);
  });
  it('states an unread free figure as unread, and drops a token with nothing on any line', () => {
    expect(balanceLines([{ standard: 'erc20', asset: USDC, withdrawable: null }], [], [])).toEqual([{ asset: USDC, free: null, waiting: 0n, inLoans: 0n }]);
    expect(balanceLines([{ standard: 'erc20', asset: USDC, withdrawable: 0n }], [{ lendingAsset: WETH, availableCapital: 0n, active: true }], [])).toEqual([]);
  });
});

function usdcLower(): Hex {
  return USDC.toLowerCase() as Hex;
}
