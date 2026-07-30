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
  verifyChainIdentity,
  type ChainTarget,
  type CoverageGap,
} from './chains';
import type { Config, Env } from './env';
import { classify, describeFailure, PreclassifiedFailure } from './errors';
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
interface LocalRead {
  ledger: RawLocalLedger;
  /**
   * Gaps produced by the OPTIONAL views — empty when everything read.
   *
   * Returned rather than swallowed (#1448 r3): an optional read that fails
   * silently lets the tick certify the mesh healthy while several CRITICAL
   * checks did not run at all, which is the one outcome a watcher must never
   * produce. Making it part of the return type means a future optional read
   * cannot be added without deciding what its absence costs.
   */
  gaps: CoverageGap[];
}

/**
 * Build the gap for an unreadable composition view.
 *
 * Exported so it can be tested directly: `readLocalLedger` does I/O, so the
 * catch branch is otherwise unreachable from a unit test — which is exactly
 * how the missing gap survived review (#1448 r3).
 */
export function compositionUnavailableGap(
  chainId: number,
  err: unknown,
): CoverageGap {
  const failure = classify(err, 'getRecycleCompositionPosition');
  return {
    chainId,
    reason: 'view-unavailable',
    source: 'own-ledger-composition',
    detail:
      `getRecycleCompositionPosition() could not be read on chain ${chainId} — ${describeFailure(failure)}.\n\n` +
      `Most likely a chain missed during a facet refresh. For this chain THIS TICK: bucket composition, the reported-cumulative derivation and the canonical-role cross-check did NOT run, and bucket coverage fell back to the pre-#1444 rule (strict on a mirror; not evaluated on the canonical chain, where a released remittance legitimately produces a shortfall and the figure that would explain it is the one missing).`,
  };
}

