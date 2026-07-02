import type { IndexedLoan } from '../types/loans.js';
import { fetchIndexerJson } from './client.js';

export interface ParticipantLoansPage {
  chainId: number;
  side: 'lender' | 'borrower';
  address: string;
  loans: IndexedLoan[];
  nextBefore: number | null;
}

export interface HolderLoansPage {
  chainId: number;
  address: string;
  loans: IndexedLoan[];
  nextBefore: number | null;
}

export async function fetchLoansByLender(
  indexerOrigin: string | undefined,
  chainId: number,
  lender: string,
  opts: { limit?: number; before?: number } = {},
): Promise<ParticipantLoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return fetchIndexerJson<ParticipantLoansPage>(
    indexerOrigin,
    `/loans/by-lender/${lender.toLowerCase()}?${params}`,
  );
}

export async function fetchLoansByBorrower(
  indexerOrigin: string | undefined,
  chainId: number,
  borrower: string,
  opts: { limit?: number; before?: number } = {},
): Promise<ParticipantLoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return fetchIndexerJson<ParticipantLoansPage>(
    indexerOrigin,
    `/loans/by-borrower/${borrower.toLowerCase()}?${params}`,
  );
}

export async function fetchLoansByCurrentHolder(
  indexerOrigin: string | undefined,
  chainId: number,
  holder: string,
  opts: { limit?: number; before?: number } = {},
): Promise<HolderLoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return fetchIndexerJson<HolderLoansPage>(
    indexerOrigin,
    `/loans/by-current-holder/${holder.toLowerCase()}?${params}`,
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

async function fetchAllPages(
  fetchPage: (before?: number) => Promise<{ loans: IndexedLoan[]; nextBefore: number | null } | null>,
): Promise<IndexedLoan[]> {
  const all: IndexedLoan[] = [];
  let before: number | undefined;
  for (let page = 0; page < 25; page++) {
    const res = await fetchPage(before);
    if (!res) break;
    all.push(...res.loans);
    if (res.nextBefore == null) break;
    before = res.nextBefore;
  }
  return all;
}

/** All loans where the wallet is the current holder on either side. */
export async function fetchAllLoansForWallet(
  indexerOrigin: string | undefined,
  chainId: number,
  wallet: string,
): Promise<IndexedLoan[]> {
  return fetchAllPages(async (before) =>
    fetchLoansByCurrentHolder(indexerOrigin, chainId, wallet, {
      limit: 100,
      before,
    }),
  );
}

export function filterActiveLoans(loans: IndexedLoan[]): IndexedLoan[] {
  return loans.filter((l) => l.status === 'active');
}