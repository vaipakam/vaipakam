export interface IndexedActivityEvent {
  chainId: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  kind: string;
  loanId: number | null;
  offerId: number | null;
  actor: string | null;
  args: Record<string, unknown> | string;
  blockAt: number;
}

export interface ActivityPage {
  chainId: number;
  events: IndexedActivityEvent[];
  nextBefore: string | null;
}

export interface ActivityFilters {
  actor?: string;
  loanId?: number;
  offerId?: number;
  kind?: string;
  limit?: number;
  before?: string;
}