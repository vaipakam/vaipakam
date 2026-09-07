#!/usr/bin/env node
/**
 * #1566 — GRANDFATHERED-CUSTODY CENSUS (read-only).
 *
 * Slices 0–3 of `Vpfi1566CanonicalDeliveredBoundDesign.md` exist only to move
 * four GRANDFATHERED custody classes out of commingled Diamond custody. The
 * path that creates `vpfiHeld` was retired by #1352, and the FunctionalSpecs
 * state that a platform deployed fresh has no such loans — so how much of that
 * migration is real work is an EMPIRICAL question with a cheap answer.
 *
 * The owner ratified (2026-09-07) that this census runs BEFORE any migration
 * machinery is written. Its output decides scope:
 *
 *   - every class empty on every deployed chain  → slices 0–3 collapse to a
 *     certified no-op, and slice 0's shortfall disposition never reaches the
 *     owner, because there is nothing to be short of;
 *   - any class non-empty                        → that slice is live work, and
 *     the figures here are what carry the owner the shortfall question.
 *
 * WHY A COMMITTED SCRIPT RATHER THAN A ONE-OFF QUERY: "the set was empty" is a
 * claim a later reader must be able to RE-RUN, not trust. The artifact records
 * the chain, the Diamond, the block, and the full loan-id range scanned, so the
 * same census can be reproduced against the same state.
 *
 * WHAT IT READS, AND WHY THAT WAY:
 *   - classes 1 & 4 (`vpfiHeld` custody, rebate rows) — `getBorrowerLifRebate`
 *   - class 2 (fallback snapshot custody)             — `getFallbackSnapshot`
 *   - class 3 (live VPFI intent commits)              — `getIntentCommit`, the
 *     facet's own view. This reads LIVE STATE, which is precisely what the
 *     class is defined as, and both teardown paths `delete s.intentCommits`,
 *     so an absent commit reads as a zero struct. It is history-INDEPENDENT,
 *     which matters: public nodes prune, and an earlier revision of this
 *     census reconstructed the class from the event lifecycle and was left
 *     unable to answer on a pruned endpoint. Hand-computed storage slots were
 *     never an option either — they fail SILENTLY as zero, manufacturing the
 *     exact "empty" answer this census exists to establish.
 *
 *     The event-lifecycle reconstruction is retained behind `--corroborate`
 *     as an INDEPENDENT second source. It pairs commit → teardown by
 *     `(loanId, orderHash)`; a disagreement with the view is reported loudly.
 *
 * Every ABI here comes from the compiled artifacts in `../src/abis` — nothing
 * is hand-typed, so a signature change surfaces as a decode error rather than a
 * wrong number.
 *
 * SCANNING NOTHING IS A HARD ERROR. A census that quietly reads zero loans
 * would report "empty" for every class and look like the good outcome.
 *
 * Usage:
 *   node packages/contracts/scripts/census-grandfathered-custody.mjs \
 *     [--chain base-sepolia|all] [--rpc URL] [--out DIR] [--block N]
 *
 * RPC resolution order: `--rpc`, then `CENSUS_RPC_<SLUG_WITH_UNDERSCORES>`,
 * then `CENSUS_RPC_URL`, then the public default for known testnets.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, toFunctionSelector } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const DEPLOYMENTS = join(REPO, 'contracts/deployments');
const ABIS = join(HERE, '../src/abis');

const PUBLIC_RPC = {
  'base-sepolia': 'https://sepolia.base.org',
  'op-sepolia': 'https://sepolia.optimism.io',
  'arb-sepolia': 'https://sepolia-rollup.arbitrum.io/rpc',
  sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
  'bnb-testnet': 'https://bsc-testnet-rpc.publicnode.com',
};

/** Chains that are local-only fixtures rather than deployed state. */
const NOT_A_DEPLOYMENT = new Set(['anvil']);

const PAGE = 200n;
/**
 * Log-scan tuning. Spans here are large because the ranges are: the intent
 * scan runs from the deploy block to head, which on a fast testnet is tens of
 * millions of blocks (arb-sepolia was ~23.6M at the time of writing). A 10k
 * span walked sequentially is thousands of round trips; a wider span with
 * bounded concurrency turns that into tens. Each window still halves on a
 * provider range error, so a stricter endpoint degrades rather than fails.
 */
const DEFAULT_LOG_SPAN = 50_000n;
const LOG_CONCURRENCY = Number(process.env.CENSUS_LOG_CONCURRENCY ?? 3);
const RATE_LIMIT_RETRIES = 6;

