import type { IndexedLoan } from '../types/loans.js';
import { fetchIndexerJson } from './client.js';

export interface ClaimablesResponse {
  chainId: number;
  address: string;
  asLender: IndexedLoan[];
  asBorrower: IndexedLoan[];
}

export async function fetchClaimables(
  indexerOrigin: string | undefined,
  chainId: number,
  address: string,
): Promise<ClaimablesResponse | null> {
  return fetchIndexerJson<ClaimablesResponse>(
    indexerOrigin,
    `/claimables/${address.toLowerCase()}?chainId=${chainId}`,
  );
}