// apps/keeper/src/rewardDayClose/deps.ts
//
// What one chain's run reads and signs with. Injected so a run is testable
// against fake chains.

import type { Address, PublicClient } from 'viem';
import type { KeeperContext } from '../keeper';

/** A read-only view of ANOTHER chain this keeper serves. */
export interface PeerReader {
  diamond: Address;
  client: PublicClient;
}

export interface DayCloseDeps {
  /** Deadline-bound client: single reads and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  /** The signing context, built only when there is something to send. */
  context: () => KeeperContext | null;
  /** Every chain this keeper serves, probed for standing in a finalized day
   *  it is owed (absent = none beyond the lists). */
  served?: readonly number[];
  /** Another chain this keeper serves, by EVM chain id (null = not served). */
  peer: (chainId: number) => PeerReader | null;
  sendDeadline: number;
  runDeadline: number;
}

/** The chain a run is working: its id, its Diamond, and its injected deps. */
export interface ChainRun {
  chainId: number;
  diamond: Address;
  deps: DayCloseDeps;
  /** `chain=<id>`, for log lines. */
  where: string;
}
