/**
 * Protected mode's record as consumers index it, rebuilt from the account's
 * vault and the Diamond's platform side (#3379 Stage B2).
 */

import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { VaultProtectionABI, VaipakamVaultImplementationABI } from '@vaipakam/contracts/abis';

// ─── #3379 Stage B2 — protected mode lives in the account's vault ──────────
//
// The Diamond's `getProtectedAccount` and its protected-mode writes are gone:
// the record is the vault's (`VaultProtection`, run by the vault's
// `protect(bytes)`), and the Diamond keeps only the platform side
// (`getProtection(account)` → vault, co-sign requirement, pending co-sign
// switch-off). These helpers are the one place every consumer builds a vault
// write and reads the record back in the shape it already indexes.


const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

// The ABI-free half (the `Auth` shape and the action codes) lives in
// `vaultProtectionAuth`, so a native-ESM loader (Playwright) can import it
// without reaching the ABI barrel's attribute-less JSON imports.
export {
  directAuth,
  VAULT_SETTING,
  VAULT_SIGNER,
  VAULT_REPLACE,
  replacementArgs,
  type VaultProtectionAuth,
} from './vaultProtectionAuth';

/** The `data` argument of the vault's `protect(bytes)`: the ABI-encoded call
 *  to one `VaultProtection` function. */
export function protectionCall(functionName: string, args: readonly unknown[] = []): Hex {
  return encodeFunctionData({ abi: VaultProtectionABI as Abi, functionName, args } as never);
}

/** `vault.protectionState()`, positional as viem decodes it. */
export type VaultProtectionState = readonly [
  enabled: boolean,
  locked: boolean,
  delay: number,
  cooldownUntil: bigint,
  lockedBy: Address,
  signers: readonly Address[],
  allowlist: readonly Address[],
];

/**
 * The vault's protected-mode views the readers need beyond `protectionState`
 * (#3379 B2): the pending setting times and the lock time, and the
 * replacement's tally — taken from the exported vault ABI.
 */
export const VAULT_PROTECTION_VIEWS_ABI = (VaipakamVaultImplementationABI as Abi).filter(
  (item) => item.type === 'function' && (item.name === 'protectionPending' || item.name === 'replacementTally'),
);

/** `vault.protectionPending()`, positional (0 = none). */
export type VaultProtectionPending = readonly [
  pendingDelay: number,
  pendingDelayAt: bigint,
  pendingUnlockAt: bigint,
  pendingDisableAt: bigint,
  lockedAt: bigint,
];

/** `vault.replacementTally()`, positional. */
export type VaultReplacementTally = readonly [approvals: bigint, threshold: bigint];

/** `ProtectedAccountFacet.getProtection(account)`, positional. */
export type DiamondProtection = readonly [vault: Address, requireCosign: boolean, pendingCosignOffAt: bigint];

/** The record consumers indexed from the retired `getProtectedAccount`,
 *  rebuilt from the vault and the Diamond. */
export interface ProtectedAccountRecordFromVault {
  enabled: boolean;
  locked: boolean;
  requireCosign: boolean;
  retired: boolean;
  delaySeconds: number;
  pendingDelay: number;
  pendingDelayAt: bigint;
  pendingDisableAt: bigint;
  pendingUnlockAt: bigint;
  pendingCosignOffAt: bigint;
  cooldownUntil: bigint;
  lockedAt: bigint;
  lockedBy: Address;
  controller: Address;
  retiredPendingUnpinAt: bigint;
}

/**
 * The account's protected record in the retired view's shape.
 *
 * `state` and `owner` are null when the account has no vault (protected mode
 * then reads as off). `retired` is the vault's owner record having moved to
 * another wallet (a finalized replacement); `controller` is that wallet.
 *
 * The pending setting changes (a lowered delay, a switch-off, an unlock)
 * and the lock time come from `pending` (`vault.protectionPending()`; 0 =
 * none).
 */
export function protectedAccountFromVault(
  account: Address,
  protection: DiamondProtection | null,
  state: VaultProtectionState | null,
  owner: Address | null,
  pending: VaultProtectionPending | null,
): ProtectedAccountRecordFromVault {
  const [, requireCosign, pendingCosignOffAt] = protection ?? [ZERO_ADDRESS, false, 0n];
  const [enabled, locked, delay, cooldownUntil, lockedBy] = state ?? [false, false, 0, 0n, ZERO_ADDRESS, [], []];
  const [pendingDelay, pendingDelayAt, pendingUnlockAt, pendingDisableAt, lockedAt] = pending ?? [0, 0n, 0n, 0n, 0n];
  const retired = owner !== null && owner.toLowerCase() !== account.toLowerCase();
  return {
    enabled,
    locked,
    requireCosign,
    retired,
    delaySeconds: Number(delay),
    pendingDelay: Number(pendingDelay),
    pendingDelayAt: BigInt(pendingDelayAt),
    pendingDisableAt: BigInt(pendingDisableAt),
    pendingUnlockAt: BigInt(pendingUnlockAt),
    pendingCosignOffAt: BigInt(pendingCosignOffAt),
    cooldownUntil: BigInt(cooldownUntil),
    lockedAt: BigInt(lockedAt),
    lockedBy,
    controller: retired ? (owner as Address) : ZERO_ADDRESS,
    retiredPendingUnpinAt: 0n,
  };
}
