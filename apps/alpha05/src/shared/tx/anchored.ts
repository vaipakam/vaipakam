import type { PublicClient } from 'viem';
import { readThrough, type OwnStateSource } from '../../chain/ownRail';
import { askSources, type Asked } from './simulate';

/** The block a read-back is pinned to, spread into a viem read call. */
export interface AtBlock {
  blockNumber: bigint;
}

/**
 * The read-back a measurement is allowed (RB-CONFIDENCE): every question is
 * asked AT the block the receipt was mined in, through the sender's own-rail
 * sources in order. A source still behind that block cannot serve it and is
 * passed over like an outage, so a lagging node never answers with the
 * state from before the transaction; when no source can serve the block,
 * the leg is unknown, never "not done". Reading at that block, not at
 * "latest", also keeps a later transaction from changing what this one is
 * measured to have done.
 */
export interface AnchoredReader {
  blockNumber: bigint;
  /** The answer, or a throw when no source could serve the block. */
  read<T>(fn: (client: PublicClient, at: AtBlock) => Promise<T>): Promise<T>;
  /** A question where a revert is an answer (`askSources`). */
  ask<T>(fn: (client: PublicClient, at: AtBlock) => Promise<T>): Promise<Asked<T>>;
}

export function anchoredReader(sources: readonly OwnStateSource[], blockNumber: bigint): AnchoredReader {
  const at: AtBlock = { blockNumber };
  return {
    blockNumber,
    read: async (fn) => (await readThrough(sources, (c) => fn(c, at))).value,
    ask: (fn) => askSources(sources, (c) => fn(c, at)),
  };
}
