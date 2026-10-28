// apps/keeper/src/protocolUpkeep.ts
//
// #2984 — the PROTOCOL UPKEEP pass: permissionless housekeeping outside the
// reward system that nothing else calls on a schedule. Each step is open to
// anyone; without a keeper it waits for someone to make the call by hand.
//
// Per chain, per run (every hour), in this order:
//
//   1. BUYBACK EXPIRY — roll back every buyback intent past its expiry that is
//      still pending (`TreasuryFacet.expireBuybackIntent`). Until it is rolled
//      back, the unfilled part of its reservation stays out of the spendable
//      buyback budget, its allowance to the limit-order protocol stays live,
//      and it holds one of the intent dispatcher's live-commit slots. No view
//      lists the intents, so the indexer's ledger of `BuybackIntentCommitted`
//      nominates them: a page a run, from where the last run stopped and
//      wrapping round, above a stored floor every row before which names an
//      intent no longer pending (the Codex #2993 r2 rule). That floor moves
//      only on what the chain's finalized block shows (r4). Every decision is
//      the order's own record (`getBuybackOrder`), against the chain's own
//      clock.
//   2. TIER LTV REFRESH — refresh the per-tier LTV cache from the peer
//      protocols (`OracleFacet.refreshTierLtvCache`). A cached tier is used
//      only while it is under 14 days old, so a cache nobody refreshes falls
//      back to the governance tier caps. The call is simulated with its logs
//      first (`eth_simulateV1`) and sent only when it would write a tier: one
//      whose value would change, or one cached longer ago than
//      `TIER_LTV_REFRESH_AFTER_SEC` (default 7 days). A refresh that would
//      write nothing, on a chain whose peers give no reading, costs nothing.
//      The run's line names each tier the refresh rejects, with the
//      contract's reason. Skipped while peer LTV reads are paused.
//   3. PREPAY-SALE SANCTIONS SYNC — the two permissionless syncs that commit
//      a flagged sale recipient to the fail-closed registry and cancel its
//      listing (`prepaySaleSanctions.ts`). Off unless
//      PREPAY_SALE_SANCTIONS_SYNC_ENABLED is also set.
//   4. TIER-PUSH RETRY — deliver a tier push a broadcast lane is still owed,
//      when the protocol budget can pay it (`tierPushRetry.ts`). Off unless
//      TIER_PUSH_RETRY_ENABLED is also set.
//
// Every call is simulated on the current state first and waits for its
// receipt before the next (`stepSender.ts`). None carries value from the
// keeper, and none moves value to it; step 4's lane fees are the protocol
// budget's, under the facet's own rule.
//
// Gated by KEEPER_ENABLED + PROTOCOL_UPKEEP_ENABLED (step 3 also by
// PREPAY_SALE_SANCTIONS_SYNC_ENABLED, step 4 by TIER_PUSH_RETRY_ENABLED).
// Ships disarmed.

import { createPublicClient, decodeEventLog, encodeFunctionData, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { AdminFacetABI, OracleFacetABI, TreasuryFacetABI, VaipakamDiamondABI } from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, resolveKeeperAccount, subStepArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline, settledRead, type BatchResult } from './batchRead';
import { shortErr } from './callErrors';
import { d1EventLedger, type EventLedger } from './eventLedger';
import { readLedgerRotation } from './ledgerRotation';
import { d1ScanCursors, finalizedBlockOnce, type FinalBlock, type ScanCursors } from './scanCursors';
import { StepSender } from './stepSender';
import { describeSales, emptySalesReport, SALE_RACES, SALES_ABI, syncSaleListings, type SalesSyncReport } from './prepaySaleSanctions';
import { describeTierPush, emptyTierPushReport, retryTierPushes, TIER_PUSH_ABI, type TierPushReport } from './tierPushRetry';
import { runIndex } from './runWindow';

