import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { VaultOutflowFacetABI } from '@vaipakam/contracts/abis';
import { creditedDrafts, paidAssets, readyToClaim, standardOf } from './claimWithdraw';
import type { ClaimLane } from './loanClaim';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const VAULT = '0x00000000000000000000000000000000000000bb' as Hex;
const MY_VAULT = '0x00000000000000000000000000000000000000cc' as Hex;
const WETH = '0x00000000000000000000000000000000000000e1' as Hex;
const TLIQ = '0x00000000000000000000000000000000000000e2' as Hex;
const NFT = '0x00000000000000000000000000000000000000e3' as Hex;

function log(args: Record<string, unknown>): Log {
  const abi = VaultOutflowFacetABI as Abi;
  const event = abi.find((e) => e.type === 'event' && e.name === 'VaultOutflow') as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName: 'VaultOutflow', args } as never) as Hex[];
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    plain,
    plain.map((i) => args[i.name]),
  );
  return { address: DIAMOND, topics: topics as [Hex, ...Hex[]], data } as unknown as Log;
}
const credit = (asset: Hex, delivered: bigint, o: { to?: Hex; ref?: bigint; class_?: number; tokenId?: bigint } = {}) =>
  log({
    owner: VAULT,
    vault: VAULT,
    asset,
    tokenId: o.tokenId ?? 0n,
    amount: delivered,
    delivered,
    to: o.to ?? MY_VAULT,
    class_: o.class_ ?? 2,
    reason: 1,
    ref: o.ref ?? 7n,
  });

const lane = (kind: ClaimLane['kind'], asset: Hex, amount: bigint, assetType = 0, tokenId = 0n): ClaimLane => ({ kind, asset, assetType, tokenId, amount });

describe('claim and withdraw (#3631)', () => {
  it('names each standard', () => {
    expect([standardOf(0), standardOf(1), standardOf(2)]).toEqual(['erc20', 'erc721', 'erc1155']);
  });

  it('pays two lanes of one token as one withdrawal', () => {
    expect(paidAssets([lane('row', WETH, 5n), lane('held', WETH, 2n), lane('rentalReturn', NFT, 1n, 1, 9n)])).toEqual([
      { assetType: 0, asset: WETH, tokenId: 0n },
      { assetType: 1, asset: NFT, tokenId: 9n },
    ]);
  });

  it('opens the withdrawal for what the claim credited to the vault, not for what the review promised', () => {
    const lanes = [lane('row', WETH, 100n), lane('held', WETH, 5n), lane('surplus', TLIQ, 40n)];
    // The token arrived short (a transfer fee): the measured figure is used.
    const logs = [credit(WETH, 103n), credit(TLIQ, 40n)];
    expect(creditedDrafts(lanes, logs, DIAMOND, MY_VAULT, [7n])).toEqual([
      { standard: 'erc20', asset: WETH, tokenId: 0n, amount: 103n },
      { standard: 'erc20', asset: TLIQ, tokenId: 0n, amount: 40n },
    ]);
  });

  it('opens nothing for an asset that reached another vault, another loan or another class', () => {
    const lanes = [lane('row', WETH, 100n)];
    expect(creditedDrafts(lanes, [credit(WETH, 100n, { to: VAULT })], DIAMOND, MY_VAULT, [7n])).toEqual([]);
    expect(creditedDrafts(lanes, [credit(WETH, 100n, { ref: 8n })], DIAMOND, MY_VAULT, [7n])).toEqual([]);
    expect(creditedDrafts(lanes, [credit(WETH, 100n, { class_: 1 })], DIAMOND, MY_VAULT, [7n])).toEqual([]);
    expect(creditedDrafts(lanes, [], DIAMOND, MY_VAULT, [7n])).toEqual([]);
  });

  it('withdraws an NFT by its token, one for an ERC-721', () => {
    const lanes = [lane('rentalReturn', NFT, 1n, 1, 9n)];
    expect(creditedDrafts(lanes, [credit(NFT, 1n, { tokenId: 9n })], DIAMOND, MY_VAULT, [7n])).toEqual([{ standard: 'erc721', asset: NFT, tokenId: 9n, amount: 1n }]);
    // Another token of the collection is not this payout.
    expect(creditedDrafts(lanes, [credit(NFT, 1n, { tokenId: 10n })], DIAMOND, MY_VAULT, [7n])).toEqual([]);
  });

  it('sums a batch over every claimed loan', () => {
    const lanes = [lane('row', WETH, 10n), lane('row', WETH, 20n)];
    expect(creditedDrafts(lanes, [credit(WETH, 10n, { ref: 7n }), credit(WETH, 20n, { ref: 9n })], DIAMOND, MY_VAULT, [7n, 9n])).toEqual([
      { standard: 'erc20', asset: WETH, tokenId: 0n, amount: 30n },
    ]);
  });

  it('totals only the payouts open now, and counts the rest apart', () => {
    const sum = readyToClaim([
      { state: 'open', lanes: [lane('row', WETH, 10n), lane('held', WETH, 1n)] },
      { state: 'open', lanes: [lane('row', TLIQ, 5n), lane('surplus', WETH, 2n)] },
      { state: 'open', lanes: [lane('rentalReturn', NFT, 1n, 1, 9n)] },
      { state: 'closed', lanes: [lane('row', WETH, 1000n)] },
      { state: 'unknown', lanes: [] },
      // A claim open with nothing in it adds nothing and is not a payout.
      { state: 'open', lanes: [] },
    ]);
    expect(sum.totals).toEqual([
      { assetType: 0, asset: WETH, tokenId: 0n, amount: 13n },
      { assetType: 0, asset: TLIQ, tokenId: 0n, amount: 5n },
      { assetType: 1, asset: NFT, tokenId: 9n, amount: 1n },
    ]);
    expect([sum.ready, sum.waiting, sum.unread]).toEqual([3, 1, 1]);
  });

  it('keeps each ERC-721 token its own entry and sums an ERC-1155 token', () => {
    const sum = readyToClaim([
      { state: 'open', lanes: [lane('row', NFT, 1n, 1, 9n), lane('row', NFT, 1n, 1, 9n), lane('row', TLIQ, 3n, 2, 4n)] },
      { state: 'open', lanes: [lane('row', TLIQ, 2n, 2, 4n)] },
    ]);
    expect(sum.totals.filter((t) => t.assetType === 1)).toHaveLength(2);
    expect(sum.totals.find((t) => t.assetType === 2)?.amount).toBe(5n);
  });
});
