/**
 * #1209 — the Claims page's seller claims. Discovery comes from the indexer
 * and says when it could not answer or was cut short; each loan is read from
 * the chain for THIS seller only; the withdrawal verdict is the simulation's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseError, ContractFunctionRevertedError, type Address, type PublicClient } from 'viem';

const pages = vi.hoisted(() => ({
  calls: [] as { actor?: string; kinds?: readonly string[]; limit?: number; before?: string }[],
  responses: [] as ({ events: { loanId: number | null }[]; nextBefore: string | null } | null)[],
}));

vi.mock('./indexer', () => ({
  fetchActivity: vi.fn(
    async (_chainId: number, opts: { actor?: string; kinds?: readonly string[]; limit?: number; before?: string }) => {
      pages.calls.push(opts);
      return pages.responses.shift() ?? null;
    },
  ),
}));

import { readSellerClaim, sellerClaimLoanIds, simulateSellerWithdraw } from './sellerClaims';

const DIAMOND = '0x000000000000000000000000000000000000d1a0' as Address;
const SELLER = '0x00000000000000000000000000000000000000aA' as Address;
const OTHER = '0x00000000000000000000000000000000000000bb' as Address;
const USDC = '0x0000000000000000000000000000000000000001' as Address;
const WETH = '0x0000000000000000000000000000000000000002' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function revertNamed(errorName: string): BaseError {
  const revert = new ContractFunctionRevertedError({ abi: [], functionName: 'claimAsSeller' });
  Object.assign(revert, { data: { errorName, args: [] } });
  return new BaseError('simulation failed', { cause: revert });
}

type Chain = {
  claims: { seller: Address; grossOwed: bigint }[];
  claimAsset: Address;
  held: Record<string, bigint>;
  simulate: unknown;
};

function clientFor(chain: Chain) {
  const heldReads: unknown[][] = [];
  const client = {
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === 'getLoanDetails') return { status: 0, principalAsset: USDC };
      if (functionName === 'getInterestLedger') return [0n, 0n, 0, chain.claims];
      if (functionName === 'getClaimable') return [chain.claimAsset, 0n, false];
      if (functionName === 'getSellerInterestHeld') {
        heldReads.push(args);
        return chain.held[(args[2] as string).toLowerCase()] ?? 0n;
      }
      throw new Error(`unexpected read ${functionName}`);
    }),
    simulateContract: vi.fn(async () => {
      if (chain.simulate) throw chain.simulate;
      return { result: undefined };
    }),
  } as unknown as PublicClient;
  return { client, heldReads };
}

describe('sellerClaimLoanIds', () => {
  beforeEach(() => {
    pages.calls = [];
    pages.responses = [];
  });

  it('asks for this seller’s claims and payments and follows the pages', async () => {
    pages.responses = [
      { events: [{ loanId: 9 }, { loanId: 7 }], nextBefore: 'c1' },
      { events: [{ loanId: 7 }, { loanId: null }, { loanId: 3 }], nextBefore: null },
    ];
    const found = await sellerClaimLoanIds(84532, SELLER);
    expect(found).toEqual({ loanIds: [9, 7, 3], truncated: false });
    // A payment with no recorded claim (interest set aside while the seller
    // was frozen, all paid at the sale) must still find its loan.
    expect(pages.calls[0]).toMatchObject({
      actor: SELLER,
      kinds: ['SellerInterestClaimRecorded', 'SellerInterestPaid'],
      limit: 200,
    });
    expect(pages.calls[0].before).toBeUndefined();
    expect(pages.calls[1].before).toBe('c1');
  });

  it('says so when the page cap cuts the list short', async () => {
    pages.responses = Array.from({ length: 6 }, (_, i) => ({
      events: [{ loanId: i + 1 }],
      nextBefore: `c${i}`,
    }));
    const found = await sellerClaimLoanIds(84532, SELLER);
    expect(found).toEqual({ loanIds: [1, 2, 3, 4, 5], truncated: true });
    expect(pages.calls).toHaveLength(5);
  });

  it('is null when the indexer cannot answer, even part-way', async () => {
    pages.responses = [{ events: [{ loanId: 4 }], nextBefore: 'c1' }, null];
    expect(await sellerClaimLoanIds(84532, SELLER)).toBeNull();
  });
});

describe('readSellerClaim', () => {
  it('counts only this seller’s open claims and reads what is held per asset', async () => {
    const { client, heldReads } = clientFor({
      claims: [
        { seller: SELLER, grossOwed: 40n },
        { seller: OTHER, grossOwed: 1_000n },
        { seller: SELLER.toLowerCase() as Address, grossOwed: 2n },
      ],
      claimAsset: WETH,
      held: { [USDC.toLowerCase()]: 5n, [WETH.toLowerCase()]: 0n },
      simulate: null,
    });
    const row = await readSellerClaim({ client, diamond: DIAMOND, seller: SELLER }, 12);
    expect(row).toEqual({
      loanId: 12,
      status: 0,
      principalAsset: USDC,
      owedGross: 42n,
      held: [{ asset: USDC, amount: 5n }],
      withdraw: { kind: 'ready' },
    });
    // The principal asset and, as a separate asset, the lender claim's own.
    expect(heldReads.map((a) => a[2])).toEqual([USDC, WETH]);
    expect(heldReads.every((a) => a[0] === 12n && a[1] === SELLER)).toBe(true);
  });

  it('reads the principal asset once when the lender claim is in it or empty', async () => {
    for (const claimAsset of [USDC, ZERO]) {
      const { client, heldReads } = clientFor({
        claims: [{ seller: SELLER, grossOwed: 1n }],
        claimAsset,
        held: {},
        simulate: null,
      });
      await readSellerClaim({ client, diamond: DIAMOND, seller: SELLER }, 1);
      expect(heldReads.map((a) => a[2])).toEqual([USDC]);
    }
  });

  it('is null when nothing is owed to or waiting for this seller', async () => {
    const { client } = clientFor({
      claims: [{ seller: OTHER, grossOwed: 9n }],
      claimAsset: USDC,
      held: {},
      simulate: null,
    });
    expect(await readSellerClaim({ client, diamond: DIAMOND, seller: SELLER }, 3)).toBeNull();
    expect(client.simulateContract).not.toHaveBeenCalled();
  });

  it('lists a claim whose ledger row is closed but whose payment is still waiting', async () => {
    const { client } = clientFor({
      claims: [],
      claimAsset: USDC,
      held: { [USDC.toLowerCase()]: 8n },
      simulate: null,
    });
    const row = await readSellerClaim({ client, diamond: DIAMOND, seller: SELLER }, 4);
    expect(row?.owedGross).toBe(0n);
    expect(row?.held).toEqual([{ asset: USDC, amount: 8n }]);
  });
});

describe('simulateSellerWithdraw', () => {
  const run = (simulate: unknown) => {
    const { client } = clientFor({ claims: [], claimAsset: USDC, held: {}, simulate });
    return simulateSellerWithdraw({ client, diamond: DIAMOND, seller: SELLER }, 5);
  };

  it('is ready when the withdrawal simulates', async () => {
    expect(await run(null)).toEqual({ kind: 'ready' });
  });

  it('reads the nothing-to-claim revert as nothing paid yet', async () => {
    expect(await run(revertNamed('NothingToClaimAsSeller'))).toEqual({ kind: 'nothing-yet' });
  });

  it('carries any other revert as a refusal with its reason', async () => {
    const verdict = await run(revertNamed('EnforcedPause'));
    expect(verdict.kind).toBe('refused');
  });

  it('is unknown when the check itself failed', async () => {
    expect(await run(new Error('rpc timeout'))).toEqual({ kind: 'unknown' });
  });
});
