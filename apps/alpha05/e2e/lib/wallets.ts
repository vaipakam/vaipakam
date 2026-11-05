/**
 * Ephemeral role wallets, generated fresh for every suite run and funded
 * with `anvil_setBalance`, so no private key exists outside the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem';
import { setBalance } from './anvil';
import { STATE_DIR } from './artifacts';

export type Role = 'lender' | 'borrower' | 'visitor';
export const ROLES: Role[] = ['lender', 'borrower', 'visitor'];

const STATE_FILE = path.join(STATE_DIR, 'wallets.json');

export async function createAndFundWallets(): Promise<Record<Role, string>> {
  const roster = {} as Record<Role, string>;
  for (const role of ROLES) {
    const pk = generatePrivateKey();
    roster[role] = pk;
    await setBalance(privateKeyToAccount(pk).address, 10n ** 20n); // 100 ETH
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(roster, null, 2));
  return roster;
}

export function accountFor(role: Role): PrivateKeyAccount {
  const roster = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Record<Role, `0x${string}`>;
  return privateKeyToAccount(roster[role]);
}
