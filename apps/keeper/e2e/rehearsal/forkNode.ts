/**
 * What the rehearsal's off-chain stage does to the step's fork (#3894), all
 * of it listed in the stage's report (DeployRehearsalDesign §7):
 *
 *   - checks the node is a rehearsal fork: it carries the local-node marker
 *     the fork launcher places (the same code the e2e fixture places, at the
 *     same address), so a URL that reached a real chain fails here before
 *     anything is sent;
 *   - makes the bot keys for the run, funds them, and grants each its bot
 *     role, as the fresh-deploy guide's bot-role step does with the real bot
 *     wallets (TestnetFreshDeployGuide §5.2). The grant is sent as the account
 *     that holds the role's admin role on the fork, found from the run's own
 *     records (the admin, then the timelock, then the Diamond's owner) and
 *     impersonated for that one transaction.
 *
 * The keys live in memory for the step and are never written anywhere; the
 * report lists their addresses.
 */
import { createPublicClient, encodeFunctionData, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LOCAL_NODE_MARKER } from '@vaipakam/anvil-harness/fixture';
import { anvilControl } from '@vaipakam/anvil-harness/rpc';

const ACCESS_ABI = [
  { type: 'function', name: 'getRoleAdmin', stateMutability: 'view', inputs: [{ name: 'role', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'grantRole', stateMutability: 'nonpayable', inputs: [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }], outputs: [] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/** The bot roles the fresh-deploy guide grants, each to its own wallet. */
export const BOT_ROLES = ['KEEPER_ROLE', 'WATCHER_ROLE', 'NOTIF_BILLER_ROLE'] as const;
export type BotRole = (typeof BOT_ROLES)[number];

/** ETH each run-made bot key is funded with on the fork. */
export const BOT_FUNDING_WEI = 10n ** 19n;

export interface BotGrant {
  role: BotRole;
  holder: Address;
  /** Who sent the grant, impersonated. */
  grantedBy: Address;
  tx: Hex;
  /** The fork block the grant was mined in. */
  block: string;
}

export interface BotKeys {
  /** The keeper's signing key, for the step's keeper environment only. */
  keeperKey: Hex;
  grants: BotGrant[];
  funded: { address: Address; wei: string }[];
}

/** The fork's chain id, after checking it carries the rehearsal marker. */
export async function checkFork(url: string): Promise<number> {
  const client = createPublicClient({ transport: http(url) });
  const code = (await client.getCode({ address: LOCAL_NODE_MARKER.address })) ?? '0x';
  if (code.toLowerCase() !== LOCAL_NODE_MARKER.code.toLowerCase()) {
    throw new Error('rehearsal: the node at VAIPAKAM_REHEARSAL_RPC_URL carries no rehearsal marker; refusing to act on it');
  }
  return client.getChainId();
}

/**
 * Make, fund and grant the bot keys. `candidates` are the accounts the run's
 * records name as possible role admins, tried in order; the Diamond's owner
 * is tried after them. A role whose admin none of them holds is refused.
 */
export async function grantBotRoles(url: string, diamond: Address, candidates: readonly (Address | undefined)[]): Promise<BotKeys> {
  const client = createPublicClient({ transport: http(url) });
  const control = anvilControl(url);
  const owner = await client.readContract({ address: diamond, abi: ACCESS_ABI, functionName: 'owner' });
  const tried = [...new Set([...candidates.filter((c): c is Address => !!c), owner].map((a) => a.toLowerCase() as Address))];

  const keys = Object.fromEntries(BOT_ROLES.map((r) => [r, generatePrivateKey()])) as Record<BotRole, Hex>;
  const funded: BotKeys['funded'] = [];
  const grants: BotGrant[] = [];
  for (const role of BOT_ROLES) {
    const holder = privateKeyToAccount(keys[role]).address;
    await control.setBalance(holder, BOT_FUNDING_WEI);
    funded.push({ address: holder, wei: BOT_FUNDING_WEI.toString() });

    const roleId = keccak256(toBytes(role));
    const adminRole = await client.readContract({ address: diamond, abi: ACCESS_ABI, functionName: 'getRoleAdmin', args: [roleId] });
    let granter: Address | undefined;
    for (const c of tried) {
      // eslint-disable-next-line no-await-in-loop
      if (await client.readContract({ address: diamond, abi: ACCESS_ABI, functionName: 'hasRole', args: [adminRole, c] })) {
        granter = c;
        break;
      }
    }
    if (!granter) throw new Error(`rehearsal: none of the run's admin accounts holds the admin role of ${role}; the bot role cannot be granted`);

    await control.rpc('anvil_impersonateAccount', [granter]);
    try {
      // A contract granter (the timelock) may hold no ETH on the fork.
      const balance = await client.getBalance({ address: granter });
      if (balance < BOT_FUNDING_WEI) await control.setBalance(granter, BOT_FUNDING_WEI);
      const data = encodeFunctionData({ abi: ACCESS_ABI, functionName: 'grantRole', args: [roleId, holder] });
      const tx = await control.rpc<Hex>('eth_sendTransaction', [{ from: granter, to: diamond, data }]);
      const receipt = await client.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== 'success') throw new Error(`rehearsal: granting ${role} reverted`);
      grants.push({ role, holder, grantedBy: granter, tx, block: receipt.blockNumber.toString() });
    } finally {
      await control.rpc('anvil_stopImpersonatingAccount', [granter]);
    }
    const held = await client.readContract({ address: diamond, abi: ACCESS_ABI, functionName: 'hasRole', args: [roleId, holder] });
    if (!held) throw new Error(`rehearsal: ${role} reads as not held after its grant`);
  }
  return { keeperKey: keys.KEEPER_ROLE, grants, funded };
}
