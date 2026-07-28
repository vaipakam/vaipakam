/**
 * One tick's reads: Base's per-chain books, plus every reachable chain's
 * own ledger.
 *
 * The chain set comes from the canonical Diamond, not from config — see
 * `chains.ts`. Chains that cannot be reached become coverage gaps rather
 * than being dropped: a watcher that silently narrows its scope reports
 * "all clear" for chains it never looked at.
 */

import type { Address, PublicClient } from 'viem';
import { REWARD_AGGREGATOR_ABI } from './abi';
import {
  isCoverageGap,
  resolveChain,
  type ChainTarget,
  type CoverageGap,
} from './chains';
import type { Config, Env } from './env';
import type {
  BaseChainBooks,
  LocalLedger,
  MeshObservation,
} from './invariants';

/**
 * Read a view whose decode shape `assertAbiShape` has already verified.
 *
 * The cast is what that assertion buys: the compiled ABI drives the
 * decode (so field ORDER is authoritative), and the startup check has
 * confirmed the arity and types this call site assumes.
 */
async function readView<T>(
  client: PublicClient,
  address: Address,
  functionName: string,
  args: readonly unknown[] = [],
  blockNumber?: bigint,
): Promise<T> {
  const result = await client.readContract({
    address,
    abi: REWARD_AGGREGATOR_ABI,
    functionName,
    args: args as never,
    // Pin to ONE block when the caller supplies it. Related ledger fields
    // are written atomically on-chain but read over several RPC calls, so
    // an unpinned read can straddle a funding or retirement transaction
    // and observe, say, an old `consumed` beside a newly-incremented
    // `outstanding` — paging a `commit-identity` violation that never
    // existed (Codex #1443 r1). A false CRITICAL is the worst outcome
    // this Worker can produce, so every related read shares a block.
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return result as T;
}

/** Base's books for one chain — three views, read together. */
async function readBaseBooks(
  canonical: ChainTarget,
  chainId: number,
  blockNumber: bigint,
): Promise<BaseChainBooks> {
  const [ledger, retirement, outstanding] = await Promise.all([
    readView<readonly [bigint, bigint, bigint, bigint]>(
      canonical.client,
      canonical.diamond,
      'getChainRecycledLedger',
      [chainId],
      blockNumber,
    ),
    readView<readonly [bigint, bigint]>(
      canonical.client,
      canonical.diamond,
      'getChainRecycledCommitRetirement',
      [chainId],
      blockNumber,
    ),
    readView<bigint>(
      canonical.client,
      canonical.diamond,
      'getChainOutstandingRecycledCommit',
      [chainId],
      blockNumber,
    ),
  ]);

  return {
    chainId,
    reported: ledger[0],
    consumed: ledger[1],
    avail: ledger[2],
    attributed: ledger[3],
    retired: retirement[0],
    released: retirement[1],
    outstanding,
  };
}

/** A chain's own ledger — read against that chain's own Diamond. */
async function readLocalLedger(target: ChainTarget): Promise<LocalLedger> {
  // One block for this chain's whole tuple, for the same reason as the
  // Base-side reads: bucket coverage compares a balance against a
  // reservation that a single claim moves together.
  const blockNumber = await target.client.getBlockNumber();
  const [custody, retirement, governor] = await Promise.all([
    readView<readonly [bigint, bigint, bigint]>(
      target.client,
      target.diamond,
      'getRecycleCustodyPosition',
      [],
      blockNumber,
    ),
    readView<readonly [bigint, bigint]>(
      target.client,
      target.diamond,
      'getLocalRecycledCommitRetirement',
      [],
      blockNumber,
    ),
    readView<readonly [bigint, bigint, bigint, bigint]>(
      target.client,
      target.diamond,
      'getGovernorCommitState',
      [],
      blockNumber,
    ),
  ]);

  return {
    chainId: target.chainId,
    custodyRelocated: custody[0],
    bucket: custody[1],
    reportedCumulative: custody[2],
    localRetired: retirement[0],
    localReleased: retirement[1],
    armedFromDay: governor[0],
    outstandingFresh: governor[1],
    outstandingRecycled: governor[2],
    paidOutRecycled: governor[3],
  };
}

/**
 * Collect one tick's observation.
 *
 * @throws When the canonical chain itself cannot be resolved or read —
 *         there is no partial answer worth reporting in that case, and
 *         the caller turns it into an infrastructure alert.
 */
export async function observeMesh(
  env: Env,
  config: Config,
): Promise<MeshObservation> {
  const canonical = resolveChain(env, config.canonicalChainId);
  if (isCoverageGap(canonical)) {
    throw new Error(
      `canonical chain ${config.canonicalChainId} unreadable: ${canonical.detail}`,
    );
  }

  // Every Base-side read this tick shares one block, so the per-chain
  // books cannot straddle a transaction that updates them together.
  const canonicalBlock = await canonical.client.getBlockNumber();

  const expected = await readView<readonly number[]>(
    canonical.client,
    canonical.diamond,
    'getExpectedSourceChainIds',
    [],
    canonicalBlock,
  );

  const gaps: CoverageGap[] = [];
  if (expected.length === 0) {
    // Either this is not the canonical reward chain, or the mesh source
    // set was never configured. Both make every per-chain check below
    // vacuous, so say so rather than reporting a clean tick.
    gaps.push({
      chainId: config.canonicalChainId,
      reason: 'no-deployment',
      detail: `getExpectedSourceChainIds() is empty on the configured canonical Diamond (${canonical.diamond} on chain ${config.canonicalChainId}) — the mesh source set is unconfigured, or CANONICAL_CHAIN_ID points at a mirror`,
    });
  }

  // Base's own chain id is included on purpose: its per-chain books must
  // be inert, and `base-self-inert` is the check that proves it.
  const chainIds = [
    ...new Set<number>([config.canonicalChainId, ...expected.map(Number)]),
  ];

  const books = await Promise.all(
    chainIds.map((id) => readBaseBooks(canonical, id, canonicalBlock)),
  );

  const locals = new Map<number, LocalLedger>();
  await Promise.all(
    chainIds.map(async (id) => {
      const target = id === canonical.chainId ? canonical : resolveChain(env, id);
      if (isCoverageGap(target)) {
        gaps.push(target);
        return;
      }
      try {
        locals.set(id, await readLocalLedger(target));
      } catch (err) {
        gaps.push({
          chainId: id,
          reason: 'no-rpc',
          detail: `own-ledger read failed on chain ${id}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),
  );

  return {
    canonicalChainId: config.canonicalChainId,
    books,
    locals,
    gaps,
  };
}
