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
import { classify, describeFailure } from './errors';
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
  /**
   * `view-unavailable` (#1448 r3) means the chain ANSWERED but one
   * selector did not exist — a chain missed during a facet refresh. It is
   * deliberately distinct from `no-rpc`: the chain is reachable and most
   * checks still ran, so collapsing the two would both misdescribe the
   * failure and collide on the dedup key.
   */
  /**
   * `chain-mismatch` (#1445) means the endpoint answered `eth_chainId`
   * with a DIFFERENT chain than the secret is named for. Distinct from
   * `no-rpc` on purpose: the endpoint is perfectly reachable, so every
   * reachability remedy is the wrong one — this is a configuration
   * fault, and the fix is the secret, not the provider.
   */
  reason:
    | 'no-deployment'
    | 'no-rpc'
    | 'stale-head'
    | 'view-unavailable'
    | 'chain-mismatch';
  /**
   * Which read produced the gap.
   *
   * One chain can fail BOTH its Base-side book read and its own-ledger
   * read in a tick, and both are `no-rpc` — so the reason alone still
   * collided on one dedup key, sending one detail twice and discarding
   * the other (Codex #1443 r7).
   */
  source: 'config' | 'base-books' | 'own-ledger' | 'own-ledger-composition';
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
      source: 'config',
      detail: `no stanza for chain ${chainId} in packages/contracts/src/deployments.json — run contracts/script/exportFrontendDeployments.sh after the deploy`,
    };
  }

  const rpc = rpcFor(env, chainId);
  if (!rpc) {
    return {
      chainId,
      reason: 'no-rpc',
      source: 'config',
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

/**
 * Confirm the endpoint behind a target really is the chain it is
 * configured as (#1445).
 *
 * `resolveChain` pairs an `RPC_<chainId>` secret with the committed
 * deployment row for that same id, and until now nothing checked that
 * the endpoint agreed. A secret pointing at the wrong network — a
 * copy-paste at setup, or a stale value after a chain migration — was
 * therefore adopted silently, and every figure read through it was
 * LABELLED with the configured id. The dangerous case is not the noisy
 * one: if the Diamond address happens to carry compatible code on the
 * wrong network, every invariant is evaluated against the wrong chain's
 * ledger and the watcher reports a clean tick. Confident silence is the
 * worst output a watcher has, and it is the one this prevents.
 *
 * Deliberately its own step rather than a check inside `resolveChain`:
 * resolution is pure and synchronous (config in, target out). Both callers
 * issue this CONCURRENTLY with a read they already make — the canonical
 * head read, and each mirror's own ledger read — so verification costs one
 * request but no extra round trip. That concurrency is load-bearing, not
 * incidental: awaiting it first serialises an extra round trip onto every
 * mirror on every tick and lengthens the critical path by the slowest
 * mirror's latency (#1464 r2, where the mirror path did exactly that while
 * the docs claimed otherwise).
 *
 * @returns `null` when the endpoint confirms the expected id, else a
 *          `CoverageGap` naming BOTH ids. Never throws — an endpoint
 *          that cannot answer `eth_chainId` is reported as the ordinary
 *          reachability gap, since that is what it is.
 */
export async function verifyChainIdentity(
  target: ChainTarget,
  source: CoverageGap['source'],
): Promise<CoverageGap | null> {
  let observed: number;
  try {
    observed = await target.client.getChainId();
  } catch (err) {
    return {
      chainId: target.chainId,
      reason: 'no-rpc',
      source,
      // CLASSIFIED, never forwarded: viem puts the request URL in its
      // error text and provider URLs carry the API key.
      detail: describeFailure(
        classify(err, `eth_chainId on chain ${target.chainId}`),
      ),
    };
  }
  if (observed === target.chainId) return null;
  return {
    chainId: target.chainId,
    reason: 'chain-mismatch',
    source,
    detail:
      `RPC_${target.chainId} points at the WRONG NETWORK — the endpoint reports chain ${observed}, ` +
      `but it is configured as chain ${target.chainId} (${target.slug}). Every read through it would ` +
      `have been labelled ${target.chainId}, so this chain is excluded from the tick rather than ` +
      `compared against Base. Fix the RPC_${target.chainId} secret; the endpoint itself is reachable.`,
  };
}

/** Narrowing helper — `resolveChain` returns a union. */
export function isCoverageGap(
  value: ChainTarget | CoverageGap,
): value is CoverageGap {
  return 'reason' in value;
}