export const ABI = [
  ...(AdminFacetABI as Abi),
  ...(OracleFacetABI as Abi),
  ...(TreasuryFacetABI as Abi),
  ...SALES_ABI,
  ...TIER_PUSH_ABI,
  ...(VaipakamDiamondABI as Abi).filter((x) => x.type === 'error'),
] as Abi;

/** The pass's cadence, in seconds; the scheduler reads it from here. Neither
 *  step is time-critical to the minute. */
export const PASS_CADENCE_SEC = 60 * 60;
/** Sends per chain per run. */
export const MAX_SENDS_PER_RUN = 10;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Commit rows read per run from the ledger, rotating above the expiry floor. */
export const BUYBACK_PAGE = 200;
export const BUYBACK_FLOOR_ITEM = 'buyback-floor';
export const BUYBACK_NEXT_ITEM = 'buyback-next';
const COMMIT_EVENT = 'BuybackIntentCommitted';
const STATUS_PENDING = 1;
/** The order's ended statuses (`LibVaipakam.BUYBACK_ORDER_STATUS_FILLED` /
 *  `_EXPIRED`); NONE (0) is an order never made, which ends nothing. */
const STATUS_ENDED: ReadonlySet<number> = new Set([2, 3]);
/** A cached tier older than this is refreshed even when its value would not
 *  change, unless `TIER_LTV_REFRESH_AFTER_SEC` says otherwise. Half the
 *  contract's 14-day validity, so one failed day never lets it lapse. */
export const DEFAULT_REFRESH_AFTER_SEC = 7 * 24 * 60 * 60;
/** Tiers the cache holds (`LibVaipakam.MAX_LIQUIDITY_TIER`). */
export const TIERS = [1, 2, 3] as const;

/** Refusals that mean another caller got there first. */
export const RACES = new Set(['BuybackOrderNotPending', ...SALE_RACES]);
export const PAUSED_REFUSAL = 'EnforcedPause';

/** What one chain's run reads and signs with. Injected so a run is testable. */
export interface UpkeepDeps {
  /** Deadline-bound client: single reads, simulations and the log preview. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  /** The keeper's address, or null when the key is unset or malformed. */
  keeper: Address | null;
  sendDeadline: number;
  refreshAfterSec: number;
  cursors: ScanCursors;
  ledger: EventLedger;
  /** Step 3, the prepay-sale sanctions sync (PREPAY_SALE_SANCTIONS_SYNC_ENABLED). Off when absent. */
  salesSync?: boolean;
  /** Step 4, the tier-push retry (TIER_PUSH_RETRY_ENABLED). Off when absent. */
  tierPush?: boolean;
  /** Which run this is (`runIndex`), for the rotated reads of steps 3 and 4. */
  visit?: number;
}

/** What a run did on one chain: its log line's figures, and what tests read. */
export interface UpkeepReport {
  chainId: number;
  skipped?: string;
  /** Buyback intents rolled back this run. */
  expired: string[];
  /** Whether the tier cache was refreshed, and the tiers it wrote. */
  refreshed: number[] | null;
  /** Tiers the refresh (or its preview) rejected, with the contract's reason. */
  tiersRejected: string[];
  /** Why the refresh was not sent, when the preview showed nothing to write. */
  refreshIdle: string | null;
  /** Step 3's figures; null when the step is off. */
  sales: SalesSyncReport | null;
  /** Step 4's figures; null when the step is off. */
  tierPush: TierPushReport | null;
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

export async function runProtocolUpkeep(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'protocolUpkeep', 'PROTOCOL_UPKEEP_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const refreshAfterSec = readPositive(env.TIER_LTV_REFRESH_AFTER_SEC, DEFAULT_REFRESH_AFTER_SEC);
  const salesSync = subStepArmed(env, 'protocolUpkeep', 'step 3 (prepay-sale sanctions sync)', 'PREPAY_SALE_SANCTIONS_SYNC_ENABLED');
  const tierPush = subStepArmed(env, 'protocolUpkeep', 'step 4 (tier-push retry)', 'TIER_PUSH_RETRY_ENABLED');
  const visit = runIndex(tick, PASS_CADENCE_SEC * 1000);
  const resolved = env.KEEPER_PRIVATE_KEY ? resolveKeeperAccount(env.KEEPER_PRIVATE_KEY) : null;
  const keeper = resolved && 'account' in resolved ? resolved.account.address : null;
  const ledger = d1EventLedger(env.DB);
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await upkeepOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          keeper,
          sendDeadline,
          refreshAfterSec,
          cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'protocolUpkeep'),
          ledger,
          salesSync,
          tierPush,
          visit,
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] protocolUpkeep chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

