/**
 * Ephemeral role wallets — generated fresh for every suite run and
 * funded via `anvil_setBalance`, so NO private key ever exists
 * outside the run (nothing to commit, nothing to leak in CI).
 * Global-setup writes them to a state file; fixtures and tests read
 * them back so every worker sees the same roster.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem';
import { setBalance } from './anvil';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `vaultOwner` is a wallet no loan scenario touches: the protected-account
 *  spec turns protection ON for it, which would delay every payout of a
 *  shared role and so change what every later spec saw.
 *
 *  `rewardLender` / `rewardBorrower` are the two sides of the claim-horizon
 *  drive's one loan (spec 54, #3207). Theirs are the only reward entries on
 *  the chain, and the indexer stub serves a wallet carrying claim-horizon
 *  logs its chain-derived feed instead of the synthetic one spec 22 reads,
 *  so no other spec may use them. */
export type Role =
  | 'lender'
  | 'borrower'
  | 'newLender'
  | 'newBorrower'
  | 'vaultOwner'
  | 'rewardLender'
  | 'rewardBorrower';
export const ROLES: Role[] = [
  'lender',
  'borrower',
  'newLender',
  'newBorrower',
  'vaultOwner',
  'rewardLender',
  'rewardBorrower',
];

const STATE_FILE = path.join(HERE, '..', '.state', 'wallets.json');

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
  const roster = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Record<
    Role,
    `0x${string}`
  >;
  return privateKeyToAccount(roster[role]);
}
