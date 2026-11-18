/**
 * The simulation half of the last re-check before the wallet opens
 * (RB-REVIEW): the call is run against the latest block through the own
 * rail, as the sender. A revert is the protocol's own first refusal, stated
 * as given and never reworded (`refusalFromError`); a simulation that could
 * not be run at all is an unreadable prerequisite, so signing is withheld
 * rather than guessed.
 */
import { BaseError, ContractFunctionRevertedError, type Abi, type PublicClient } from 'viem';
import type { OwnStateClient, OwnStateSource } from '../../chain/ownRail';
import { withinDeadline } from '../../chain/ownRail';
import { refusalFromError } from '../eligibility/refusal';
import type { Recheck } from '../ui/ActionFlow';

export interface CallRequest {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Native value the call carries (a payable call); none when absent. */
  value?: bigint;
}

export function isRevert(e: unknown): boolean {
  if (e instanceof BaseError) return e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
  return false;
}

/** One contract question asked through the own rail, where a revert is an
 *  ANSWER and not a failed source: `reverted` (the contract refused, so
 *  the walk stops), `answered`, or `unreadable` when no source could run
 *  it at all. `own.read` cannot tell these apart: it passes over a revert
 *  like an outage, and an outage proves nothing about the chain. */
export type Asked<T> = { kind: 'answered'; value: T } | { kind: 'reverted'; error: unknown } | { kind: 'unreadable'; reason: string };

export async function askThrough<T>(own: Pick<OwnStateClient, 'sources'>, fn: (client: PublicClient) => Promise<T>): Promise<Asked<T>> {
  return askSources(own.sources, fn);
}

export async function askSources<T>(sources: readonly OwnStateSource[], fn: (client: PublicClient) => Promise<T>): Promise<Asked<T>> {
  let firstFailure: unknown = null;
  for (const source of sources) {
    try {
      return { kind: 'answered', value: await withinDeadline(fn(source.client)) };
    } catch (e) {
      if (isRevert(e)) return { kind: 'reverted', error: e };
      firstFailure ??= e;
    }
  }
  const reason = firstFailure instanceof Error ? firstFailure.message.split('\n')[0]!.slice(0, 160) : 'no source could run the check';
  return { kind: 'unreadable', reason };
}

/**
 * A question that must see a transaction this flow has just mined (the dry
 * run after an approval): each source is asked AT a block no earlier than
 * `since`, the block that transaction landed in. A source still behind it
 * is passed over like an outage, never read as the chain's answer, because
 * a node that has not seen the approval answers "insufficient allowance"
 * for a call that would pass. When every source is behind, the walk waits
 * and asks again, a few times, before it says the check could not be run.
 * With no `since` (nothing was sent first) it is {@link askThrough}.
 */
export async function askAfter<T>(
  own: Pick<OwnStateClient, 'sources'>,
  since: bigint | null,
  fn: (client: PublicClient, blockNumber: bigint | undefined) => Promise<T>,
  opts: { tries?: number; waitMs?: number } = {},
): Promise<Asked<T>> {
  if (since === null) return askThrough(own, (c) => fn(c, undefined));
  const tries = opts.tries ?? 10;
  const waitMs = opts.waitMs ?? 1500;
  let last: Asked<T> = { kind: 'unreadable', reason: 'no source has reached the block the approval landed in' };
  for (let i = 0; i < tries; i++) {
    let behind = 0;
    last = await askSources(own.sources, async (c) => {
      const head = await c.getBlockNumber({ cacheTime: 0 });
      if (head < since) {
        behind += 1;
        throw new Error('this source has not reached the block the approval landed in');
      }
      return fn(c, head);
    });
    if (last.kind !== 'unreadable' || behind < own.sources.length) return last;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

export async function simulateCall(own: OwnStateClient, req: CallRequest): Promise<Recheck> {
  // Each source in the rail's order: a revert is the protocol's refusal; a
  // source that could not run the call is passed over, and only when none
  // could is the prerequisite unreadable.
  const asked = await askThrough(own, (c) => c.simulateContract({ ...req, account: own.account }));
  if (asked.kind === 'answered') return { kind: 'ok' };
  if (asked.kind === 'reverted') return { kind: 'refused', refusal: refusalFromError(asked.error) };
  return { kind: 'unreadable', reason: asked.reason };
}