function readPositive(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** The run's one line for a chain. */
export function describeReport(r: UpkeepReport): string {
  if (r.skipped) return `[keeper] protocolUpkeep chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const parts = [
    `[keeper] protocolUpkeep chain=${r.chainId}`,
    `buybacks-expired=${r.expired.map((h) => h.slice(0, 10)).join(',') || 'none'}`,
    `tier-ltv-refreshed=${r.refreshed === null ? 'no' : `tiers ${r.refreshed.join(',') || 'none'}`}`,
    ...(r.refreshIdle ? [`tier-ltv-idle=${r.refreshIdle}`] : []),
    ...(r.tiersRejected.length > 0 ? [`tiers-rejected=${r.tiersRejected.join('; ')}`] : []),
    ...describeSales(r.sales),
    ...describeTierPush(r.tierPush),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

/** One chain's run. Exported for tests. */
export async function upkeepOnce(chainId: number, diamond: Address, deps: UpkeepDeps): Promise<UpkeepReport> {
  const sender = new StepSender(
    {
      pass: 'protocolUpkeep',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: RACES,
      pausedRefusal: PAUSED_REFUSAL,
      describe: (s) => String(s),
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: UpkeepReport = {
    chainId,
    expired: [],
    refreshed: null,
    tiersRejected: [],
    refreshIdle: null,
    // An armed step reads as armed from the start: a run that ends before it
    // is reached says so, never that the step is off.
    sales: deps.salesSync === true ? { ...emptySalesReport(), off: 'not reached this run' } : null,
    tierPush: deps.tierPush === true ? { ...emptyTierPushReport(), off: 'not reached this run' } : null,
    refused: sender.refused,
    unread: sender.unread,
    stopped: null,
  };
  const r = new Reader(deps, diamond);
  try {
    // The RPC must answer for this chain: a deterministic deployment can put
    // a Diamond at the same address on another chain.
    let served: number;
    try {
      served = await deps.client.getChainId();
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the RPC's chain id could not be read (${shortErr(err)})` };
    }
    if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };
    await expireBuybacks(r, sender, report, chainId, deps);
    await refreshTierLtv(r, sender, report, deps);
    if (deps.salesSync === true) {
      report.sales = await syncSaleListings(chainId, diamond, sender, {
        readClient: deps.readClient,
        sendDeadline: deps.sendDeadline,
        visit: deps.visit ?? 0,
        cursors: deps.cursors,
        ledger: deps.ledger,
        finalized: r.finalized,
      });
    }
    if (deps.tierPush === true) {
      report.tierPush = await retryTierPushes(chainId, diamond, sender, {
        readClient: deps.readClient,
        sendDeadline: deps.sendDeadline,
        visit: deps.visit ?? 0,
        cursors: deps.cursors,
        ledger: deps.ledger,
        finalized: r.finalized,
      });
    }
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the run deadline passed during its reads');
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

/** Reads, each refused past the run's deadline. */
class Reader {
  /** The chain's finalized block, read once a run (`scanCursors.finalFloor`). */
  readonly finalized: () => Promise<FinalBlock | null>;

  constructor(
    readonly deps: UpkeepDeps,
    readonly diamond: Address,
  ) {
    this.finalized = finalizedBlockOnce(deps.client);
  }

