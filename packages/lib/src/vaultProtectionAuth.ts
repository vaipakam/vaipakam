/**
 * #3379 Stage B2 — the ABI-free half of a vault protection write: the
 * `VaultProtection.Auth` shape and the action codes. Kept apart from
 * `protectedAccountView` (which imports the ABI barrel) so that code loaded
 * as native ESM, the Playwright e2e specs, can use it without reaching the
 * barrel's JSON imports, which carry no import attribute.
 */
import type { Address, Hex } from 'viem';

/** `VaultProtection.Auth`. B2 always sends the DIRECT form: the caller's own
 *  key, no expiry, no signature (the vault then requires msg.sender == key). */
export interface VaultProtectionAuth {
  key: Address;
  expiry: bigint;
  sig: Hex;
}

/** The direct `Auth` for a write the wallet `key` sends itself. */
export function directAuth(key: Address): VaultProtectionAuth {
  return { key, expiry: 0n, sig: '0x' };
}

/** `VaultProtection.SETTINGS_*`, the `action` of `cancelSetting`. */
export const VAULT_SETTING = { delay: 2, disable: 3, unlock: 4 } as const;
/** `VaultProtection.SIGNER_*`, the `action` of `signerChange`. */
export const VAULT_SIGNER = { add: 1, accept: 2, remove: 3, cancel: 4 } as const;
/** `VaultProtection.REPLACE_*`, the `action` of `replacement`. */
export const VAULT_REPLACE = { propose: 1, approve: 2, cancel: 3 } as const;

/** The `action` and `nominee` arguments of the vault's `replacement`, the one
 *  builder every caller uses. Approve and cancel act on the proposal in force
 *  and must name ITS nominee: the vault refuses any other (Codex #3489 r2/r3),
 *  so a caller passes the live proposal's nominee, never a placeholder. A
 *  proposal names the wallet proposed. */
export function replacementArgs(action: keyof typeof VAULT_REPLACE, nominee: Address): [number, Address] {
  return [VAULT_REPLACE[action], nominee];
}

// ─── #3246 part 2 — the recovery address's proof of control ─────────────
//
// Protected mode needs a recovery address before it can be switched on: the
// one place a clawback pays. The owner names it, and the address proves it
// is controlled by someone: its own EIP-712 signature over the account, the
// Diamond and its nonce, on the account's vault's domain. The owner and the
// recovery address are two wallets, so the proof travels between them as a
// link (see "The hand-off links" below). The proof moves nothing: it is
// bound to one account, one vault, one chain and one nonce, and expires.

/** `VaultProtectionBase.PURPOSE_RECOVERY_PROOF`: the nonce lane the proof
 *  spends (`vault.protectionNonce(recovery, 9)`). */
export const VAULT_PURPOSE_RECOVERY_PROOF = 9;

/** `VaultProtectionBase.RECOVERY_CHANGE_WAIT`: how long a CHANGE of an
 *  address already in force waits. A first setting waits twice the payout
 *  delay instead (twice the shortest delay while protection is off). */
export const RECOVERY_CHANGE_WAIT_SECONDS = 30 * 86_400;

/** How long a proof the app asks for stays usable. */
export const RECOVERY_PROOF_LIFETIME_SECONDS = 7 * 86_400;

/** The vault's EIP-712 types for the proof, field order as
 *  `RECOVERY_PROOF_TYPEHASH` lists it. */
