/**
 * The capability service (rulebook §3.1). Every route reads it; a route that
 * needs a capability the service reports `absent` or `unknown` says so on
 * the surface and withholds the signing step. `unknown` is the DEFAULT for
 * everything the service has not yet read or could not read: the service
 * never guesses.
 */

export type Posture = 'present' | 'absent' | 'unknown';

export interface KeeperPassPosture {
  /** The pass's name in the permissionless-steps ledger. */
  pass: string;
  armed: Posture;
  /** When the keeper health endpoint last reported, or null if never. */
  reportedAt: number | null;
}

export interface ChainCapabilities {
  chainId: number;
  diamond: `0x${string}`;
  /** Every selector the Diamond routes, from the loupe; `null` until read. A
   *  refresh changes this set, and the app re-reads it rather than failing
   *  on a missing function (ACC-65). */
  routedSelectors: ReadonlySet<`0x${string}`> | null;
  /** Whether each named capability is present. Keys are matrix capability
   *  names ("listingExecutor", "alertsTelegram", "rpcProxy", ...). */
  services: Readonly<Record<string, Posture>>;
  keeper: readonly KeeperPassPosture[];
  provenance: {
    buildHash: string;
    buildTime: string;
    /** The deploy record's commit for this chain's Diamond, or null. */
    deployCommit: string | null;
  };
  /** When this snapshot stops being trusted and is re-read. */
  expiresAt: number;
  /** How the snapshot was obtained; stated on the freshness stamp. */
  source: 'chain' | 'indexer' | 'none';
}

/** The question every signing step asks before it is offered. */
export interface CapabilityVerdict {
  ok: boolean;
  /** Tier-B sentence stating what is missing or unknown; empty when ok. */
  reason: string;
}

export function requireSelector(caps: ChainCapabilities | null, selector: `0x${string}`, name: string): CapabilityVerdict {
  if (!caps || caps.routedSelectors === null) {
    return { ok: false, reason: `Still checking whether this deployment supports ${name}.` };
  }
  if (!caps.routedSelectors.has(selector)) {
    return { ok: false, reason: `This deployment does not route ${name}.` };
  }
  return { ok: true, reason: '' };
}
