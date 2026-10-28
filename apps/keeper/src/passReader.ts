// apps/keeper/src/passReader.ts
//
// The reads a step pass makes, bounded the one way `runWindow.ts` rule 3
// asks (#2984): every read stops at the run's read cutoff, the send deadline
// less the send reserve, so a slow read phase can never use the window its
// sends need. A read not yet made is refused at the cutoff
// (`deadlineClient`), and one already in flight is abandoned there
// (`settleBy` for a single read, `settledRead` for a batch). Either way the
// caller sees `PastRunDeadline` or an unread value, which it already reads as
// "next run".
//
// The step passes (close-out, zeroed-day recovery, the return transport,
// protocol upkeep) each carried their own copy of this reader, every one
// bounded by the send deadline itself; this is the copy they share.

import type { Abi, Address, PublicClient } from 'viem';
import { deadlineClient, PastRunDeadline, settleBy, settledRead, type BatchResult } from './batchRead';
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
}

export class PassReader {
  /** The chain's finalized block, read once a run (`scanCursors.finalFloor`). */
  readonly finalized: () => Promise<FinalBlock | null>;
  /** When this run's reads stop: the send deadline less the send reserve. */
  readonly cutoff: number;
  private readonly bounded: PublicClient;
  private readonly readClient: PublicClient;

  constructor(
    clients: PassReadClients,
    sendDeadline: number,
    readonly diamond: Address,
    private readonly abi: Abi,
    /** The pass's name, as a batched read's label carries it. */
    private readonly pass: string,
  ) {
    this.readClient = clients.readClient;
    this.finalized = finalizedBlockOnce(clients.client);
    this.cutoff = readCutoffMs(sendDeadline);
    this.bounded = deadlineClient(clients.client, this.cutoff);
  }

  /** One read at the head, by the cutoff. */
  async one<T>(functionName: string, args: readonly unknown[] = [], address: Address = this.diamond, abi: Abi = this.abi): Promise<T> {
    return (await boundedCall(this.cutoff, functionName, () => this.bounded.readContract({ address, abi, functionName, args }))) as T;
  }

  /** Many reads; `undefined` where a read did not come back. At the head, or
   *  at `blockNumber` when one is given. */
  async many(calls: readonly { functionName: string; args: readonly unknown[] }[], label: string, blockNumber?: bigint): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < calls.length; i += PASS_READ_CHUNK) {
      const part = calls.slice(i, i + PASS_READ_CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const res: BatchResult[] = await settledRead(
        this.readClient,
        part.map((c) => ({ address: this.diamond, abi: this.abi, functionName: c.functionName, args: c.args })),
        `${this.pass} ${label}`,
        this.cutoff,
        blockNumber,
      );
      for (const x of res) out.push(x.status === 'success' ? x.result : undefined);
    }
    return out;
  }

  /** `many` of one function over day ids. */
  days(days: readonly number[], functionName: string, label: string, blockNumber?: bigint): Promise<unknown[]> {
    return this.many(days.map((d) => ({ functionName, args: [BigInt(d)] })), label, blockNumber);
  }
}
