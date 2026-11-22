/**
 * The platform's contracts on a network, read from its deployment record
 * (#3919, #3921). One rule for every service that watches them: the failed
 * transaction pass (what users send to) and the indexer's event history
 * (what they emit).
 *
 * Every address in the record is classified by its key, and only this
 * chain's own platform contracts are watched:
 *   - `PLATFORM_CONTRACT_KEYS`: the platform's contracts on this chain, each
 *     at the address users and keepers call (a proxy, never the
 *     implementation behind it);
 *   - `NOT_WATCHED_KEYS`: people and the treasury, implementations behind a
 *     proxy, outside contracts the platform only uses (the network's wrapped
 *     native token), and addresses on another chain;
 *   - the facets (`facets`), reached through the Diamond;
 *   - the testnet's mock assets (`testnetMocks`), stand-ins for outside
 *     tokens, watched only when `includeTestnetMocks` is left on.
 * A key in neither list is not watched; the package test fails on any
 * address key in the deployment bundle that is in neither, so a new key is
 * classified when it appears rather than watched or dropped by accident.
 */

/** This chain's own platform contracts, by key (a nested key as `parent.key`). */
export const PLATFORM_CONTRACT_KEYS: ReadonlySet<string> = new Set([
  'diamond',
  'positionNFT',
  'priceGuard',
  'protocolRegistry',
  'feedRegistry',
  'backstopVault',
  'vaultBeacon',
  'vaultProtection',
  'timelock',
  'ccipMessenger',
  'rewardMessenger',
  'rewardCustodyHolder',
  'rewardRemittanceReceiver',
  'buybackRemittanceReceiver',
  'vpfiToken',
  'vpfiMirror',
  'vpfiTokenPool',
  'vpfiPoolRateGovernor',
  'vpfiReturnReceiver',
  'vpfiReturnSender',
  'sanctionsList',
  'sanctionsDelistingTimelock',
  'sanctionsClearanceAttestor',
  'sanctionsTestnetOverlay',
  'sanctionsOracleStandIn',
]);

/** Address keys that are deliberately not watched, with the reason in each group. */
export const NOT_WATCHED_KEYS: ReadonlySet<string> = new Set([
  // People and the treasury, not contracts.
  'admin',
  'treasury',
  'keeperAddress',
  // Implementations, reached through their proxies.
  'vaultImpl',
  'vpfiTokenImpl',
  'ccipMessengerImpl',
  'rewardMessengerImpl',
  'rewardRemittanceReceiverImpl',
  'buybackRemittanceReceiverImpl',
  'vpfiReturnReceiverImpl',
  'vpfiReturnSenderImpl',
  // The network's wrapped native token: an outside contract whose logs are
  // every user of the network's, not the platform's (Codex #4016 r5).
  'weth',
  // The Diamond's configured sanctions source as the configure step recorded
  // it: on a testnet the overlay, watched under its own key; elsewhere it
  // may be an outside oracle.
  'sanctions.oracle',
  // The Base Diamond, named on a mirror chain: an address on another chain.
  'baseRewardDeployment',
]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Every address in a deployment record outside `facets` and `testnetMocks`, by its key. */
export function addressKeys(record: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && ADDRESS.test(v)) out.set(prefix + k, v);
      else if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'facets' && k !== 'testnetMocks') {
        walk(v as Record<string, unknown>, prefix + k + '.');
      }
    }
  };
  walk(record, '');
  return out;
}

export function watchedAddresses(record: Record<string, unknown>, opts: { includeTestnetMocks?: boolean } = {}): string[] {
  const out = new Set<string>();
  for (const [key, addr] of addressKeys(record)) {
    if (PLATFORM_CONTRACT_KEYS.has(key)) out.add(addr.toLowerCase());
  }
  const mocks = record.testnetMocks;
  if ((opts.includeTestnetMocks ?? true) && mocks && typeof mocks === 'object') {
    for (const v of Object.values(mocks as Record<string, unknown>)) {
      if (typeof v === 'string' && ADDRESS.test(v)) out.add(v.toLowerCase());
    }
  }
  return [...out].sort();
}
