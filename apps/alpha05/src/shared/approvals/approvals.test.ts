import { describe, expect, it } from 'vitest';
import { ContractFunctionZeroDataError, type PublicClient } from 'viem';
import { PERMIT2, isUnlimited, readApprovals, readRow, revokeCall, type ApprovalRow, type ApprovalSubjects } from './approvals';

type Hex = `0x${string}`;
const diamond = '0x00000000000000000000000000000000000000d1' as Hex;
const account = '0x00000000000000000000000000000000000000a1' as Hex;
const tokA = '0x0000000000000000000000000000000000000001' as Hex;
const tokB = '0x0000000000000000000000000000000000000002' as Hex;
const nft = '0x0000000000000000000000000000000000000003' as Hex;
const broken = '0x0000000000000000000000000000000000000004' as Hex;

/** A chain stand-in: each contract answers from a table; `broken` reverts. */
function client(opts: { permit2?: boolean; allowances?: Record<string, bigint>; permit2Allowance?: [bigint, number]; operator?: boolean; owner?: Hex; approved?: Hex } = {}): PublicClient {
  return {
    getBlock: async () => ({ number: 10n, timestamp: 1_000n }),
    getCode: async ({ address }: { address: Hex }) => (address === PERMIT2 && opts.permit2 ? '0x60' : '0x'),
    readContract: async ({ address, functionName }: { address: Hex; functionName: string }) => {
      // No code where a view was expected: the contract's own answer.
      if (address === broken) throw new ContractFunctionZeroDataError({ functionName });
      if (functionName === 'allowance' && address === PERMIT2) return [...(opts.permit2Allowance ?? [0n, 0]), 0];
      if (functionName === 'allowance') return opts.allowances?.[address] ?? 0n;
      if (functionName === 'isApprovedForAll') return opts.operator ?? false;
      if (functionName === 'ownerOf') return opts.owner ?? account;
      if (functionName === 'getApproved') return opts.approved ?? '0x0000000000000000000000000000000000000000';
      throw new Error(`unexpected ${functionName}`);
    },
  } as unknown as PublicClient;
}

const subjects: ApprovalSubjects = { erc20: [tokA, tokB], collections: [{ asset: nft, standard: 'erc721' }], tokens: [{ asset: nft, tokenId: 7n }], complete: true };

describe('reading the approvals', () => {
  it('lists only what stands, ERC-20s first, and counts what was checked', async () => {
    const scan = await readApprovals(client({ allowances: { [tokA]: 5n }, operator: true, approved: diamond }), diamond, account, subjects);
    expect(scan.rows.map((r) => r.kind)).toEqual(['erc20', 'collection', 'token']);
    expect(scan.rows[0]).toMatchObject({ asset: tokA, amount: 5n });
    expect(scan.checked).toBe(4);
    expect(scan.unreadable).toBe(0);
    expect(scan.permit2).toBe(false);
  });
  it('reads Permit2 only where it is deployed, and drops an expired allowance', async () => {
    const live = await readApprovals(client({ permit2: true, permit2Allowance: [9n, 2_000] }), diamond, account, { ...subjects, erc20: [tokA], collections: [], tokens: [] });
    expect(live.rows).toEqual([{ kind: 'permit2', asset: tokA, tokenId: 0n, amount: 9n, expiration: 2_000n }]);
    const expired = await readApprovals(client({ permit2: true, permit2Allowance: [9n, 900] }), diamond, account, { ...subjects, erc20: [tokA], collections: [], tokens: [] });
    expect(expired.rows).toEqual([]);
  });
  it('a token the wallet no longer owns carries no approval of its own', async () => {
    const scan = await readApprovals(client({ approved: diamond, owner: tokB }), diamond, account, { ...subjects, erc20: [], collections: [] });
    expect(scan.rows).toEqual([]);
  });
  it('an asset that does not answer is counted as unknown, never as no approval', async () => {
    const scan = await readApprovals(client(), diamond, account, { ...subjects, erc20: [broken], collections: [], tokens: [] });
    expect(scan.rows).toEqual([]);
    expect(scan.unreadable).toBe(1);
  });
});

describe('withdrawing one', () => {
  const row = (over: Partial<ApprovalRow>): ApprovalRow => ({ kind: 'erc20', asset: tokA, tokenId: 0n, amount: 1n, expiration: 0n, ...over });
  it('sends the call that sets each kind back to nothing', () => {
    expect(revokeCall(row({}), diamond)).toMatchObject({ address: tokA, functionName: 'approve', args: [diamond, 0n] });
    expect(revokeCall(row({ kind: 'permit2' }), diamond)).toMatchObject({ address: PERMIT2, functionName: 'approve', args: [tokA, diamond, 0n, 0] });
    expect(revokeCall(row({ kind: 'collection', asset: nft }), diamond)).toMatchObject({ address: nft, functionName: 'setApprovalForAll', args: [diamond, false] });
    expect(revokeCall(row({ kind: 'token', asset: nft, tokenId: 7n }), diamond)).toMatchObject({ address: nft, functionName: 'approve', args: ['0x0000000000000000000000000000000000000000', 7n] });
  });
  it('states an allowance at or above half the largest value as unlimited', () => {
    expect(isUnlimited(row({ amount: (1n << 256n) - 1n }))).toBe(true);
    expect(isUnlimited(row({ amount: 10n ** 30n }))).toBe(false);
    expect(isUnlimited(row({ kind: 'permit2', amount: (1n << 160n) - 1n }))).toBe(true);
  });
  it('reads a withdrawn row as gone, and a failed read as a failure', async () => {
    expect(await readRow(client(), diamond, account, row({}))).toBeNull();
    expect(await readRow(client({ allowances: { [tokA]: 3n } }), diamond, account, row({}))).toMatchObject({ amount: 3n });
    await expect(readRow(client(), diamond, account, row({ asset: broken }))).rejects.toThrow();
  });
});