  async one<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await this.deps.client.readContract({ address: this.diamond, abi: ABI, functionName, args })) as T;
  }

  /** Many reads; `undefined` where a read did not come back. At the head, or
   *  at `blockNumber` when one is given. */
  async many(calls: readonly { functionName: string; args: readonly unknown[] }[], label: string, blockNumber?: bigint): Promise<unknown[]> {
    if (calls.length === 0) return [];
    const res: BatchResult[] = await settledRead(
      this.deps.readClient,
      calls.map((c) => ({ address: this.diamond, abi: ABI, functionName: c.functionName, args: c.args })),
      `protocolUpkeep ${label}`,
      this.deps.sendDeadline,
      blockNumber,
    );
    return res.map((x) => (x.status === 'success' ? x.result : undefined));
  }
}

// ─── 1. Buyback expiry ──────────────────────────────────────────────────────

interface BuybackOrder {
  token: Address;
  amountIn: bigint;
  minVpfiOut: bigint;
  expiresAt: bigint;
  status: number;
}

async function expireBuybacks(r: Reader, sender: StepSender, report: UpkeepReport, chainId: number, deps: UpkeepDeps): Promise<void> {
  // The order each row names; a row that names none nominates nothing.
  const page = await readLedgerRotation<Hex>({
    ledger: deps.ledger,
    cursors: deps.cursors,
    chainId,
    kinds: [COMMIT_EVENT],
    floorItem: BUYBACK_FLOOR_ITEM,
    nextItem: BUYBACK_NEXT_ITEM,
    limit: BUYBACK_PAGE,
    nominee: (row) => {
      const h = String(row.args.orderHash ?? '').toLowerCase();
      return /^0x[0-9a-f]{64}$/.test(h) ? (h as Hex) : null;
    },
    id: (h) => h,
  });
  if (page === null) {
    sender.noteUnread('buyback', 'the event ledger of buyback commits');
    return;
  }
  const orders = page.nominees;
  const readOrders = (hs: readonly Hex[], label: string, blockNumber?: bigint) =>
    r.many(hs.map((h) => ({ functionName: 'getBuybackOrder', args: [h] })), label, blockNumber);
  const settled = new Set<Hex>();
  if (orders.length > 0) {
    let now: bigint;
    try {
      now = (await deps.client.getBlock()).timestamp;
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      sender.noteUnread('buyback', `the chain's clock (${shortErr(err)})`);
      return;
    }
    const recs = await readOrders(orders, 'buyback orders');
    for (let i = 0; i < orders.length; i++) {
      const h = orders[i];
      const rec = recs[i] as BuybackOrder | undefined;
      if (rec === undefined) {
        sender.noteUnread(`expire:${h.slice(0, 10)}`, 'its buyback order record');
        continue;
      }
      if (Number(rec.status) !== STATUS_PENDING) {
        settled.add(h);
        continue;
      }
      if (rec.expiresAt > now) continue;
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call('expire', h.slice(0, 10), 'expireBuybackIntent', [h]);
      if (res === 'landed') {
        report.expired.push(h);
        settled.add(h);
      }
    }
  }
  // A row is finished when its order is no longer pending (`ledgerRotation.ts`):
  // an expiry a reorg undoes leaves its row above the floor, to be sent again.
  // At the finalized block the order must show filled or expired: below the
  // commit it reads as never made (status 0), which is not an ended order.
  await page.liftFloor(r.finalized, (h) => settled.has(h), async (hs, block) => {
    const at = await readOrders(hs, 'buyback-final', block.number);
    const done = new Set(hs.filter((_, j) => {
      const rec = at[j] as BuybackOrder | undefined;
      return rec !== undefined && STATUS_ENDED.has(Number(rec.status));
    }));
    return (h) => done.has(h);
  });
}

// ─── 2. Tier LTV refresh ────────────────────────────────────────────────────

