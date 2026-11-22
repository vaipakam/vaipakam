/**
 * What the pass knows about a network (#3919): its mode, read from the node
 * capability check's committed result (#3913, ops/node-capability/results),
 * and the contracts it watches, read from the deployment record.
 */
import { getDeployment } from '@vaipakam/contracts/deployments';
import { watchedAddresses } from '@vaipakam/lib/watchedContracts';
import type { PassMode } from './record';

/** The capability check's committed result, the fields the pass reads. */
export interface CapabilityResult {
  chainId: number;
  network: string;
  blockTimeSeconds: number;
  failedTransactionMode: 'trace-filter' | 'block-scan' | 'explorer-and-audit';
  capabilities: { traceFilter?: { answered?: boolean; largestRange?: number | null } };
}

export interface ChainPlan {
  chainId: number;
  slug: string;
  mode: PassMode;
  blockTimeSeconds: number;
  /** Blocks one trace filter request may span (trace-filter mode). */
  traceFilterRange: number;
  /** Every contract in the deployment record, lowercase. */
  watched: string[];
  /** The contracts users call directly, read every run; the rest hourly. */
  direct: string[];
  deployBlock: number;
  /** The Diamond this plan scans under, lowercase; named on every call to the indexer. */
  diamond: string;
}

/** The contracts users call directly (§4.3): read every few minutes. */
const DIRECT_KEYS = ['diamond', 'positionNFT', 'vpfiToken'];

/** The deployment record's contracts, by the shared rule (`@vaipakam/lib/watchedContracts`). */
export { watchedAddresses };

/**
 * The pass's plan for a network. `explorerConfigured` decides list-and-audit
 * against sends-and-audit where the capability check chose the explorer: with
 * no key the list cannot be read, and the health route then states the
 * watched share of the day instead.
 */
export function planFor(cap: CapabilityResult, explorerConfigured: boolean): ChainPlan {
  const dep = getDeployment(cap.chainId) as unknown as Record<string, unknown> | undefined;
  if (!dep) throw new Error(`chain ${cap.chainId} has no deployment record`);
  const watched = watchedAddresses(dep);
  const direct = DIRECT_KEYS.map((k) => dep[k]).filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase());
  let mode: PassMode;
  switch (cap.failedTransactionMode) {
    case 'trace-filter':
      mode = 'trace-filter';
      break;
    case 'explorer-and-audit':
      mode = explorerConfigured ? 'list-and-audit' : 'sends-and-audit';
      break;
    case 'block-scan':
      // No network's measured cost puts it inside the bound today, so the
      // continuous scan is not built. A result that selects it is refused
      // by name rather than run as something else.
      throw new Error(`chain ${cap.chainId}: the capability check selects block-scan, which this pass does not run yet`);
    default:
      throw new Error(`chain ${cap.chainId}: unknown mode ${String(cap.failedTransactionMode)}`);
  }
  const range = cap.capabilities.traceFilter?.largestRange;
  if (mode === 'trace-filter' && !(typeof range === 'number' && range > 0)) {
    throw new Error(`chain ${cap.chainId}: trace-filter mode but the capability check states no usable range`);
  }
  return {
    chainId: cap.chainId,
    slug: cap.network,
    mode,
    blockTimeSeconds: cap.blockTimeSeconds,
    traceFilterRange: typeof range === 'number' && range > 0 ? range : 0,
    watched,
    direct: direct.filter((a) => watched.includes(a)),
    deployBlock: typeof dep.deployBlock === 'number' ? dep.deployBlock : 0,
    diamond: String(dep.diamond).toLowerCase(),
  };
}
