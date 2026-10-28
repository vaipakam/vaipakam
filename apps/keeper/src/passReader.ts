// apps/keeper/src/passReader.ts
//
// The reads a step pass makes, bounded the one way `runWindow.ts` rule 3
// asks (#2984): every read stops at the run's read cutoff, the send deadline
// less the send reserve, so a slow read phase can never use the window its
// sends need. A read not yet made is refused at the cutoff
// (`deadlineClient`), and one already in flight is abandoned there
// (`settleBy` for a single read, `settledChunkedRead` for a batch). Either way the
// caller sees `PastRunDeadline` or an unread value, which it already reads as
// "next run".
//
// The step passes (close-out, zeroed-day recovery, the return transport,
// protocol upkeep) each carried their own copy of this reader, every one
// bounded by the send deadline itself; this is the copy they share.

import type { Abi, Address, PublicClient } from 'viem';
import { deadlineClient, PastRunDeadline, settleBy, settledChunkedRead } from './batchRead';
import { readCutoffMs } from './runWindow';
import { finalizedBlockOnce, type FinalBlock } from './scanCursors';

/** Reads per aggregate. */
export const PASS_READ_CHUNK = 100;

/**
 * One call of any kind (a view, the clock, the chain id, a simulation),
 * bounded at `cutoff` the way every read here is: refused once the cutoff has
 * passed, and abandoned there while still in flight. `deadlineClient` guards
 * only the read methods it names, and refuses without abandoning, so a single
 * call made through a client — `getBlock`, `getChainId`, `simulateCalls` —
 * goes through this instead. `what` names the call in the refusal.
 */
export async function boundedCall<T>(cutoff: number, what: string, work: () => Promise<T>): Promise<T> {
  if (Date.now() >= cutoff) throw new PastRunDeadline(`${what}: past the read cutoff — read next run`);
  return settleBy(work(), cutoff, () => {
    throw new PastRunDeadline(`${what}: still unread at the read cutoff — read next run`);
  });
}

/**
 * The chain's finalized block, by `cutoff`: a floor lift that cannot read it
 * in time leaves the floor where it is (`scanCursors.finalFloor` reads null as
 * "not this run"), rather than waiting past the cutoff.
 */
export function finalizedBy(cutoff: number, finalized: () => Promise<FinalBlock | null>): () => Promise<FinalBlock | null> {
  return () => boundedCall(cutoff, 'the finalized block', finalized).catch(() => null);
}

/** The clients a pass reads through. */
export interface PassReadClients {
  /** For single reads and the finalized block. */
  client: PublicClient;
  /** For the batched reads, which carry the cutoff themselves. */
  readClient: PublicClient;
  /** Which run this is (`runIndex`): where a read of more than one chunk
   *  starts, so a cutoff that ends it partway leaves a different tail unread
   *  each run. A pass without one starts at the first chunk every run. */
  visit?: number;
}

export class PassReader {
  /** The chain's finalized block, read once a run (`scanCursors.finalFloor`),
   *  by the cutoff. */
  readonly finalized: () => Promise<FinalBlock | null>;
  /** When this run's reads stop: the send deadline less the send reserve. */
  readonly cutoff: number;
  private readonly bounded: PublicClient;
  private readonly readClient: PublicClient;
  private readonly visit: number;

  constructor(
    clients: PassReadClients,
    sendDeadline: number,
    readonly diamond: Address,
    private readonly abi: Abi,
    /** The pass's name, as a batched read's label carries it. */
    private readonly pass: string,
  ) {
    this.readClient = clients.readClient;
    this.visit = clients.visit ?? 0;
    this.cutoff = readCutoffMs(sendDeadline);
    this.finalized = finalizedBy(this.cutoff, finalizedBlockOnce(clients.client));
    this.bounded = deadlineClient(clients.client, this.cutoff);
  }

  /** One read at the head, by the cutoff. */
  async one<T>(functionName: string, args: readonly unknown[] = [], address: Address = this.diamond, abi: Abi = this.abi): Promise<T> {
    return (await boundedCall(this.cutoff, functionName, () => this.bounded.readContract({ address, abi, functionName, args }))) as T;
  }

  /** Any other call on the pass's client (the clock, the chain id, a
   *  simulation), by the cutoff. */
  call<T>(what: string, work: (client: PublicClient) => Promise<T>): Promise<T> {
    return boundedCall(this.cutoff, what, () => work(this.bounded));
  }

  /** Many reads; `undefined` where a read did not come back. At the head, or
   *  at `blockNumber` when one is given. */
  async many(calls: readonly { functionName: string; args: readonly unknown[] }[], label: string, blockNumber?: bigint): Promise<unknown[]> {
    if (calls.length === 0) return [];
    // Chunked from a point that moves with the run (`settledChunkedRead`),
    // each answer kept at its call's own position.
    const at = calls.map((_, i) => i);
    const res = await settledChunkedRead(
      this.readClient,
      at,
      PASS_READ_CHUNK,
      (i) => ({ address: this.diamond, abi: this.abi, functionName: calls[i].functionName, args: calls[i].args }),
      `${this.pass} ${label}`,
      this.cutoff,
      this.visit,
      blockNumber,
    );
    return at.map((i) => {
      const x = res.get(i);
      return x?.status === 'success' ? x.result : undefined;
    });
  }

  /** `many` of one function over day ids. */
  days(days: readonly number[], functionName: string, label: string, blockNumber?: bigint): Promise<unknown[]> {
    return this.many(days.map((d) => ({ functionName, args: [BigInt(d)] })), label, blockNumber);
  }
}
