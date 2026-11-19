/**
 * EIP-7702 delegation, read from an account's code (#3434).
 *
 * An externally owned account that signed a 7702 authorization carries, as
 * its code, the 23-byte delegation designator `0xef0100 ‖ <delegate>`. Calls
 * to the account then run the delegate's code with the account's authority —
 * so whoever controls that code can act as the wallet, including on its
 * vault. The private key still works too, so the account stays an EOA.
 *
 * ONE reading of the code for every consumer (the agent's watch and the
 * app's warning), so the two cannot disagree about what counts as delegated.
 */
import type { Address, Hex } from 'viem';
import { getAddress } from 'viem';

/** What an account's code says about delegation. */
export type DelegationReading =
  /** No code: a plain externally owned account. */
  | { kind: 'none' }
  /** A 7702 delegation designator naming `delegate`. */
  | { kind: 'delegated'; delegate: Address }
  /** Other code: a contract account (a smart wallet), not a delegated EOA. */
  | { kind: 'contract' };

const DESIGNATOR = /^0xef0100([0-9a-fA-F]{40})$/;

/** Read `code` (as `eth_getCode` answers it; `undefined` and `0x` are no code). */
export function readDelegation(code: Hex | undefined | null): DelegationReading {
  if (!code || code === '0x') return { kind: 'none' };
  const m = DESIGNATOR.exec(code);
  if (m) return { kind: 'delegated', delegate: getAddress(`0x${m[1]}`) };
  return { kind: 'contract' };
}

/** The stored form of a reading: `''` for none, the lowercased delegate, or
 *  `'contract'`. */
export function delegationKey(r: DelegationReading): string {
  return r.kind === 'none' ? '' : r.kind === 'contract' ? 'contract' : r.delegate.toLowerCase();
}
