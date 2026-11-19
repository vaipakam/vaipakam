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
      {
        slots: [
          { lendingAsset: USDC, availableCapital: 40n, active: true },
          { lendingAsset: usdcLower(), availableCapital: 10n, active: false },
        ],
        complete: true,
      },
      {
        loans: [
          { principalAsset: USDC, principal: 500n, assetType: 0 },
          { principalAsset: WETH, principal: 7n, assetType: 0 },
          { principalAsset: NFT, principal: 1n, assetType: 1 },
        ],
        complete: true,
      },
    );
    expect(lines).toEqual([
      { asset: USDC, free: 100n, waiting: 50n, waitingPartial: false, inLoans: 500n, inLoansPartial: false },
      { asset: WETH, free: 0n, waiting: 0n, waitingPartial: false, inLoans: 7n, inLoansPartial: false },
    ]);
  });
  it('states an unread free figure as unread, and drops a token with nothing on any line', () => {
    expect(balanceLines([{ standard: 'erc20', asset: USDC, withdrawable: null }], { slots: [], complete: true }, LENT0)).toEqual([
      { asset: USDC, free: null, waiting: 0n, waitingPartial: false, inLoans: 0n, inLoansPartial: false },
    ]);
    expect(balanceLines([{ standard: 'erc20', asset: USDC, withdrawable: 0n }], { slots: [{ lendingAsset: WETH, availableCapital: 0n, active: true }], complete: true }, LENT0)).toEqual([]);
  });
  it('never shows unread Auto-lend capital as zero, and marks a partial slot list as a floor', () => {
    expect(balanceLines([{ standard: 'erc20', asset: USDC, withdrawable: 5n }], null, LENT0)).toEqual([{ asset: USDC, free: 5n, waiting: null, waitingPartial: false, inLoans: 0n, inLoansPartial: false }]);
    expect(balanceLines([], { slots: [{ lendingAsset: USDC, availableCapital: 9n, active: true }], complete: false }, LENT0)).toEqual([
      { asset: USDC, free: 0n, waiting: 9n, waitingPartial: true, inLoans: 0n, inLoansPartial: false },
    ]);
  });
});

describe('a partial position read', () => {
  it('marks every in-loans figure as a floor, a token with none found too', () => {
    const lines = balanceLines([{ standard: 'erc20', asset: WETH, withdrawable: 3n }], null, { loans: [{ principalAsset: USDC, principal: 4n, assetType: 0 }], complete: false });
    expect(lines.map((l) => [l.asset, l.inLoans, l.inLoansPartial])).toEqual([
      [WETH, 0n, true],
      [USDC, 4n, true],
    ]);
  });
});

const LENT0 = { loans: [], complete: true } as const;

function usdcLower(): Hex {
  return USDC.toLowerCase() as Hex;
}
