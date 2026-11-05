/**
 * The simulation half of the last re-check before the wallet opens
 * (RB-REVIEW): the call is run against the latest block through the own
 * rail, as the sender. A revert is the protocol's own first refusal, stated
 * as given and never reworded (`refusalFromError`); a simulation that could
 * not be run at all is an unreadable prerequisite, so signing is withheld
 * rather than guessed.
 */
import { BaseError, ContractFunctionRevertedError, type Abi } from 'viem';
import type { OwnStateClient } from '../../chain/ownRail';
import { refusalFromError } from '../eligibility/refusal';
import type { Recheck } from '../ui/ActionFlow';

export interface CallRequest {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

function isRevert(e: unknown): boolean {
  if (e instanceof BaseError) return e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
  return false;
}

export async function simulateCall(own: OwnStateClient, req: CallRequest): Promise<Recheck> {
  // Each source in the rail's order: a revert is an ANSWER (the protocol
  // refused), so it stops the walk; a source that could not run the call is
  // passed over, and only when none could is the prerequisite unreadable.
  let firstFailure: unknown = null;
  for (const source of own.sources) {
    try {
      await source.client.simulateContract({ ...req, account: own.account });
      return { kind: 'ok' };
    } catch (e) {
      if (isRevert(e)) return { kind: 'refused', refusal: refusalFromError(e) };
      firstFailure ??= e;
    }
  }
  const reason = firstFailure instanceof Error ? firstFailure.message.split('\n')[0]!.slice(0, 160) : 'no source could run the check';
  return { kind: 'unreadable', reason };
}