/**
 * Provider failures are not interchangeable, and treating them as one kind is
 * how a census lies. Three behaviours:
 *   - `range`      — the window is too wide. Halve and retry; harmless.
 *   - `rate`       — we are asking too fast. Back off and retry; harmless.
 *   - `pruned`     — the node no longer HAS the history. No amount of retrying
 *                    produces the answer, and reporting "no logs found" here
 *                    would assert emptiness from a node that cannot see.
 */
function classifyRpcError(err) {
  const m = `${err?.details ?? ''} ${err?.shortMessage ?? ''} ${err?.message ?? ''}`.toLowerCase();
  if (/pruned|history has been pruned|missing trie node|state not available|not available on this node/.test(m)) {
    return 'pruned';
  }
  if (/rate limit|429|requests per second|too many requests|capacity/.test(m)) return 'rate';
  if (/range|too large|exceed|more than|limit/.test(m)) return 'range';
  return 'unknown';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/**
 * True only for the `IntentNoCommit` revert — the facet's own signal that no
 * commit is live for that loan. Every other revert propagates: a census must
 * never read an unexpected failure as an absent row.
 */
function isNoCommitRevert(err) {
  const named = err?.cause?.data?.errorName ?? err?.data?.errorName;
  if (named) return named === 'IntentNoCommit';
  return /IntentNoCommit/.test(`${err?.metaMessages?.join(' ') ?? ''} ${err?.shortMessage ?? ''} ${err?.message ?? ''}`);
}
const WANT_CORROBORATION = process.argv.includes('--corroborate');

function loadAbi(name) {
  const raw = JSON.parse(readFileSync(join(ABIS, `${name}.json`), 'utf8'));
  return Array.isArray(raw) ? raw : raw.abi;
}

function pick(abi, names) {
  const want = new Set(names);
  const got = abi.filter((e) => want.has(e.name));
  const missing = names.filter((n) => !got.some((e) => e.name === n));
  if (missing.length) {
    throw new Error(
      `ABI is missing ${missing.join(', ')} — the exported artifact and this census have drifted; ` +
        `re-run contracts/script/exportFrontendAbis.sh`,
    );
  }
  return got;
}

function arg(flag, fallback = undefined) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function rpcFor(slug) {
  const fromFlag = arg('--rpc');
  if (fromFlag) return fromFlag;
  const env = `CENSUS_RPC_${slug.toUpperCase().replace(/-/g, '_')}`;
  return process.env[env] || process.env.CENSUS_RPC_URL || PUBLIC_RPC[slug] || null;
}

function deployedChains() {
  return readdirSync(DEPLOYMENTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NOT_A_DEPLOYMENT.has(d.name))
    .map((d) => d.name)
    .filter((slug) => existsSync(join(DEPLOYMENTS, slug, 'addresses.json')))
    .sort();
}

/**
 * Fetch logs in bounded spans, halving on provider range/size errors.
 * Public RPCs cap `eth_getLogs` ranges, and a silently truncated scan would
 * under-count live commits — i.e. produce a false "empty".
 */
async function fetchRange(client, address, events, fromBlock, toBlock) {
  let span = toBlock - fromBlock + 1n;
  const out = [];
  let cursor = fromBlock;
  let rateRetries = 0;
  while (cursor <= toBlock) {
    const end = cursor + span - 1n > toBlock ? toBlock : cursor + span - 1n;
    try {
      out.push(...(await client.getLogs({ address, events, fromBlock: cursor, toBlock: end })));
      cursor = end + 1n;
      rateRetries = 0;
    } catch (err) {
      const kind = classifyRpcError(err);
      if (kind === 'pruned') throw err; // unanswerable by this endpoint — surface it
      if (kind === 'rate') {
        if (rateRetries >= RATE_LIMIT_RETRIES) throw err;
        await sleep(500 * 2 ** rateRetries++); // 0.5s, 1s, 2s … 16s
        continue;
      }
      if (span === 1n) throw err; // a single block the provider still refuses is a real failure
      span = span / 2n > 0n ? span / 2n : 1n;
    }
  }
  return out;
}

/**
 * Fetch logs over a wide range with bounded concurrency, halving any span the
 * provider refuses. Two correctness notes:
 *
 *  - Public RPCs cap `eth_getLogs`, and a silently truncated scan would
 *    under-count live commits — i.e. produce a false "empty". Every refusal
 *    therefore narrows and retries rather than being swallowed.
 *  - Results are re-sorted by `(blockNumber, logIndex)` before the caller
 *    folds them. The commit → teardown fold is ORDER-DEPENDENT, and neither
 *    concurrent completion nor per-chunk provider ordering can be assumed to
 *    deliver chain order.
 */
async function getLogsChunked(client, { address, events, fromBlock, toBlock }) {
  const windows = [];
  for (let c = fromBlock; c <= toBlock; c += DEFAULT_LOG_SPAN) {
    const end = c + DEFAULT_LOG_SPAN - 1n > toBlock ? toBlock : c + DEFAULT_LOG_SPAN - 1n;
    windows.push([c, end]);
  }

  const out = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(LOG_CONCURRENCY, windows.length || 1) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= windows.length) return;
      const [from, to] = windows[i];
      out.push(...(await fetchRange(client, address, events, from, to)));
    }
  });
  await Promise.all(workers);

  out.sort((x, y) =>
    x.blockNumber === y.blockNumber
      ? Number(x.logIndex) - Number(y.logIndex)
      : x.blockNumber < y.blockNumber
        ? -1
        : 1,
  );
  return out;
}

