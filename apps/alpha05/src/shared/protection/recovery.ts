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
import { encodeFunctionData, getAddress, isAddress, isHex, type Abi, type PublicClient } from 'viem';
import { VaultRecoveryABI } from '@vaipakam/contracts/abis';
import { directAuth } from '@vaipakam/lib/protectedAccountView';
import { VAULT } from './payout';

type Hex = `0x${string}`;

/** `VaultProtection.PURPOSE_RECOVERY_PROOF`: the nonce lane of the proof. */
export const PURPOSE_RECOVERY_PROOF = 9;
/** `VaultProtection.RECOVERY_CHANGE_WAIT`: how long a change of an address
 *  in force waits before it replaces it. */
export const RECOVERY_CHANGE_WAIT_S = 30 * 86_400;
/** How long a signed proof stays usable. */
export const PROOF_LIFETIME_S = 7 * 86_400;

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

/**
 * The request the owner sends the recovery wallet, as a link
 * (`/protection?rr_chain=…&rr_account=…&rr_recovery=…`): the network, the
 * account and the address asked. The recovery wallet's page finds the
 * account's vault itself, from the protocol's contract on that network.
 */
export interface RecoveryRequest {
  chainId: number;
  account: Hex;
  recovery: Hex;
}

/** The recovery wallet's signed answer, as a link back to the owner's Vault
 *  page (`rp_*`): everything the signature names, and the signature. */
export interface RecoveryAnswer {
  chainId: number;
  vault: Hex;
  account: Hex;
  diamond: Hex;
  recovery: Hex;
  nonce: bigint;
  expiry: number;
  signature: Hex;
}

export const RECOVERY_PROOF_TYPES = {
  RecoveryProof: [
    { name: 'account', type: 'address' },
    { name: 'diamond', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

/** The typed data the recovery wallet signs: the vault's own domain. */
export function recoveryTypedData(a: Omit<RecoveryAnswer, 'signature' | 'recovery'>) {
  return {
    domain: { name: 'Vaipakam Vault', version: '1', chainId: a.chainId, verifyingContract: a.vault },
    types: RECOVERY_PROOF_TYPES,
    primaryType: 'RecoveryProof' as const,
    message: { account: a.account, diamond: a.diamond, nonce: a.nonce, expiry: BigInt(a.expiry) },
  };
}

/** The recovery wallet's next proof nonce at the account's vault. */
export async function readProofNonce(c: PublicClient, vault: Hex, recovery: Hex): Promise<bigint> {
  return (await c.readContract({ address: vault, abi: VAULT as Abi, functionName: 'protectionNonce', args: [recovery, PURPOSE_RECOVERY_PROOF] })) as bigint;
}

const addr = (v: string | null): Hex | null => (v !== null && isAddress(v, { strict: false }) ? (getAddress(v) as Hex) : null);
const int = (v: string | null): number | null => (v !== null && /^\d{1,15}$/.test(v) && Number(v) > 0 ? Number(v) : null);

/** Read a request link's parameters strictly: any one missing or of the
 *  wrong shape refuses the whole request. Null when the link carries none. */
export function parseRecoveryRequest(params: URLSearchParams): RecoveryRequest | null {
  const chainId = int(params.get('rr_chain'));
  const account = addr(params.get('rr_account'));
  const recovery = addr(params.get('rr_recovery'));
  return chainId === null || account === null || recovery === null ? null : { chainId, account, recovery };
}

export function parseRecoveryProof(params: URLSearchParams): RecoveryAnswer | null {
  const chainId = int(params.get('rp_chain'));
  const vault = addr(params.get('rp_vault'));
  const account = addr(params.get('rp_account'));
  const diamond = addr(params.get('rp_diamond'));
  const recovery = addr(params.get('rp_recovery'));
  const nonce = params.get('rp_nonce');
  const expiry = int(params.get('rp_expiry'));
  const sig = params.get('rp_sig');
  if (chainId === null || vault === null || account === null || diamond === null || recovery === null || expiry === null) return null;
  if (nonce === null || !/^\d{1,78}$/.test(nonce) || sig === null || !isHex(sig) || sig.length < 4) return null;
  return { chainId, vault, account, diamond, recovery, nonce: BigInt(nonce), expiry, signature: sig as Hex };
}

const origin = () => (typeof window === 'undefined' ? '' : window.location.origin);
const lower = (a: string) => a.toLowerCase();

/** The link the recovery wallet opens to sign. */
export function recoveryRequestLink(r: RecoveryRequest): string {
  const q = new URLSearchParams({ rr_chain: String(r.chainId), rr_account: lower(r.account), rr_recovery: lower(r.recovery) });
  return `${origin()}/protection?${q.toString()}`;
}

/** The link the owner opens to send the signed answer. */
export function recoveryAnswerLink(a: RecoveryAnswer): string {
  const q = new URLSearchParams({
    rp_chain: String(a.chainId),
    rp_vault: lower(a.vault),
    rp_account: lower(a.account),
    rp_diamond: lower(a.diamond),
    rp_recovery: lower(a.recovery),
    rp_nonce: a.nonce.toString(),
    rp_expiry: String(a.expiry),
    rp_sig: a.signature,
  });
  return `${origin()}/vault?${q.toString()}`;
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
 *  off), {@link RECOVERY_CHANGE_WAIT_S} for a change of one in force. */
export function recoveryWaitSeconds(state: RecoveryState, enabled: boolean, delaySeconds: number, minDelaySeconds: number): number {
  return state.inForce === null ? 2 * (enabled ? delaySeconds : minDelaySeconds) : RECOVERY_CHANGE_WAIT_S;
}

/** Whether an answer belongs to this connected owner, network and vault. */
export function answerFits(a: RecoveryAnswer, chainId: number, diamond: Hex, account: Hex, vault: Hex | null): boolean {
  return a.chainId === chainId && same(a.diamond, diamond) && same(a.account, account) && vault !== null && same(a.vault, vault);
}

/** The `data` of the owner's `protect(bytes)`: `requestRecoveryAddress`,
 *  asked by the owner's direct call and proved by the signed answer. */
export function recoveryCall(a: RecoveryAnswer, owner: Hex): Hex {
  const proof = { key: a.recovery, expiry: BigInt(a.expiry), sig: a.signature };
  return encodeFunctionData({ abi: VaultRecoveryABI as Abi, functionName: 'requestRecoveryAddress', args: [a.recovery, directAuth(owner), proof] });
}
