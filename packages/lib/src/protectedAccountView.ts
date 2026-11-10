/**
 * #3205 — `ProtectedAccountFacet.getProtectedAccount`, as consumers index it.
 *
 * #3318 retired protected mode's NFT queue and renamed its two struct fields
 * in place (`protectNfts` → `retiredProtectNfts`, `pendingNftOffAt` →
 * `retiredPendingNftOffAt`), so the generated ABI decodes them under the new
 * names. A pre-#3205 Diamond still sets them; a standalone one never does
 * (they read false / 0). Every reader passes the decoded record through
 * {@link protectedAccountFromView} ONCE, at the point it is read, and indexes
 * the old names, so a consumer can never read `undefined` for them (#3318
 * Codex r2: a keeper `BigInt(undefined)` aborted its whole pass).
 *
 * TODO(#3321 positionNft-legacy-removal): once every chain is standalone the
 * two fields carry nothing; drop them from consumers with the legacy mode.
 */

import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { VaultProtectionABI, VaipakamVaultImplementationABI } from '@vaipakam/contracts/abis';

/** The two fields under the names consumers use. */
export interface ProtectedAccountNftFields {
  protectNfts: boolean;
  pendingNftOffAt: bigint;
}

/** `raw` with the two NFT-queue fields under their consumer names. Accepts
 *  either decoding (new `retired*` names or the old ones). Other fields are
 *  passed through unchanged. */
export function protectedAccountFromView<T extends object>(
  raw: T,
): Omit<T, 'retiredProtectNfts' | 'retiredPendingNftOffAt'> & ProtectedAccountNftFields {
  const r = raw as Record<string, unknown>;
  const { retiredProtectNfts, retiredPendingNftOffAt, ...rest } = r;
  const protectNfts = 'retiredProtectNfts' in r ? retiredProtectNfts : r.protectNfts;
  const pending = 'retiredPendingNftOffAt' in r ? retiredPendingNftOffAt : r.pendingNftOffAt;
  return {
    ...(rest as Omit<T, 'retiredProtectNfts' | 'retiredPendingNftOffAt'>),
    protectNfts: Boolean(protectNfts),
    pendingNftOffAt: BigInt((pending as bigint | number | string | undefined) ?? 0),
  };
}

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
export interface ProtectedAccountRecordFromVault extends ProtectedAccountNftFields {
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
 * none). NFT protection's queue was retired by #3318 and reads off.
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
    protectNfts: false,
    pendingNftOffAt: 0n,
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
