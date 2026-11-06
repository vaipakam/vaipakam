/**
 * The one way an error becomes a refusal (RB-ELIG): the protocol's own
 * custom-error name first, read from the revert data; a wallet's decline;
 * and otherwise a refusal that says this build cannot name the reason. An
 * unrecognised error is STILL a refusal with a stated unknown, never a
 * swallowed one and never an invented reason (RB-FUNDS).
 */
import { FRIENDLY_ERROR_MESSAGES, KNOWN_ERROR_SELECTORS, extractRevertName, extractRevertSelector, humanizeErrorName } from '@vaipakam/lib/decodeContractError';
import type { Refusal } from './types';

export const USER_REJECTED = 'UserRejected';
export const UNRECOGNISED = 'Unrecognised';

function isUserRejection(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; node && typeof node === 'object' && depth < 6; depth++) {
    const n = node as { code?: unknown; name?: unknown; cause?: unknown };
    if (n.code === 4001 || n.name === 'UserRejectedRequestError') return true;
    node = n.cause;
  }
  return false;
}

/** An error that already carries the refusal to state, written by the app
 *  where it knows more than the error does (a multi-step flow that stopped
 *  after an approval and says whether the approval was put back). */
export class StatedRefusal extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.reason);
    this.name = 'StatedRefusal';
    this.refusal = refusal;
  }
}

export function refusalFromError(err: unknown, remedy: Refusal['remedy'] = null): Refusal {
  if (err instanceof StatedRefusal) return remedy ? { ...err.refusal, remedy } : err.refusal;
  if (isUserRejection(err)) {
    return { code: USER_REJECTED, reason: 'You declined in the wallet. Nothing was sent.', reopensAt: null, remedy };
  }
  const selector = extractRevertSelector(err);
  // The selector table names a signature (`Name(uint256)`); the code is the name.
  const name = extractRevertName(err) ?? (selector ? KNOWN_ERROR_SELECTORS[selector]?.replace(/\(.*\)$/, '') : undefined);
  if (name) {
    const friendly = FRIENDLY_ERROR_MESSAGES[name] ?? humanizeErrorName(name);
    return { code: name, reason: `The protocol refused this step: ${friendly}`, reopensAt: null, remedy };
  }
  if (selector) {
    return { code: selector, reason: `The protocol refused this step with an error this build cannot name (${selector}).`, reopensAt: null, remedy };
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const short = message.split('\n')[0]?.slice(0, 160) ?? '';
  return {
    code: UNRECOGNISED,
    reason: short ? `The step was refused for a reason this build cannot name: ${short}` : 'The step was refused for a reason this build cannot name.',
    reopensAt: null,
    remedy,
  };
}
