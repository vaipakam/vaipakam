// apps/keeper/src/priceCheckpoint.ts
//
// #3384 — the PRICE CHECKPOINT pass: the keeper's backing for the #3359
// forced-sale floor's hourly price checkpoints.
//
// `SaleFloorFacet.saleFloorBps` lets a forced sale of deep, calm collateral
// lose less to the market than the full liquidation slippage cap. "Calm" is
// read from two hourly checkpoints: the pair's oracle rate now must be within
// the calm bound of its rate at BOTH of the last two UTC hours'
// checkpoints. `checkpointHourlyPrices(assets)` writes those checkpoints. It
// is permissionless, stores only the oracle's own reading, and is first
// caller per asset per hour. Until something calls it every hour, every
// forced sale reads `NoCheckpoint` and uses the full cap, which is the
// behaviour before #3359. So a missed hour can only send a sale back to the
// full cap for the next two hours. It can never tighten a floor.
//
// Each run (twice an hour, at :11 and :41), per chain with a Diamond:
//
//   1. Which assets: every lending and collateral asset of an ACTIVE loan
//      whose two legs are both ERC-20, from the shared indexer's `loans`
//      table. Only such a loan can reach a forced sale that reads the floor,
//      and the calm test needs BOTH legs' checkpoints. The indexer only
//      nominates: a stale or wrong row costs one asset's gas and records the
//      oracle's own price, and an asset it misses keeps that pair on the full
//      cap. Assets of open offers are left out on purpose: a loan opened in a
//      pair no other loan uses reads `NoCheckpoint` for its first two hours,
//      which is the full cap, the safe direction.
//   2. Whether the Diamond carries the floor at all (`getSaleFloorConfig`).
//      A Diamond from before #3359 refuses it, and the pass says so rather
//      than sending a call that would revert.
//   3. The UTC hour of the head block (the contract files a checkpoint under
//      `block.timestamp / 1 hours`), then, at that block, each asset's
//      checkpoint for the hour and its oracle price (`getAssetPrice`, the
//      reading the contract stores). Due: no checkpoint yet and a price that
//      reads. An asset whose price does not read is NOT sent: the contract
//      would skip it too, and the run says which assets those are.
//   4. Send the due assets, ASSETS_PER_SEND to a call, at most
//      MAX_SENDS_PER_RUN calls, simulated first. Each landed call is checked
//      against its `HourlyPriceCheckpointed` events: which assets it recorded,
//      and under which hour (a send mined after the hour turned files under
//      the next hour, which is still a checkpoint the floor needs). An asset
//      the call did not record (another caller got there first, or its price
//      stopped reading between the read and the send) is named.
//
// The second run in each hour is the retry. It sends only what the first run
// left unrecorded, so a healthy hour costs one transaction per chain.
//
// Gated by KEEPER_ENABLED + PRICE_CHECKPOINT_ENABLED. Ships disarmed.

import { createPublicClient, decodeEventLog, http, type Abi, type Address, type Hex, type Log, type PublicClient } from 'viem';
import { OracleFacetABI, SaleFloorFacetABI } from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline, settledGroupedRead, type BatchResult } from './batchRead';
import { boundedCall } from './passReader';
import { classify, shortErr } from './callErrors';
import { readCutoffMs, priorStageCutoffMs, runIndex } from './runWindow';
import { walkFrom } from './rotate';
import { StepSender } from './stepSender';
import { snapshotAssets } from './dailyOracleSnapshot';

export const ABI = [...(SaleFloorFacetABI as Abi), ...(OracleFacetABI as Abi)] as Abi;

/** Twice an hour: the first run writes the hour, the second retries what it
 *  left. Scheduled FROM this constant (passSchedule.ts). */
export const PASS_CADENCE_SEC = 30 * 60;

/** Assets in one `checkpointHourlyPrices` call. Each new checkpoint is one
 *  storage write plus an oracle read, so this bounds a call's gas. */
export const ASSETS_PER_SEND = 25;

/** Calls per chain per run. With ASSETS_PER_SEND, a run checkpoints up to 100
 *  assets; more are taken first on the next run (the order rotates). */
export const MAX_SENDS_PER_RUN = 4;

export const RECEIPT_TIMEOUT_MS = 30_000;

/** Calls in one multicall of the per-asset reads (two per asset). */
const READ_CHUNK = 100;

/** The checkpoint call takes no pause and refuses nothing it is given; these
 *  are named for the sender's contract and never expected. */
const RACES: ReadonlySet<string> = new Set();
const PAUSED_REFUSAL = 'EnforcedPause';

