/**
 * Per-chain deployment artifacts for the hf-watcher Worker.
 *
 * Mirrors the frontend's `frontend/src/contracts/deployments.ts`
 * pattern: a single consolidated `deployments.json` keyed by
 * `chainId`, generated from the canonical
 * `contracts/deployments/<chain-slug>/addresses.json` files via
 * `contracts/script/exportFrontendDeployments.sh`. Both consumers
 * read the same merged shape; only the import path differs.
 *
 * Replaces the previous per-chain `env.DIAMOND_ADDR_BASE` /
 * `env.DIAMOND_ADDR_ETH` / etc. wrangler `vars` entries — those were
 * empty placeholders that operators had to hand-fill on every
 * redeploy. The watcher now picks up live addresses on the next
 * `wrangler deploy` after the export script runs.
 *
 * Chains absent from the JSON (because
 * `contracts/deployments/<slug>/` doesn't exist yet) simply return
 * `undefined` from `getDeployment`. `getChainConfigs` filters those
 * out automatically.
 */
import deploymentsJson from './deployments.json';

type HexAddress = `0x${string}`;

/** Subset of the Diamond's facet addresses the watcher reads at
 *  runtime. Only `riskFacet` is consulted today (HF reads); the
 *  others are kept on the type so adding a future read path doesn't
 *  drift the shape. */
export interface DeploymentFacets {
  riskFacet?: HexAddress;
  metricsFacet?: HexAddress;
  loanFacet?: HexAddress;
  // Other facets are present in the JSON but unused by the watcher.
}

/** Per-chain deployment record. Required fields are present on
 *  every chain Vaipakam ships to. Optional fields are scoped — see
 *  the frontend's `Deployment` type for the canonical schema. */
export interface Deployment {
  chainId: number;
  chainSlug: string;
  diamond: HexAddress;
  deployBlock: number;
  escrowImpl: HexAddress;
  treasury: HexAddress;
  admin: HexAddress;
  facets: DeploymentFacets;
  lzEndpoint?: HexAddress;
  lzEid?: number;
  isCanonicalVPFI?: boolean;
  isCanonicalReward?: boolean;
}

const raw = deploymentsJson as Record<string, Deployment>;

export const DEPLOYMENTS: Readonly<Record<number, Deployment>> = Object.freeze(
  Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [Number(k), v]),
  ),
);

/** Returns the deployment record for a chain, or `undefined` if no
 *  `addresses.json` exists for that chain in the merged JSON.
 *  Callers can use this directly or via the `chainId`-keyed
 *  `getChainConfigs` helper in `env.ts`. */
export function getDeployment(
  chainId: number | null | undefined,
): Deployment | undefined {
  if (chainId == null) return undefined;
  return DEPLOYMENTS[chainId];
}
