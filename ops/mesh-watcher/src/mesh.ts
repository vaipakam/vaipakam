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
import { classify, describeFailure } from './errors';
import { makeBaseRedactor } from './redact';
import {
  asFreshSnapshot,
  type BaseChainBooks,
  type FRESH,
  type LocalLedger,
  type MeshObservation,
} from './invariants';

/** A local read before the freshness check has vouched for it. */
type RawLocalLedger = Omit<LocalLedger, FRESH>;

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
async function readLocalLedger(target: ChainTarget): Promise<RawLocalLedger> {
  // One block for this chain's whole tuple, for the same reason as the
  // Base-side reads: bucket coverage compares a balance against a
  // reservation that a single claim moves together.
  const block = await target.client.getBlock();
  const blockNumber = block.number;
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
    // The freshness brand is applied by `observeMesh` after validation —
    // this raw read is not yet known to be comparable against Base.
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
    observedAt: block.timestamp,
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
      makeBaseRedactor(env)(
        `canonical chain ${config.canonicalChainId} unreadable: ${canonical.detail}`,
      ),
    );
  }

  // Every Base-side read this tick shares one block, so the per-chain
  // books cannot straddle a transaction that updates them together.
  //
  // And that block must be RECENT. A canonical RPC stuck on an old head
  // answers every call happily, so the watcher would read stale Base
  // books — and a Base that merely trails the mirrors is not a hard
  // violation, so nothing else would notice. It could then report
  // `ok: true` while blind to a new accounting violation or a
  // newly-wired chain (#1443 r9).
  const canonicalHead = await canonical.client.getBlock();
  const canonicalBlock = canonicalHead.number;
  const wallClockSeconds = Math.floor(Date.now() / 1000);
  const canonicalAge = wallClockSeconds - Number(canonicalHead.timestamp);

  const expected = await readView<readonly number[]>(
    canonical.client,
    canonical.diamond,
    'getExpectedSourceChainIds',
    [],
    canonicalBlock,
  );

  const gaps: CoverageGap[] = [];
  if (canonicalAge > config.staleLocalSeconds) {
    gaps.push({
      chainId: config.canonicalChainId,
      reason: 'stale-head',
      source: 'base-books',
      detail: `the CANONICAL chain is serving a stale head — its latest block is ${canonicalAge}s old (limit ${config.staleLocalSeconds}s). Every Base-side figure below was read from that block, so newly-introduced violations and newly-wired chains may not be visible yet.`,
    });
  }
  if (expected.length === 0) {
    // Either this is not the canonical reward chain, or the mesh source
    // set was never configured. Both make every per-chain check below
    // vacuous, so say so rather than reporting a clean tick.
    gaps.push({
      chainId: config.canonicalChainId,
      reason: 'no-deployment',
      source: 'config',
      detail: `getExpectedSourceChainIds() is empty on the configured canonical Diamond (${canonical.diamond} on chain ${config.canonicalChainId}) — the mesh source set is unconfigured, or CANONICAL_CHAIN_ID points at a mirror`,
    });
  }

  // The canonical chain must itself be IN the expected set — `finalizeDay`
  // sums the global denominators over exactly that list, so a canonical id
  // missing from it silently drops Base's own activity out of every day's
  // totals. Injecting it unconditionally for the reads below would make
  // the watcher look like it covers Base while masking precisely that
  // misconfiguration (Codex #1443 r3), so say so first, then inject.
  if (expected.length > 0 && !expected.map(Number).includes(config.canonicalChainId)) {
    gaps.push({
      chainId: config.canonicalChainId,
      reason: 'no-deployment',
      source: 'config',
      detail: `the canonical chain ${config.canonicalChainId} is NOT in getExpectedSourceChainIds() — finalizeDay sums the global denominators over that list, so Base's own activity is being dropped from every day's totals. Its books are still read below, but the on-chain source set needs fixing.`,
    });
  }

  // Base's own chain id is included on purpose: its per-chain books must
  // be inert, and `base-self-inert` is the check that proves it.
  const chainIds = [
    ...new Set<number>([config.canonicalChainId, ...expected.map(Number)]),
  ];

  // allSettled, not all: one chain's transient RPC error or revert would
  // otherwise discard every SUCCESSFUL chain's books and abort the whole
  // observation, so hard violations already readable elsewhere went
  // unevaluated and undelivered (Codex #1443 r6). A rejected chain
  // becomes a coverage gap; the rest are still checked.
  const bookResults = await Promise.allSettled(
    chainIds.map((id) => readBaseBooks(canonical, id, canonicalBlock)),
  );
  const books: BaseChainBooks[] = [];
  bookResults.forEach((result, i) => {
    const id = chainIds[i]!;
    if (result.status === 'fulfilled') {
      books.push(result.value);
      return;
    }
    gaps.push({
      chainId: id,
      reason: 'no-rpc',
      source: 'base-books',
      // CLASSIFIED, never forwarded — the classification boundary has to
      // hold here too, or a credential in an encoding the redactor does
      // not know still reaches the alert (#1443 r9).
      detail: describeFailure(classify(result.reason, `Base-side books for chain ${id}`)),
    });
  });

  const freshLocals = new Map<number, LocalLedger>();
  const allLocals = new Map<number, Omit<LocalLedger, FRESH>>();
  await Promise.all(
    chainIds.map(async (id) => {
      const target = id === canonical.chainId ? canonical : resolveChain(env, id);
      if (isCoverageGap(target)) {
        gaps.push(target);
        return;
      }
      try {
        const ledger = await readLocalLedger(target);
        // FRESHNESS GATE. A mirror RPC serving a stale head makes Base
        // legitimately ahead of what we just read, and
        // `base-ahead-of-chain` would report that as ledger corruption —
        // a false CRITICAL, the worst thing this Worker can emit (Codex
        // #1443 r6). Too-stale snapshots are treated exactly like an
        // unreadable chain: surfaced as a coverage gap, and excluded from
        // every cross-chain comparison. Base-side checks still run.
        // Retained regardless of age: same-chain checks (bucket
        // coverage) compare figures from ONE pinned block and stay valid
        // however old it is.
        allLocals.set(id, ledger);
        const verdict = asFreshSnapshot(
          ledger,
          wallClockSeconds,
          config.staleLocalSeconds,
        );
        if ('stale' in verdict) {
          gaps.push({
            chainId: id,
            reason: 'stale-head',
            source: 'own-ledger',
            detail: `chain ${id} is serving a stale head — its latest block is ${verdict.ageSeconds}s old (limit ${config.staleLocalSeconds}s), so Base can legitimately hold newer figures than this snapshot. CROSS-CHAIN comparisons for this chain are skipped this tick; same-chain checks still run.`,
          });
          return;
        }
        freshLocals.set(id, verdict.fresh);
      } catch (err) {
        // REDACT: viem puts the request URL in its error messages, and
        // provider URLs carry the API key in the path or query. This
        // string ends up in a Telegram alert (Codex #1443 r4).
        gaps.push({
          chainId: id,
          reason: 'no-rpc',
          source: 'own-ledger',
          detail: describeFailure(classify(err, `own-ledger read on chain ${id}`)),
        });
      }
    }),
  );

  return {
    canonicalChainId: config.canonicalChainId,
    expectedChainIds: chainIds,
    books,
    freshLocals,
    allLocals,
    gaps,
  };
}
