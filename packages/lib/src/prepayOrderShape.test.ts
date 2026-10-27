import { describe, expect, it } from 'vitest';
import {
  ASSET_TYPE_ERC721,
  SEAPORT_ITEM_TYPE_ERC20,
  buildPrepayOrderComponents,
  type PrepayOrderInput,
} from './prepayOrderShape';

// #2876 — the off-chain mirror of `LibPrepayOrder._componentsAtMemory`:
// ONE proceeds leg to the Diamond (the ask net of the fee legs), then the
// fee legs. No lender, treasury or borrower leg is ever hashed.

const DIAMOND = '0x00000000000000000000000000000000000000d1';
const FEE = '0x00000000000000000000000000000000000000fe';
const ASSET = '0x00000000000000000000000000000000000000a5';

function input(over: Partial<PrepayOrderInput> = {}): PrepayOrderInput {
  return {
    vault: '0x0000000000000000000000000000000000000001',
    executor: '0x0000000000000000000000000000000000000002',
    collateralAssetType: ASSET_TYPE_ERC721,
    collateralAsset: '0x0000000000000000000000000000000000000003',
    collateralTokenId: 7n,
    collateralQuantity: 1n,
    principalAsset: ASSET,
    askPrice: 1_000n,
    diamond: DIAMOND,
    startTime: 100n,
    graceEnd: 900n,
    salt: 5n,
    conduitKey: `0x${'00'.repeat(32)}`,
    counter: 0n,
    ...over,
  };
}

describe('buildPrepayOrderComponents (#2876 one proceeds leg)', () => {
  it('pays the whole ask to the Diamond when there are no fee legs', () => {
    const c = buildPrepayOrderComponents(input());
    expect(c.consideration).toEqual([
      {
        itemType: SEAPORT_ITEM_TYPE_ERC20,
        token: ASSET,
        identifierOrCriteria: '0',
        startAmount: '1000',
        endAmount: '1000',
        recipient: DIAMOND,
      },
    ]);
    expect(c.endTime).toBe('900');
  });

  it('nets the fee legs out of the proceeds leg and appends them after it', () => {
    const c = buildPrepayOrderComponents(
      input({ feeLegs: [{ recipient: FEE, startAmount: 25n, endAmount: 25n }] }),
    );
    expect(c.consideration.map((l) => [l.recipient, l.startAmount, l.endAmount])).toEqual([
      [DIAMOND, '975', '975'],
      [FEE, '25', '25'],
    ]);
  });

  it('decays the proceeds leg for a Dutch listing and ends at the auction end', () => {
    const c = buildPrepayOrderComponents(
      input({
        feeLegs: [{ recipient: FEE, startAmount: 20n, endAmount: 10n }],
        dutch: { startAskPrice: 1_000n, endAskPrice: 600n, auctionEndTime: 500n },
      }),
    );
    expect(c.consideration[0]).toMatchObject({
      startAmount: '980',
      endAmount: '590',
      recipient: DIAMOND,
    });
    expect(c.endTime).toBe('500');
  });

  it('refuses an ask below the fee legs and an inverted decay, as the facet does', () => {
    expect(() =>
      buildPrepayOrderComponents(
        input({ feeLegs: [{ recipient: FEE, startAmount: 1_001n, endAmount: 1_001n }] }),
      ),
    ).toThrow(/below the fee legs/);
    expect(() =>
      buildPrepayOrderComponents(
        input({ dutch: { startAskPrice: 500n, endAskPrice: 600n, auctionEndTime: 500n } }),
      ),
    ).toThrow(/decays inverted/);
  });
});
