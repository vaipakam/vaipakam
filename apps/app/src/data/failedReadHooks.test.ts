// @vitest-environment jsdom
/**
 * #3922 option A — a detail hook with an indexer leg and a chain fallback
 * says which source failed. The fallback succeeding shows no failure; both
 * failing names the indexer's reference and the chain's failure; a chain
 * REVERT is the chain's answer, not a failed read.
 */
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, renderHook } from '../test/renderHook';

const CHAIN = 84532;
let publicClient: object | undefined = {};

vi.mock('wagmi', () => ({ usePublicClient: () => publicClient }));
vi.mock('../chain/useActiveChain', () => ({
  useActiveChain: () => ({
    readChain: { chainId: CHAIN, diamondAddress: '0x0000000000000000000000000000000000000001' },
  }),
}));
vi.mock('../chain/railHealth', () => ({ signalAware: () => false, tipAware: () => false }));
vi.mock('./indexer', async (orig) => ({
  ...(await orig<typeof import('./indexer')>()),
  fetchLoanById: vi.fn(),
}));
vi.mock('./liveLoanRow', async (orig) => ({
  ...(await orig<typeof import('./liveLoanRow')>()),
  readLoanRowLive: vi.fn(),
  withChainDeadlines: vi.fn(async (_c: unknown, _d: unknown, rows: unknown[]) => rows),
}));

import { fetchLoanById } from './indexer';
import { readLoanRowLive } from './liveLoanRow';
import { useLoan } from './hooks';

const REF = 'ABCDEFGHJK';
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  publicClient = {};
  vi.mocked(fetchLoanById).mockImplementation(async (_c, _id, onFailure) => {
    onFailure?.({ answered: true, reference: REF });
    return null;
  });
});
afterEach(() => vi.clearAllMocks());

async function loan() {
  const wrapper = (children: ReactNode) => createElement(QueryClientProvider, { client }, children);
  const h = await renderHook(() => useLoan(7), { initialProps: undefined, wrapper });
  for (let i = 0; i < 5 && h.result.current.data === undefined; i++) await flush();
  return h.result.current;
}

describe('useLoan names the failed source (#3922)', () => {
  it('shows no failure when the chain fallback answers', async () => {
    vi.mocked(readLoanRowLive).mockResolvedValue({ loanId: 7 } as never);
    const r = await loan();
    expect(r.data).toEqual({ loanId: 7 });
    expect(r.failedRead).toBeNull();
  });

  it('names both sources, with the indexer reference, when the fallback fails too', async () => {
    vi.mocked(readLoanRowLive).mockRejectedValue(new BaseError('HTTP request failed'));
    const r = await loan();
    expect(r.data).toBeNull();
    expect(r.failedRead).toEqual({ source: 'both', indexer: { answered: true, reference: REF } });
  });

  it('keeps the indexer verdict when the chain reverts (no such loan)', async () => {
    const revert = new ContractFunctionRevertedError({ abi: [], functionName: 'getLoan', message: 'reverted' });
    vi.mocked(readLoanRowLive).mockRejectedValue(new BaseError('call failed', { cause: revert }));
    const r = await loan();
    expect(r.data).toBeNull();
    expect(r.failedRead).toEqual({ source: 'indexer', indexer: { answered: true, reference: REF } });
  });

  it('keeps the indexer verdict when there is no chain client to ask', async () => {
    publicClient = undefined;
    const r = await loan();
    expect(r.failedRead).toEqual({ source: 'indexer', indexer: { answered: true, reference: REF } });
  });
});
