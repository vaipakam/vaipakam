/**
 * #3246 part 2 — the account's recovery address: the one place a clawback
 * of a locked protected account pays, and the step protected mode needs
 * before it can be switched on (the vault refuses `enable` without one set
 * or pending).
 *
 * The vault takes the address in one call that carries two consents: the
 * owner's, who asks (its direct call), and the address's own proof that it
 * is controlled (`RecoveryProof`, an EIP-712 signature in the vault's own
 * domain naming the account, the protocol's contract and its next proof
 * nonce). So the step travels between two wallets, each by a link:
 *
 * 1. The owner names the address and sends it a request link.
 * 2. The recovery wallet opens it, checks what it is asked, and signs the
 *    proof. Signing moves nothing and costs nothing.
 * 3. It sends the owner the answer link, which carries the signature.
 * 4. The owner opens it and sends `requestRecoveryAddress` from the Vault
 *    page's safety card, reviewed like any other safety action.
 *
 * Both links carry only what is signed, never a key.
 */
import type { PublicClient } from 'viem';
import { directAuth, recoveryCall as encodeRecovery } from '@vaipakam/lib/protectedAccountView';
import {
  RECOVERY_CHANGE_WAIT_SECONDS,
  VAULT_PURPOSE_RECOVERY_PROOF,
  recoveryProofAuth,
  recoveryProofParams,
  recoveryRequestParams,
  type RecoveryProof,
  type RecoveryRequest,
} from '@vaipakam/lib/vaultProtectionAuth';
import { VAULT } from './payout';

export {
  RECOVERY_PROOF_LIFETIME_SECONDS,
  parseRecoveryProof,
  parseRecoveryRequest,
  recoveryProofTypedData,
  type RecoveryProof,
  type RecoveryRequest,
} from '@vaipakam/lib/vaultProtectionAuth';

type Hex = `0x${string}`;

/** The account's recovery address as its vault holds it. */
export interface RecoveryState {
  /** The address in force now, or null. */
  inForce: Hex | null;
  /** A setting or change still waiting, or null. */
  pending: Hex | null;
  /** When the pending one comes into force (0 = none). */
  pendingAt: number;
  /** Whether the account was clawed back (its lock never lifts). */
  recovered: boolean;
}

const ZERO = /^0x0{40}$/i;

export async function readRecovery(c: PublicClient, vault: Hex, blockNumber?: bigint): Promise<RecoveryState> {
  const r = (await c.readContract({ address: vault, abi: VAULT, functionName: 'protectionRecovery', ...(blockNumber === undefined ? {} : { blockNumber }) })) as readonly [
    Hex,
    Hex,
    bigint,
    boolean,
    bigint,
  ];
  return { inForce: ZERO.test(r[0]) ? null : r[0], pending: ZERO.test(r[1]) ? null : r[1], pendingAt: Number(r[2]), recovered: r[3] };
}

/** Whether a recovery address is set or pending, the condition the vault
 *  puts on switching protected mode on. */
export function hasRecovery(r: RecoveryState): boolean {
  return r.inForce !== null || r.pending !== null;
}

/** The recovery wallet's next proof nonce at the account's vault. */
export async function readProofNonce(c: PublicClient, vault: Hex, recovery: Hex): Promise<bigint> {
  return (await c.readContract({ address: vault, abi: VAULT, functionName: 'protectionNonce', args: [recovery, VAULT_PURPOSE_RECOVERY_PROOF] })) as bigint;
}

const origin = () => (typeof window === 'undefined' ? '' : window.location.origin);

/** The link the recovery wallet opens to sign (the lib's `rr_*` parameters
 *  on this app's Protection page). */
export function recoveryRequestLink(r: RecoveryRequest): string {
  return `${origin()}/protection?${new URLSearchParams(recoveryRequestParams(r)).toString()}`;
}

/** The link the owner opens to send the signed proof (the lib's `rp_*`
 *  parameters on this app's Vault page). */
export function recoveryAnswerLink(p: RecoveryProof): string {
  return `${origin()}/vault?${new URLSearchParams(recoveryProofParams(p)).toString()}`;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Why an address cannot be the account's recovery address, as far as the
 *  app can tell before the vault does (the vault also refuses a signer, a
 *  destination and the nominee): null when nothing the app knows stops it. */
export function recoveryAddressProblem(candidate: Hex, account: Hex, vault: Hex, diamond: Hex, state: RecoveryState | null): 'self' | 'vault' | 'protocol' | 'current' | null {
  if (same(candidate, account)) return 'self';
  if (same(candidate, vault)) return 'vault';
  if (same(candidate, diamond)) return 'protocol';
  if (state !== null && ((state.inForce !== null && same(candidate, state.inForce)) || (state.pending !== null && same(candidate, state.pending)))) return 'current';
  return null;
}

/** When a request sent now would come into force: twice the account's delay
 *  for a first address (twice the shortest delay while protected mode is
 *  off), {@link RECOVERY_CHANGE_WAIT_SECONDS} for a change of one in force. */
export function recoveryWaitSeconds(state: RecoveryState, enabled: boolean, delaySeconds: number, minDelaySeconds: number): number {
  return state.inForce === null ? 2 * (enabled ? delaySeconds : minDelaySeconds) : RECOVERY_CHANGE_WAIT_SECONDS;
}

/** Whether a proof belongs to this connected owner, network and vault. */
export function answerFits(p: RecoveryProof, chainId: number, diamond: Hex, account: Hex, vault: Hex | null): boolean {
  return p.chainId === chainId && same(p.diamond, diamond) && same(p.account, account) && vault !== null && same(p.vault, vault);
}

/** The `data` of the owner's `protect(bytes)`: `requestRecoveryAddress`,
 *  asked by the owner's direct call and proved by the signed proof. */
export function recoveryCall(p: RecoveryProof, owner: Hex): Hex {
  return encodeRecovery('requestRecoveryAddress', [p.recovery, directAuth(owner), recoveryProofAuth(p)]);
}

/** The `data` of the owner's `protect(bytes)` that cancels the pending
 *  address (the one in force, if any, stays). */
export function recoveryCancelCall(owner: Hex): Hex {
  return encodeRecovery('cancelRecoveryAddress', [directAuth(owner)]);
}
