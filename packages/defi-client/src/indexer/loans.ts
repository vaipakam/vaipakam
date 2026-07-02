import type { IndexedLoan, LoansPage } from '../types/loans.js';
import { fetchIndexerJson } from './client.js';

export async function fetchLoansByWallet(
  indexerOrigin: string | undefined,
  chainId: number,
  wallet: string,
  opts: { limit?: number; before?: number } = {},
): Promise<LoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return fetchIndexerJson<LoansPage>(
    indexerOrigin,
    `/loans/by-wallet/${wallet.toLowerCase()}?${params}`,
  );
}

export async function fetchLoanById(
  indexerOrigin: string | undefined,
  chainId: number,
  loanId: number,
): Promise<IndexedLoan | null> {
  return fetchIndexerJson<IndexedLoan>(
    indexerOrigin,
    `/loans/${loanId}?chainId=${chainId}`,
  );
}

export async function fetchAllLoansForWallet(
  indexerOrigin: string | undefined,
  chainId: number,
  wallet: string,
): Promise<IndexedLoan[]> {
  const all: IndexedLoan[] = [];
  let before: number | undefined;
  for (let page = 0; page < 25; page++) {
    const res = await fetchLoansByWallet(indexerOrigin, chainId, wallet, {
      limit: 100,
      before,
    });
    if (!res) break;
    all.push(...res.loans);
    if (res.nextBefore == null) break;
    before = res.nextBefore;
  }
  return all;
}

export function filterActiveLoans(loans: IndexedLoan[]): IndexedLoan[] {
  return loans.filter((l) => l.status === 'active');
}