async function readLocalLedger(target: ChainTarget): Promise<LocalRead> {
  const viewGaps: CoverageGap[] = [];
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

  // #1444 / #1446 — the raw slots, read SEPARATELY from the three above and
  // at the same pinned block.
  //
  // Separate because this is a NEWER facet selector (#1448 r2): a chain
  // missed during a facet refresh answers the other three and reverts this
  // one. Inside the `Promise.all` that single revert rejected the whole local
  // read, so `observeMesh` discarded the custody, retirement and governor
  // evidence it had successfully fetched — turning several working CRITICAL
  // checks into one non-paging coverage gap. Its absence must cost only the
  // checks that need it.
  //
  // Same pinned block is still load-bearing: both new checks compare a raw
  // counter against the derived figures, so a mixed-block tuple would show a
  // mid-transaction state as a violation.
  let composition:
    | {
        creditedRaw: bigint;
        releasedRemitStranded: bigint;
        accountingSeeded: boolean;
        isCanonicalRewardChain: boolean;
      }
    | undefined;
  try {
    const c = await readView<readonly [bigint, bigint, boolean, boolean]>(
      target.client,
      target.diamond,
      'getRecycleCompositionPosition',
      [],
      blockNumber,
    );
    composition = {
      creditedRaw: c[0],
      releasedRemitStranded: c[1],
      accountingSeeded: c[2],
      isCanonicalRewardChain: c[3],
    };
  } catch (err) {
    composition = undefined;
    viewGaps.push(compositionUnavailableGap(target.chainId, err));
  }

  return {
    ledger: {
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
    composition,
    observedAt: block.timestamp,
    },
    gaps: viewGaps,
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
  // #1445 — and it must be the chain we think it is. Issued CONCURRENTLY
  // with the head read: verification costs one request but no extra round
  // trip, which is what makes it affordable on every tick.
  //
  // A canonical mismatch is FATAL, not a coverage gap. Every Base-side
  // figure in this tick — the expected chain set, each chain's books, the
  // whole composition position — is read from this client, so a wrong
  // canonical does not degrade the tick, it invalidates it. Treating it
  // as a gap would let the mirror-side checks run and report against
  // books from an unrelated network.
  // `allSettled`, not `all` (#1464 r2). With `all`, a wrong-network
  // canonical endpoint that answers `eth_chainId` but whose concurrent
  // `getBlock` rejects loses the FULFILLED mismatch verdict entirely, and
  // the operator gets only the generic head-read failure — both chain ids
  // and the `RPC_<id>` instruction gone. That is the same loss the mirror
  // path was just fixed for, surviving on the canonical path: the fix has
  // to be applied to both or the distinction only half exists.
  //
  // A partial failure like that is the LIKELY shape, not an exotic one: an
  // endpoint pointed at the wrong network is often also a different
  // provider, tier or auth setup, so one call succeeding while another
  // fails is unremarkable.
  const [headResult, identityResult] = await Promise.allSettled([
    canonical.client.getBlock(),
    verifyChainIdentity(canonical, 'base-books'),
  ]);

  // Identity FIRST, and deliberately before the head failure: a
  // wrong-network canonical explains any read anomaly, so it is the
  // actionable diagnosis. Reporting the head error first would send the
  // operator to the provider for a fault that is not there.
  const canonicalIdentity =
    identityResult.status === 'fulfilled' ? identityResult.value : null;
  if (canonicalIdentity) {
    // PRE-CLASSIFIED, not a bare Error (#1464 r1). `runTick` passes what
    // it catches through `classify`, which substring-matches the message —
    // and this detail contains "WRONG NETWORK", so the `network` marker
    // matched and the operator was told "the endpoint could not be
    // reached", losing both chain ids and the name of the secret to fix.
    // The whole configuration-fault-vs-reachability distinction this
    // change introduces was being erased on exactly the path where it
    // matters most.
    throw new PreclassifiedFailure({
      kind: 'config',
      summary: makeBaseRedactor(env)(canonicalIdentity.detail),
    });
  }
  if (headResult.status === 'rejected') {
    // Identity was fine (or itself unreadable) and the head read failed:
    // the ordinary unreachable-canonical case. Classified rather than
    // forwarded, since viem puts the provider URL — and its API key — in
    // the message.
    throw new PreclassifiedFailure(
      classify(
        headResult.reason,
        `canonical head read on chain ${config.canonicalChainId}`,
      ),
    );
  }
  const canonicalHead = headResult.value;
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
      // #1445 — identity is verified CONCURRENTLY with the ledger read,
      // not before it (#1464 r2). Awaiting it first added a serialized
      // round trip to every mirror on every tick and lengthened the
      // critical path by the slowest mirror's latency — while the comment
      // and README claimed no extra round trip, which made the claim
      // false for the path it was written about.
      //
      // Skipped for the canonical chain, already verified fatally above;
      // re-checking would spend a request to re-learn the same answer.
      const identityPromise =
        id === canonical.chainId
          ? Promise.resolve(null)
          : verifyChainIdentity(target, 'own-ledger');

      // `allSettled`, so a ledger read that throws cannot discard the
      // identity verdict. Order matters below: a wrong-network endpoint
      // EXPLAINS a failed or nonsense read, so the mismatch is the more
      // useful diagnosis and is reported in preference to `no-rpc`.
      const [identityResult, localResult] = await Promise.allSettled([
        identityPromise,
        readLocalLedger(target),
      ]);

      const identity =
        identityResult.status === 'fulfilled' ? identityResult.value : null;
      if (identity) {
        // Treated exactly like the freshness gate below: gap, and excluded
        // from `allLocals` as well as `freshLocals`. A wrong-network ledger
        // is not merely unusable for cross-chain comparison — it would be
        // compared against Base as if it were this chain and produce a
        // false CRITICAL, the worst output this Worker has.
        gaps.push(identity);
        return;
      }
      if (localResult.status === 'rejected') {
        // REDACT: viem puts the request URL in its error messages, and
        // provider URLs carry the API key in the path or query. This
        // string ends up in a Telegram alert (Codex #1443 r4).
        gaps.push({
          chainId: id,
          reason: 'no-rpc',
          source: 'own-ledger',
          detail: describeFailure(
            classify(localResult.reason, `own-ledger read on chain ${id}`),
          ),
        });
        return;
      }
      try {
        const { ledger, gaps: viewGaps } = localResult.value;
        // BEFORE the stale-head early return below, or a chain that is BOTH
        // stale and missing the composition view would lose this gap
        // entirely (#1448 r3).
        gaps.push(...viewGaps);
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
        // The READ's own rejection is handled above, by the `allSettled`
        // branch. What can still reach here is the post-read processing:
        // the freshness validation and the map writes. Kept as a net
        // rather than deleted — a throw from here would otherwise abort
        // this chain's closure silently and leave it out of the tick with
        // no gap at all, which is the one outcome this Worker must never
        // produce — but the CONTEXT no longer says "read", because a
        // mislabelled gap sends an operator to the RPC provider for a
        // fault that is not there (#1464 r2).
        //
        // REDACT regardless: viem's messages carry the request URL and
        // provider URLs carry the API key, and this string reaches a
        // Telegram alert (Codex #1443 r4).
        gaps.push({
          chainId: id,
          reason: 'no-rpc',
          source: 'own-ledger',
          detail: describeFailure(
            classify(err, `own-ledger snapshot processing on chain ${id}`),
          ),
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