export const RECOVERY_PROOF_TYPES = {
  RecoveryProof: [
    { name: 'account', type: 'address' },
    { name: 'diamond', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

/** What the recovery wallet signs, and where. */
export interface RecoveryProofRequest {
  chainId: number;
  /** The account's vault: the domain's verifying contract. */
  vault: Address;
  /** The account (the vault's creation owner). */
  account: Address;
  diamond: Address;
  /** `vault.protectionNonce(recovery, VAULT_PURPOSE_RECOVERY_PROOF)`. */
  nonce: bigint;
  /** Unix seconds; the vault refuses the proof after it. */
  expiry: bigint;
}

/** The typed data the recovery wallet signs (`signTypedData` arguments
 *  without the account). */
export function recoveryProofTypedData(r: RecoveryProofRequest) {
  return {
    domain: { name: 'Vaipakam Vault', version: '1', chainId: r.chainId, verifyingContract: r.vault },
    types: RECOVERY_PROOF_TYPES,
    primaryType: 'RecoveryProof' as const,
    message: { account: r.account, diamond: r.diamond, nonce: r.nonce, expiry: r.expiry },
  };
}

/** A signed proof, as the owner receives it. */
export interface RecoveryProof {
  chainId: number;
  vault: Address;
  account: Address;
  diamond: Address;
  recovery: Address;
  nonce: bigint;
  expiry: bigint;
  sig: Hex;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const DEC = /^(0|[1-9][0-9]*)$/;

// ─── The hand-off links ─────────────────────────────────────────────────────
//
// The proof travels as two links, so the recovery wallet never sends a
// transaction (no gas on a cold wallet) and nobody copies a signature by
// hand. Both apps use these parameters on their own protection page:
//   1. the owner names the address and sends the recovery wallet a REQUEST
//      link (`rr_chain`, `rr_account`, `rr_recovery`);
//   2. the recovery wallet opens it, signs, and is shown a PROOF link
//      (`rp_*`) to send back;
//   3. the owner opens the proof link and sends `requestRecoveryAddress`.
// A link carries no authority by itself: the page checks the proof against
// the connected owner, its vault, the chain and the named address, and the
// vault checks the signature, nonce and expiry again.

/** What the owner asks the recovery wallet to prove. */
export interface RecoveryRequest {
  chainId: number;
  account: Address;
  recovery: Address;
}

/** The query parameters of the owner's request link. */
export function recoveryRequestParams(r: RecoveryRequest): Record<string, string> {
  return { rr_chain: String(r.chainId), rr_account: r.account.toLowerCase(), rr_recovery: r.recovery.toLowerCase() };
}

/** A request link's parameters read back; null when the link carries none
 *  or a malformed one. */
export function parseRecoveryRequest(q: URLSearchParams): RecoveryRequest | null {
  const chain = q.get('rr_chain');
  const account = q.get('rr_account');
  const recovery = q.get('rr_recovery');
  if (!chain || !account || !recovery) return null;
  if (!DEC.test(chain) || !ADDR.test(account) || !ADDR.test(recovery)) return null;
  const chainId = Number(chain);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return { chainId, account: account as Address, recovery: recovery as Address };
}

/** The query parameters of the proof link the recovery wallet sends back. */
export function recoveryProofParams(p: RecoveryProof): Record<string, string> {
  return {
    rp_chain: String(p.chainId),
    rp_vault: p.vault.toLowerCase(),
    rp_account: p.account.toLowerCase(),
    rp_diamond: p.diamond.toLowerCase(),
    rp_recovery: p.recovery.toLowerCase(),
    rp_nonce: p.nonce.toString(),
    rp_expiry: p.expiry.toString(),
    rp_sig: p.sig,
  };
}

/** A proof link's parameters read back; null when the link carries none or a
 *  malformed one. It checks the shape only: the caller compares it with the
 *  account, vault, chain and address it expects and verifies the signature. */
export function parseRecoveryProof(q: URLSearchParams): RecoveryProof | null {
  const g = (k: string) => q.get(`rp_${k}`);
  const chain = g('chain');
  if (!chain || !DEC.test(chain)) return null;
  const chainId = Number(chain);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  const addrs = ['vault', 'account', 'diamond', 'recovery'].map(g);
  if (addrs.some((a) => !a || !ADDR.test(a))) return null;
  const nonce = g('nonce');
  const expiry = g('expiry');
  const sig = g('sig');
  if (!nonce || !DEC.test(nonce) || !expiry || !DEC.test(expiry) || !sig || !HEX.test(sig)) return null;
  if (BigInt(expiry) >= 1n << 64n) return null;
  const [vault, account, diamond, recovery] = addrs as Address[];
  return { chainId, vault, account, diamond, recovery, nonce: BigInt(nonce), expiry: BigInt(expiry), sig: sig as Hex };
}

/** The recovery link parameters, so a page can drop them once handled. */
export const RECOVERY_LINK_PARAMS = [
  'rr_chain',
  'rr_account',
  'rr_recovery',
  'rp_chain',
  'rp_vault',
  'rp_account',
  'rp_diamond',
  'rp_recovery',
  'rp_nonce',
  'rp_expiry',
  'rp_sig',
] as const;

/** The `proof` argument of `requestRecoveryAddress`. */
export function recoveryProofAuth(p: RecoveryProof): VaultProtectionAuth {
  return { key: p.recovery, expiry: p.expiry, sig: p.sig };
}
