/**
 * #3434 — whether to warn the connected wallet about an EIP-7702 delegation.
 *
 * A wallet that signed a 7702 authorization runs another contract's code
 * with the wallet's own authority, so that contract can do everything the
 * owner can, including on the owner's vault. The app warns; it never blocks
 * (issue #3434's recommendation).
 *
 * The owner may say "I set this up". That answer is kept in this browser
 * only, and only for the delegate they saw: a delegation that moves to
 * another contract is warned about again. Nothing is sent anywhere.
 *
 * The code is read by the one shared rule, `readDelegation`, so the app and
 * the agent's watch cannot disagree about what counts as delegated.
 */
import type { Address, Hex } from 'viem';
import { readDelegation } from '@vaipakam/lib/delegation7702';

/** What the banner shows: nothing, or a warning naming the delegate. */
export type WalletDelegationNotice =
  | { kind: 'none' }
  | { kind: 'warn'; delegate: Address };

/** The storage key of the owner's acknowledgement, per chain and wallet. */
export function delegationAckKey(chainId: number, wallet: string): string {
  return `vaipakam.delegationAck.${chainId}.${wallet.toLowerCase()}`;
}

/**
 * The notice for `code` (as `eth_getCode` answered it), given the delegate
 * the owner last acknowledged (`acked`, lowercased, or null). Call it only
 * with a code read that succeeded: on a failed read the banner shows
 * nothing, since a warning is never shown on a guess.
 */
export function walletDelegationNotice(
  code: Hex | undefined | null,
  acked: string | null,
): WalletDelegationNotice {
  const reading = readDelegation(code);
  if (reading.kind !== 'delegated') return { kind: 'none' };
  if (acked !== null && acked === reading.delegate.toLowerCase()) return { kind: 'none' };
  return { kind: 'warn', delegate: reading.delegate };
}

/** The stored acknowledgement, or null (unset, or storage unavailable). */
export function readDelegationAck(chainId: number, wallet: string): string | null {
  try {
    return globalThis.localStorage?.getItem(delegationAckKey(chainId, wallet)) ?? null;
  } catch {
    return null;
  }
}

/** Record "I set this up" for `delegate`. A failed write keeps the warning. */
export function writeDelegationAck(chainId: number, wallet: string, delegate: string): void {
  try {
    globalThis.localStorage?.setItem(delegationAckKey(chainId, wallet), delegate.toLowerCase());
  } catch {
    /* the warning stays: nothing was recorded */
  }
}
