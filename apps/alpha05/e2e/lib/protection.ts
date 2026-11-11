/**
 * #3379 B2 — protected mode through the account's vault, for the specs that
 * set it up through the protocol's public entry points: the vault's
 * `protect(bytes)` runs a `VaultProtection` write authorized directly by the
 * sending wallet, and the Diamond's `applyProtection(account)` then applies
 * the platform side of a posture change.
 */
import fs from 'node:fs';
import { encodeFunctionData, type Abi } from 'viem';
import type { Party, ScenarioChain } from '@vaipakam/anvil-harness/scenarioChain';
import type { VaultProtectionState } from '@vaipakam/lib/protectedAccountView';
import { directAuth } from '@vaipakam/lib/vaultProtectionAuth';

type Hex = `0x${string}`;

/** The vault and `VaultProtection` ABIs, read from the exported files rather
 *  than imported: the `@vaipakam/contracts/abis` barrel imports JSON without
 *  an import attribute, which Playwright's native-ESM loader refuses (the
 *  anvil harness reads the Diamond ABI the same way). Same files, same
 *  entries. */
const readAbi = (name: string): Abi =>
  JSON.parse(fs.readFileSync(new URL(`../../../../packages/contracts/src/abis/${name}.json`, import.meta.url), 'utf8')) as Abi;
const VAULT = readAbi('VaipakamVaultImplementation');
const VAULT_PROTECTION = readAbi('VaultProtection');

/** The `data` of `vault.protect(bytes)`: one encoded `VaultProtection` call
 *  (what `protectionCall` of `@vaipakam/lib/protectedAccountView` builds). */
function protectionCall(functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: VAULT_PROTECTION, functionName, args } as never);
}
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

/** The account's active payout destinations, as its vault holds them. */
export async function allowlistOf(sc: ScenarioChain, account: Hex): Promise<readonly Hex[]> {
  const vault = await vaultOf(sc, account);
  if (ZERO.test(vault)) return [];
  const s = (await sc.pub.readContract({ address: vault, abi: VAULT, functionName: 'protectionState' })) as VaultProtectionState;
  return s[6] as readonly Hex[];
}

/** The account's active secondary signers, as its vault holds them. */
export async function signersOf(sc: ScenarioChain, account: Hex): Promise<readonly Hex[]> {
  const vault = await vaultOf(sc, account);
  if (ZERO.test(vault)) return [];
  const s = (await sc.pub.readContract({ address: vault, abi: VAULT, functionName: 'protectionState' })) as VaultProtectionState;
  return s[5] as readonly Hex[];
}

/** The wallets asked to become a signer and still waiting (the vault's
 *  current list). */
export async function pendingSignersOf(sc: ScenarioChain, account: Hex): Promise<readonly Hex[]> {
  const vault = await vaultOf(sc, account);
  if (ZERO.test(vault)) return [];
  const [, signers] = (await sc.pub.readContract({ address: vault, abi: VAULT, functionName: 'pendingAdditions' })) as readonly [readonly Hex[], readonly Hex[]];
  return signers;
}