async function censusChain(slug) {
  const addresses = JSON.parse(readFileSync(join(DEPLOYMENTS, slug, 'addresses.json'), 'utf8'));
  const diamond = addresses.diamond;
  const rpc = rpcFor(slug);
  if (!diamond) throw new Error(`${slug}: addresses.json carries no diamond address`);
  if (!rpc) throw new Error(`${slug}: no RPC — pass --rpc or set CENSUS_RPC_${slug.toUpperCase().replace(/-/g, '_')}`);

  const claim = pick(loadAbi('ClaimFacet'), ['getBorrowerLifRebate', 'getFallbackSnapshot']);
  const metrics = pick(loadAbi('MetricsFacet'), ['getProtocolStats', 'getAllLoansPaginated']);
  // The error entry must travel with the function: `getIntentCommit` REVERTS
  // `IntentNoCommit` when no commit is live, and that revert is the proof of
  // absence. Without the error in the ABI viem cannot name it, and an absent
  // commit would be indistinguishable from a genuine failure.
  const intentView = pick(loadAbi('SwapToRepayIntentFacet'), ['getIntentCommit', 'IntentNoCommit']);
  const loupe = pick(loadAbi('DiamondLoupeFacet'), ['facetAddress']);
  const intentEvents = pick(loadAbi('SwapToRepayIntentFacet'), [
    'SwapToRepayIntentCommitted',
    'SwapToRepayIntentFilled',
    'SwapToRepayIntentCancelled',
    'SwapToRepayIntentForceCancelled',
  ]);

  const client = createPublicClient({ transport: http(rpc) });
  const chainId = await client.getChainId();
  if (addresses.chainId && Number(addresses.chainId) !== Number(chainId)) {
    throw new Error(
      `${slug}: RPC reports chainId ${chainId} but the deployment artifact says ${addresses.chainId} — wrong endpoint`,
    );
  }
  const atBlock = arg('--block') ? BigInt(arg('--block')) : await client.getBlockNumber();

  const read = (functionName, args = []) =>
    client.readContract({
      address: diamond,
      abi: [...claim, ...metrics, ...intentView, ...loupe],
      functionName,
      args,
      blockNumber: atBlock,
    });

  const stats = await read('getProtocolStats');
  const totalLoansEverCreated = stats[3];

  // ── Enumerate every loan id ever created ──────────────────────────────
  const loanIds = [];
  let offset = 0n;
  let reportedTotal = 0n;
  for (;;) {
    const [ids, total] = await read('getAllLoansPaginated', [offset, PAGE]);
    reportedTotal = total;
    loanIds.push(...ids);
    if (ids.length === 0 || BigInt(loanIds.length) >= total) break;
    offset += PAGE;
  }

  if (totalLoansEverCreated > 0n && loanIds.length === 0) {
    throw new Error(
      `${slug}: the chain reports ${totalLoansEverCreated} loans ever created but enumeration returned NONE — ` +
        `refusing to report an empty census from a scan that read nothing`,
    );
  }
  if (BigInt(loanIds.length) !== reportedTotal) {
    throw new Error(
      `${slug}: enumerated ${loanIds.length} loan ids but pagination reports ${reportedTotal} — incomplete scan`,
    );
  }

  // ── Classes 1 & 4 — vpfiHeld custody and rebate rows ──────────────────
  // ── Class 2 — fallback snapshot custody ───────────────────────────────
  // Is the intent surface even ROUTED on this Diamond? Ask the loupe directly
  // rather than inferring it from a `FunctionDoesNotExist` revert. An unrouted
  // surface is a COMPLETE proof of absence for class 3 — no commit can ever
  // have been created through a selector the Diamond does not answer — and it
  // needs no history, so it holds on pruned endpoints too.
  const intentSelector = toFunctionSelector(intentView.find((e) => e.name === 'getIntentCommit'));
  const intentHost = await read('facetAddress', [intentSelector]);
  const intentSurfaceRouted = intentHost && intentHost !== ZERO_ADDRESS;

  const vpfiHeldRows = [];
  const rebateRows = [];
  const fallbackRows = [];
  const intentRows = [];
  for (const id of loanIds) {
    const [rebateAmount, vpfiHeld] = await read('getBorrowerLifRebate', [id]);
    if (vpfiHeld > 0n) vpfiHeldRows.push({ loanId: id.toString(), vpfiHeld: vpfiHeld.toString() });
    if (rebateAmount > 0n) rebateRows.push({ loanId: id.toString(), rebateAmount: rebateAmount.toString() });

    const snap = await read('getFallbackSnapshot', [id]);
    const [lenderCollateral, treasuryCollateral, borrowerCollateral, lenderPrincipalDue, treasuryPrincipalDue, active] =
      snap;
    const custody = lenderCollateral + treasuryCollateral + borrowerCollateral;
    if (active || custody > 0n) {
      fallbackRows.push({
        loanId: id.toString(),
        active,
        collateralTotal: custody.toString(),
        lenderPrincipalDue: lenderPrincipalDue.toString(),
        treasuryPrincipalDue: treasuryPrincipalDue.toString(),
      });
    }

    // Class 3 — live intent commit, read from state. The view reverts
    // `IntentNoCommit` exactly when `commit.orderHash == 0`, and both teardown
    // paths delete the struct — so that revert IS the proof of absence. Any
    // other revert is a real failure and must not be read as "no commit".
    if (!intentSurfaceRouted) continue;
    try {
      const order = await read('getIntentCommit', [id]);
      intentRows.push({
        loanId: id.toString(),
        maker: order.maker,
        makerAsset: order.makerAsset,
        custodialCollateral: order.makerAmount.toString(),
        deadline: order.deadline.toString(),
      });
    } catch (err) {
      if (!isNoCommitRevert(err)) throw err;
    }
  }

  // ── Class 3 — live VPFI intent commits, from the event lifecycle ──────
  // A commit is keyed by loanId and can only be created against a live loan,
  // so a chain that has never created a loan cannot hold one. Short-circuiting
  // there is sound AND material: the log scan walks every block since deploy,
  // which on fast testnets is millions of blocks of provably empty range.
  const deployBlock = BigInt(addresses.deployBlock ?? 0);
  const skippedLogScan = loanIds.length === 0;
  // OPTIONAL corroboration — an independent reconstruction of class 3 from the
  // event lifecycle. The view above is authoritative; this exists to catch a
  // disagreement between live state and history, and its failure is a NOTE
  // rather than a verdict, because a pruned node cannot refute live state.
  let corroboration = null;
  if (WANT_CORROBORATION && !skippedLogScan && intentSurfaceRouted) {
    try {
      const logs = await getLogsChunked(client, {
        address: diamond,
        events: intentEvents,
        fromBlock: deployBlock,
        toBlock: atBlock,
      });
      const live = new Map(); // `${loanId}:${orderHash}` -> makerAmount
      for (const log of logs) {
        const { loanId, orderHash, makerAmount } = log.args ?? {};
        if (loanId === undefined || orderHash === undefined) continue;
        const key = `${loanId}:${orderHash}`;
        if (log.eventName === 'SwapToRepayIntentCommitted') live.set(key, makerAmount ?? 0n);
        else live.delete(key); // Filled / Cancelled / ForceCancelled all tear the commit down
      }
      const fromLogs = [...live.keys()].map((k) => k.split(':')[0]).sort();
      const fromView = intentRows.map((r) => r.loanId).sort();
      corroboration = {
        source: 'event-lifecycle',
        logsSeen: logs.length,
        liveLoanIdsFromLogs: fromLogs,
        agreesWithView: JSON.stringify(fromLogs) === JSON.stringify(fromView),
      };
    } catch (err) {
      corroboration = {
        source: 'event-lifecycle',
        unavailable: `${classifyRpcError(err)}: ${(err?.details ?? err?.shortMessage ?? err?.message ?? '')
          .toString()
          .split('\n')[0]
          .slice(0, 180)}`,
      };
    }
  }

  const sum = (rows, field) => rows.reduce((a, r) => a + BigInt(r[field]), 0n).toString();

  return {
    chainSlug: slug,
    chainId: Number(chainId),
    diamond,
    atBlock: atBlock.toString(),
    scanned: {
      loanIdsEnumerated: loanIds.length,
      totalLoansEverCreated: totalLoansEverCreated.toString(),
      loanIdRange: loanIds.length ? `${loanIds[0]}..${loanIds[loanIds.length - 1]}` : 'none',
      intentSource: intentSurfaceRouted
        ? 'getIntentCommit view (live state, history-independent)'
        : 'not applicable — the intent surface is not routed on this Diamond, so no commit can exist',
      intentSurfaceRouted,
      intentCorroboration: corroboration,
    },
    classes: {
      vpfiHeldCustody: {
        status: 'proven',
        count: vpfiHeldRows.length,
        total: sum(vpfiHeldRows, 'vpfiHeld'),
        rows: vpfiHeldRows,
      },
      rebateRows: {
        status: 'proven',
        count: rebateRows.length,
        total: sum(rebateRows, 'rebateAmount'),
        rows: rebateRows,
      },
      fallbackSnapshotCustody: {
        status: 'proven',
        count: fallbackRows.length,
        total: sum(fallbackRows, 'collateralTotal'),
        rows: fallbackRows,
      },
      liveIntentCommits: {
        status: 'proven',
        count: intentRows.length,
        total: sum(intentRows, 'custodialCollateral'),
        rows: intentRows,
      },
    },
  };
}

