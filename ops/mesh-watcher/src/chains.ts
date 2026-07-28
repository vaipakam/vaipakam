/**
 * Chain resolution: EVM chain id → Diamond address + RPC transport.
 *
 * Addresses come from the committed `deployments.json` — the same
 * consolidated artifact every other consumer in the monorepo reads
 * (CLAUDE.md, "Deployments sync"). Re-declaring them in `wrangler.jsonc`
 * vars would give this Worker its own copy to drift; `ops/lz-watcher`
 * only did that because the LayerZero endpoint/library addresses it
 * watched genuinely are not deployment artifacts.
 *
 * The chain SET, by contrast, is not configured anywhere in this Worker:
 * it is read from the canonical Diamond's `getExpectedSourceChainIds()`.
 * A mirror wired on-chain is therefore watched as soon as it is wired —
 * the only operator step is the RPC secret, whose absence is reported as
 * a coverage gap rather than silently skipping the chain.
 */

import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import deployments from '../../../packages/contracts/src/deployments.json';
import { rpcFor, type Env } from './env';

interface DeploymentRow {
  chainId: number;
  chainSlug: string;
  diamond: string;
}

const ROWS = deployments as unknown as Record<string, DeploymentRow>;

export interface ChainTarget {
  chainId: number;
  slug: string;
  diamond: Address;
  client: PublicClient;
}

/** Why a chain in the expected set could not be read this tick. */
export interface CoverageGap {
  chainId: number;
  reason: 'no-deployment' | 'no-rpc';
  detail: string;
}

/**
 * Look up a chain's committed deployment row.
 *
 * @returns The row, or `null` when `deployments.json` carries no stanza
 *          for that chain — which for a chain the canonical Diamond
 *          already expects reports from means the deployments sync was
 *          skipped after wiring it.
 */
export function deploymentFor(chainId: number): DeploymentRow | null {
  return ROWS[String(chainId)] ?? null;
}

/**
 * Build the read target for `chainId`.
 *
 * @returns A `ChainTarget`, or a `CoverageGap` explaining which of the
 *          two operator-side prerequisites (committed deployment / RPC
 *          secret) is missing. Never throws — one unreachable mirror must
 *          not abort the whole tick, or a single missing secret would
 *          blind the watcher to every other chain's invariants.
 */
export function resolveChain(
  env: Env,
  chainId: number,
): ChainTarget | CoverageGap {
  const row = deploymentFor(chainId);
  if (!row) {
    return {
      chainId,
      reason: 'no-deployment',
      detail: `no stanza for chain ${chainId} in packages/contracts/src/deployments.json — run contracts/script/exportFrontendDeployments.sh after the deploy`,
    };
  }

  const rpc = rpcFor(env, chainId);
  if (!rpc) {
    return {
      chainId,
      reason: 'no-rpc',
      detail: `no RPC_${chainId} secret configured (chain ${row.chainSlug})`,
    };
  }

  return {
    chainId,
    slug: row.chainSlug,
    diamond: row.diamond as Address,
    client: createPublicClient({ transport: http(rpc) }),
  };
}

/** Narrowing helper — `resolveChain` returns a union. */
export function isCoverageGap(
  value: ChainTarget | CoverageGap,
): value is CoverageGap {
  return 'reason' in value;
}
