// apps/keeper/src/protectedVault.ts
//
// #3379 Stage B2 — an account's protected record is held by its vault. The
// Diamond's `getProtection(account)` names the vault and keeps the
// platform-side co-sign setting; the vault's `protectionState()` and
// `vaultOwner()` hold the rest. This is the one place the protected-account
// pass and its Telegram steps rebuild the record they index
// (`protectedAccountFromVault`), so neither reads the vault its own way.

import type { Address } from 'viem';
import {
  protectedAccountFromVault,
  type DiamondProtection,
  type ProtectedAccountRecordFromVault,
  type VaultProtectionState,
} from '@vaipakam/lib/protectedAccountView';
import type { PassReader, ReadCall } from './passReader';

/** The account's protected record, and the vault that holds it (zero when the
 *  account has none: protected mode then reads off). Every field the vault
 *  does not expose in B2 reads 0 (`protectedAccountFromVault`). */
export type ProtectedAccount = ProtectedAccountRecordFromVault & { vault: Address };

const isZero = (a: string): boolean => /^0x0{40}$/i.test(a);

/** The Diamond read that names `account`'s vault. */
export const protectionRead = (account: Address): ReadCall => ({ functionName: 'getProtection', args: [account] });

/** The vault reads that complete the record, made on `vault`. */
export const vaultReads = (vault: Address): ReadCall[] => [
  { functionName: 'protectionState', args: [], address: vault },
  { functionName: 'vaultOwner', args: [], address: vault },
];

/** The record from its three answers; the vault's two are ignored when the
 *  Diamond names no vault. */
export function accountFrom(
  account: Address,
  protection: DiamondProtection,
  state: VaultProtectionState | null,
  owner: Address | null,
): ProtectedAccount {
  const vault = protection[0];
  if (isZero(vault)) return { ...protectedAccountFromVault(account, protection, null, null), vault };
  return { ...protectedAccountFromVault(account, protection, state, owner), vault };
}

/** Whether the record names no vault. */
export const noVault = (a: { vault: Address }): boolean => isZero(a.vault);

/** One account's record at the head, by the reader's cutoff: the Diamond
 *  first (which vault), then the vault. Throws as `PassReader.one` does. */
export async function readProtectedAccount(r: PassReader, account: Address): Promise<ProtectedAccount> {
  const protection = await r.one<DiamondProtection>('getProtection', [account]);
  if (isZero(protection[0])) return accountFrom(account, protection, null, null);
  const [state, owner] = await Promise.all([
    r.one<VaultProtectionState>('protectionState', [], protection[0]),
    r.one<Address>('vaultOwner', [], protection[0]),
  ]);
  return accountFrom(account, protection, state, owner);
}
