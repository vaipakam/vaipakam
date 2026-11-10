/**
 * #3379 B2 — protected mode through the account's vault, for the specs that
 * set it up through the protocol's public entry points: the vault's
 * `protect(bytes)` runs a `VaultProtection` write authorized directly by the
 * sending wallet, and the Diamond's `applyProtection(account)` then applies
 * the platform side of a posture change.
 */
import type { Abi } from 'viem';
import { VaipakamVaultImplementationABI } from '@vaipakam/contracts/abis';
import type { Party, ScenarioChain } from '@vaipakam/anvil-harness/scenarioChain';
import { directAuth, protectionCall, type VaultProtectionState } from '@vaipakam/lib/protectedAccountView';

type Hex = `0x${string}`;
const VAULT = VaipakamVaultImplementationABI as Abi;
const ZERO = /^0x0{40}$/i;

/** `account`'s vault, created (permissionlessly) when it has none. */
export async function vaultOf(sc: ScenarioChain, account: Hex, create = false): Promise<Hex> {
  let vault = await sc.read<Hex>('getUserVaultAddress', [account]);
  if (ZERO.test(vault) && create) {
    await sc.diamondWrite('lender', 'getOrCreateUserVault', [account]);
    vault = await sc.read<Hex>('getUserVaultAddress', [account]);
  }
  return vault;
}

/** One `VaultProtection` write on `account`'s vault, sent and authorized by
 *  `who`; `auth: false` for a permissionless finalizer that takes none. */
export async function protect(sc: ScenarioChain, who: Party, account: Hex, functionName: string, args: readonly unknown[] = [], auth = true): Promise<void> {
  const vault = await vaultOf(sc, account);
  const data = protectionCall(functionName, auth ? [...args, directAuth(sc.address(who))] : args);
  await sc.write(who, vault, VAULT, 'protect', [data]);
}

/** Protected mode on for `who`'s own account with `delaySeconds` (what the
 *  retired `enableProtectedMode(delay, false)` did). */
export async function enableProtection(sc: ScenarioChain, who: Party, delaySeconds: number): Promise<void> {
  const account = sc.address(who);
  await vaultOf(sc, account, true);
  await protect(sc, who, account, 'enable', [delaySeconds]);
  await sc.diamondWrite(who, 'applyProtection', [account]);
}

/** The account's protected record as its vault holds it. */
export async function protectionMode(sc: ScenarioChain, account: Hex): Promise<{ enabled: boolean; locked: boolean; delaySeconds: number }> {
  const vault = await vaultOf(sc, account);
  if (ZERO.test(vault)) return { enabled: false, locked: false, delaySeconds: 0 };
  const s = (await sc.pub.readContract({ address: vault, abi: VAULT, functionName: 'protectionState' })) as VaultProtectionState;
  return { enabled: s[0], locked: s[1], delaySeconds: Number(s[2]) };
}