async function main() {
  const which = arg('--chain', 'all');
  const chains = which === 'all' ? deployedChains() : [which];
  const outDir = arg('--out', join(REPO, 'docs/DesignsAndPlans/census'));

  const results = [];
  const failures = [];
  for (const slug of chains) {
    try {
      process.stderr.write(`census: ${slug} …\n`);
      results.push(await censusChain(slug));
    } catch (err) {
      failures.push({ chainSlug: slug, error: err.message });
      process.stderr.write(`census: ${slug} FAILED — ${err.message}\n`);
    }
  }

  // "Empty" is only claimable where every class was actually ESTABLISHED. An
  // indeterminate class is not evidence of absence, so it blocks the verdict
  // rather than passing as a zero.
  const allProven = results.every((r) => Object.values(r.classes).every((c) => c.status === 'proven'));
  const empty = allProven && results.every((r) => Object.values(r.classes).every((c) => c.count === 0));
  const indeterminate = results.flatMap((r) =>
    Object.entries(r.classes)
      .filter(([, c]) => c.status !== 'proven')
      .map(([name, c]) => ({ chainSlug: r.chainSlug, class: name, reason: c.indeterminateReason })),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: '#1566 grandfathered-custody census — decides whether slices 0-3 are live work or a certified no-op',
    allClassesEmpty: failures.length === 0 && results.length > 0 && empty,
    chainsCensused: results.length,
    chainsFailed: failures,
    indeterminateClasses: indeterminate,
    results,
  };

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'grandfathered-custody-census.json');
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

  for (const r of results) {
    const c = r.classes;
    process.stdout.write(
      `${r.chainSlug} (chainId ${r.chainId}, block ${r.atBlock}): ` +
        `loans=${r.scanned.loanIdsEnumerated} ` +
        `vpfiHeld=${c.vpfiHeldCustody.count} rebate=${c.rebateRows.count} ` +
        `fallback=${c.fallbackSnapshotCustody.count} liveIntents=${c.liveIntentCommits.count}\n`,
    );
  }
  process.stdout.write(`\nartifact: ${outFile}\n`);
  if (indeterminate.length) {
    process.stdout.write('\nINDETERMINATE (not evidence of absence):\n');
    for (const i of indeterminate) process.stdout.write(`  ${i.chainSlug}/${i.class}: ${i.reason}\n`);
  }
  process.stdout.write(
    report.allClassesEmpty
      ? 'RESULT: every grandfathered class is PROVEN EMPTY on every censused chain — slices 0-3 are a certified no-op.\n'
      : 'RESULT: not established — a class is non-empty, indeterminate, or a chain failed. See the artifact.\n',
  );

  if (failures.length || indeterminate.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`census: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
