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
