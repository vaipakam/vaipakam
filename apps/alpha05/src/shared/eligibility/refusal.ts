/**
 * The one way an error becomes a refusal (RB-ELIG): the protocol's own
 * custom-error name first, read from the revert data; a wallet's decline;
 * and otherwise a refusal that says this build cannot name the reason. An
 * unrecognised error is STILL a refusal with a stated unknown, never a
 * swallowed one and never an invented reason (RB-FUNDS).
 */
import { FRIENDLY_ERROR_MESSAGES, KNOWN_ERROR_SELECTORS, extractRevertName, extractRevertSelector, humanizeErrorName } from '@vaipakam/lib/decodeContractError';
import { decodeErrorResult, type Hex } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../../content/copy';
import type { Refusal } from './types';

export const USER_REJECTED = 'UserRejected';
export const UNRECOGNISED = 'Unrecognised';
/** #3412 — the protocol's refusal of a price-exposed transaction that landed
 *  after the deadline it carried (`LibTiming.DeadlinePassed`). */
export const DEADLINE_PASSED = 'DeadlinePassed';

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
  // A deadline that ran out is worded in the app's own copy: it is the one
  // refusal every price-exposed flow shares, and what it asks of the reader
  // (review and send again) is the same everywhere.
  if (name === DEADLINE_PASSED) return { code: name, reason: copy.flow.deadlinePassed.text, reopensAt: null, remedy };
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

/**
 * The arguments the protocol's custom error carried, as viem decoded them
 * (a `ContractFunctionRevertedError` anywhere in the cause chain); null when
 * the error was not decoded, so a figure is never invented from a message.
 */
export function revertArgs(err: unknown): readonly unknown[] | null {
  let node: unknown = err;
  for (let depth = 0; node && typeof node === 'object' && depth < 6; depth++) {
    const n = node as { data?: { args?: unknown }; cause?: unknown };
    if (n.data && Array.isArray(n.data.args)) return n.data.args as readonly unknown[];
    node = n.cause;
  }
  return null;
}

/**
 * A refusal the protocol returned as data rather than as a revert: the
 * ABI-encoded custom error a verdict view lists (`saleExitVerdict`), with
 * the earliest time it can lift (0 = it needs a decision, or never). Read
 * with the combined Diamond ABI, so every error a facet declares is named.
 */
export function refusalFromData(data: Hex, reopensAt: bigint): Refusal {
  const lifts = reopensAt === 0n ? null : Number(reopensAt);
  let name: string | null = null;
  try {
    name = decodeErrorResult({ abi: DIAMOND_ABI_VIEM, data }).errorName;
  } catch {
    name = null;
  }
  if (name) {
    const friendly = FRIENDLY_ERROR_MESSAGES[name] ?? humanizeErrorName(name);
    return { code: name, reason: `The protocol refuses this for now: ${friendly}`, reopensAt: lifts, remedy: null };
  }
  const selector = data.slice(0, 10);
  return { code: selector, reason: `The protocol refuses this for a reason this build cannot name (${selector}).`, reopensAt: lifts, remedy: null };
}