/** What the refresh would write, from its simulated logs. */
export interface RefreshPreview {
  /** tier → [new value, old value]. */
  updated: Map<number, [number, number]>;
  /** tier → the contract's rejection reason. */
  rejected: Map<number, string>;
}

/** Decode a refresh's logs from the Diamond. Exported for tests. */
export function readRefreshLogs(diamond: Address, logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]): RefreshPreview {
  const out: RefreshPreview = { updated: new Map(), rejected: new Map() };
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: OracleFacetABI as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = ev.args as unknown as Record<string, unknown>;
    if (ev.eventName === 'TierLtvCacheUpdated') out.updated.set(Number(a.tier), [Number(a.newLtvBps), Number(a.oldLtvBps)]);
    else if (ev.eventName === 'TierLtvCacheRefreshRejected') out.rejected.set(Number(a.tier), `${String(a.reason)}${Number(a.candidateLtvBps) > 0 ? ` (candidate ${Number(a.candidateLtvBps)} bps)` : ''}`);
  }
  return out;
}

async function refreshTierLtv(r: Reader, sender: StepSender, report: UpkeepReport, deps: UpkeepDeps): Promise<void> {
  if (sender.stopped) return;
  const [paused, ...entries] = await r.many(
    [{ functionName: 'peerLtvReadsPaused', args: [] }, ...TIERS.map((t) => ({ functionName: 'getTierLtvCacheEntry', args: [t] }))],
    'tier-ltv',
  );
  if (paused === undefined || entries.some((e) => e === undefined)) {
    sender.noteUnread('tier-ltv', 'the tier LTV cache or whether peer reads are paused');
    return;
  }
  if (paused === true) {
    report.refreshIdle = 'peer LTV reads are paused';
    return;
  }
  if (deps.keeper === null) {
    sender.noteUnread('tier-ltv', 'the keeper key (no account to preview the refresh from)');
    return;
  }
  let now: bigint;
  let results;
  try {
    now = (await deps.client.getBlock()).timestamp;
    ({ results } = await deps.client.simulateCalls({
      account: deps.keeper,
      calls: [{ to: r.diamond, data: encodeFunctionData({ abi: ABI, functionName: 'refreshTierLtvCache', args: [] }) }],
    }));
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    sender.noteUnread('tier-ltv', `the refresh's preview (eth_simulateV1: ${shortErr(err)})`);
    return;
  }
  const res = results[0];
  if (!res || res.status !== 'success' || res.logs === undefined) {
    // A failed preview is the simulation StepSender would refuse anyway; a
    // preview without logs has not shown what the refresh writes.
    sender.noteUnread('tier-ltv', res?.status === 'success' ? 'the refresh preview reported no logs' : 'the refresh preview reverted');
    return;
  }
  const preview = readRefreshLogs(r.diamond, res.logs as never);
  for (const [t, why] of preview.rejected) report.tiersRejected.push(`tier ${t}: ${why}`);
  // A tier is worth writing when its value would change or its entry is old.
  const worth = TIERS.filter((t, i) => {
    const u = preview.updated.get(t);
    if (u === undefined) return false;
    const [cached, at] = entries[i] as readonly [number, bigint];
    return u[0] !== Number(cached) || now - BigInt(at) >= BigInt(deps.refreshAfterSec);
  });
  if (worth.length === 0) {
    report.refreshIdle = preview.updated.size === 0 ? 'the refresh would write no tier' : `every tier it would write is unchanged and cached under ${deps.refreshAfterSec} s ago`;
    return;
  }
  const sent = await sender.call('refresh', 'tier LTV cache', 'refreshTierLtvCache', []);
  if (sent !== 'landed') return;
  const landed = sender.receipt ? readRefreshLogs(r.diamond, sender.receipt.logs as never) : preview;
  report.refreshed = [...landed.updated.keys()].sort();
  // The receipt is the record of what the refresh rejected.
  report.tiersRejected = [...landed.rejected].map(([t, why]) => `tier ${t}: ${why}`);
}