/** One chain's run, as its log line states it. */
export interface CheckpointReport {
  chainId: number;
  /** Why the chain was not worked this run, when it was not. */
  skipped?: string;
  /** The UTC hour index (`timestamp / 3600`) of the block the run read at. */
  hour: number | null;
  /** Assets the indexer named. */
  tracked: number;
  /** Already checkpointed for the hour when read. */
  alreadyRecorded: number;
  /** Not sent: the oracle price did not read, so the contract would skip it. */
  unpriced: Address[];
  /** Due this run (no checkpoint for the hour and a price that reads). */
  due: number;
  /** Recorded by this run's calls under the hour read. */
  recorded: Address[];
  /** Recorded by this run's calls under a LATER hour (mined after the turn). */
  filedLater: { asset: Address; hour: number }[];
  /** Sent in a call that landed but not recorded by it: another caller wrote
   *  the hour first, or the price stopped reading before the call ran. */
  notRecorded: Address[];
  /** Due but not sent this run (the send budget, the deadline or a stop);
   *  the next run reads them again. */
  deferred: number;
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

export interface CheckpointDeps {
  /** The deadline-bound client: chain id, head block, the floor probe. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the cutoff themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  /** Which run this is (`runIndex`): where the asset order starts. */
  visit: number;
  /** The candidate assets for this chain (the indexer's view). */
  assets: () => Promise<readonly string[]>;
}

export async function runPriceCheckpoint(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'priceCheckpoint', 'PRICE_CHECKPOINT_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const visit = runIndex(tick, PASS_CADENCE_SEC * 1000);
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await checkpointOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          sendDeadline,
          visit,
          assets: () => trackedPairAssets(env, chain.id),
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] priceCheckpoint chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

/**
 * The lending and collateral assets of the chain's active loans whose two
 * legs are both ERC-20 (asset type 0), deduplicated, malformed values dropped
 * (and counted) by the same shape rule the daily snapshot applies.
 */
export async function trackedPairAssets(env: Env, chainId: number): Promise<Address[]> {
  const rows = await env.DB.prepare(
    `SELECT lending_asset AS asset FROM loans
       WHERE chain_id = ?1 AND status = 'active' AND asset_type = 0 AND collateral_asset_type = 0
     UNION
     SELECT collateral_asset AS asset FROM loans
       WHERE chain_id = ?1 AND status = 'active' AND asset_type = 0 AND collateral_asset_type = 0`,
  )
    .bind(chainId)
    .all<{ asset: string }>();
  return snapshotAssets((rows.results ?? []).map((r) => r.asset), chainId, 'priceCheckpoint');
}

/** The run's one line for a chain. */
export function describeReport(r: CheckpointReport): string {
  const head = `[keeper] priceCheckpoint chain=${r.chainId}`;
  if (r.skipped) return `${head}: not worked this run: ${r.skipped}`;
  const parts = [
    head,
    `hour=${r.hour ?? 'unread'}`,
    `tracked=${r.tracked}`,
    `already=${r.alreadyRecorded}`,
    `due=${r.due}`,
    `recorded=${r.recorded.length}`,
    ...(r.filedLater.length > 0 ? [`filed-next-hour=${r.filedLater.map((f) => `${f.asset}@${f.hour}`).join(',')}`] : []),
    ...(r.notRecorded.length > 0 ? [`sent-not-recorded=${r.notRecorded.join(',')}`] : []),
    ...(r.unpriced.length > 0 ? [`no-price=${r.unpriced.join(',')}`] : []),
    ...(r.deferred > 0 ? [`deferred=${r.deferred} (taken first next run)`] : []),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

/** The oracle reading scaled to 1e18, the way the contract scales it before
 *  storing; 0 when the contract would treat it as unreadable. Pure. */
export function price1e18(price: bigint, decimals: number): bigint {
  if (price === 0n) return 0n;
  return decimals <= 18 ? price * 10n ** BigInt(18 - decimals) : price / 10n ** BigInt(decimals - 18);
}

/** What one asset's two reads say: `recorded` (a checkpoint exists for the
 *  hour), `due`, `unpriced`, or `undefined` when the checkpoint read did not
 *  come back. Pure. */
export function assetState(checkpoint: BatchResult | undefined, price: BatchResult | undefined): 'recorded' | 'due' | 'unpriced' | undefined {
  if (checkpoint?.status !== 'success') return undefined;
  if ((checkpoint.result as bigint) !== 0n) return 'recorded';
  if (price?.status !== 'success') return 'unpriced';
  const [p, d] = price.result as readonly [bigint, number];
  return price1e18(p, Number(d)) === 0n ? 'unpriced' : 'due';
}

/** The assets a landed call recorded, from its `HourlyPriceCheckpointed`
 *  events emitted by `diamond`, with the hour each was filed under. Pure. */
export function recordedBy(diamond: Address, logs: readonly Log[]): { asset: Address; hour: number }[] {
  const out: { asset: Address; hour: number }[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue; // not an event this ABI names, so not a checkpoint
    }
    if (ev.eventName !== 'HourlyPriceCheckpointed') continue;
    const args = ev.args as unknown as { asset: Address; hourIndex: bigint };
    out.push({ asset: args.asset.toLowerCase() as Address, hour: Number(args.hourIndex) });
  }
  return out;
}

/** One chain's run. Exported for tests. */
export async function checkpointOnce(chainId: number, diamond: Address, deps: CheckpointDeps): Promise<CheckpointReport> {
  const sender = new StepSender(
    {
      pass: 'priceCheckpoint',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: RACES,
      pausedRefusal: PAUSED_REFUSAL,
      describe: (s) => `asset batch ${s}`,
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: CheckpointReport = {
    chainId,
    hour: null,
    tracked: 0,
    alreadyRecorded: 0,
    unpriced: [],
    due: 0,
    recorded: [],
    filedLater: [],
    notRecorded: [],
    deferred: 0,
    refused: sender.refused,
    unread: sender.unread,
    stopped: null,
  };
  // The per-asset reads stop by the read cutoff, which reserves the sends'
  // time; the probes before them a stage reserve earlier (runWindow.ts, rule 3).
  const readCutoff = readCutoffMs(deps.sendDeadline);
  const probeCutoff = priorStageCutoffMs(readCutoff);

  // The RPC must answer for this chain: a deterministic deployment can put a
  // Diamond at the same address on another chain.
  let served: number;
  try {
    served = await boundedCall(probeCutoff, 'the chain id', () => deps.client.getChainId());
  } catch (err) {
    return { ...report, skipped: err instanceof PastRunDeadline ? 'the run deadline passed during its first reads' : `the RPC's chain id could not be read (${shortErr(err)})` };
  }
  if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };

  let assets: Address[];
  try {
    assets = snapshotAssets(await boundedCall(probeCutoff, "the active loans' assets", deps.assets), chainId, 'priceCheckpoint');
  } catch (err) {
    if (err instanceof PastRunDeadline) return { ...report, skipped: 'the run deadline passed during its first reads' };
    return { ...report, skipped: `the active loans' assets could not be read from the indexer (${shortErr(err)})` };
  }
  report.tracked = assets.length;
  if (assets.length === 0) return { ...report, skipped: 'no active loan with two ERC-20 legs, so no pair reads the sale floor' };

  // Whether this Diamond carries the #3359 floor.
  try {
    await boundedCall(probeCutoff, 'the sale floor settings', () =>
      deps.client.readContract({ address: diamond, abi: ABI, functionName: 'getSaleFloorConfig' }),
    );
  } catch (err) {
    if (err instanceof PastRunDeadline) return { ...report, skipped: 'the run deadline passed during its first reads' };
    const c = classify(err);
    return {
      ...report,
      skipped:
        'refused' in c
          ? `this Diamond does not answer getSaleFloorConfig (${c.refused}), so it does not carry the #3359 sale floor and has no checkpoints to write`
          : `the sale floor settings could not be read (${c.unread})`,
    };
  }

  // The hour the contract would file under, from the head block.
  let block: { number: bigint | null; timestamp: bigint };
  try {
    block = await boundedCall(probeCutoff, 'the head block', () => deps.client.getBlock());
  } catch (err) {
    return { ...report, skipped: err instanceof PastRunDeadline ? 'the run deadline passed during its first reads' : `the head block could not be read (${shortErr(err)})` };
  }
  const hour = Number(block.timestamp / 3600n);
  report.hour = hour;

  const reads = await settledGroupedRead(
    deps.readClient,
    assets,
    READ_CHUNK,
    (asset) => [
      { address: diamond, abi: ABI, functionName: 'getHourlyPriceCheckpoint', args: [asset, BigInt(hour)] },
      { address: diamond, abi: ABI, functionName: 'getAssetPrice', args: [asset] },
    ],
    'priceCheckpoint assets',
    readCutoff,
    deps.visit,
    block.number ?? undefined,
  );
  const due: Address[] = [];
  let unreadAssets = 0;
  for (const asset of assets) {
    const [cp, price] = reads.get(asset) ?? [];
    const state = assetState(cp, price);
    if (state === undefined) unreadAssets += 1;
    else if (state === 'recorded') report.alreadyRecorded += 1;
    else if (state === 'unpriced') report.unpriced.push(asset);
    else due.push(asset);
  }
  if (unreadAssets > 0) sender.noteUnread('assets', `the hour's checkpoint of ${unreadAssets} asset(s)`);
  report.due = due.length;

  // Rotated by run, so a budget-capped run leaves a different tail each time.
  const ordered = walkFrom(due, deps.visit);
  const batches: Address[][] = [];
  for (let i = 0; i < ordered.length; i += ASSETS_PER_SEND) batches.push(ordered.slice(i, i + ASSETS_PER_SEND));
  for (const [i, batch] of batches.entries()) {
    if (sender.stopped || i >= MAX_SENDS_PER_RUN) {
      report.deferred += batch.length;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const res = await sender.call('checkpoint', String(i + 1), 'checkpointHourlyPrices', [batch]);
    if (res === 'skipped') report.deferred += batch.length;
    if (res !== 'landed') continue;
    const filedHour = new Map(recordedBy(diamond, (sender.receipt?.logs ?? []) as Log[]).map((g) => [g.asset, g.hour]));
    for (const asset of batch) {
      const filed = filedHour.get(asset.toLowerCase() as Address);
      if (filed === undefined) report.notRecorded.push(asset);
      else if (filed === hour) report.recorded.push(asset);
      else report.filedLater.push({ asset, hour: filed });
    }
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}
