/**
 * RPC read-diet PR B (Alpha02RpcReadDietDesign §4.2.1) — protocol-config
 * snapshot: refresh half + the public GET /config/:chainId route.
 *
 * Protocol config (the `getProtocolConfigBundle` tuple + the range/
 * partial master flags) is chain-only for the apps today: every browser
 * re-reads it on 5–10 min caches even though it changes only on rare
 * governance action. The indexer already scans every Diamond event, so
 * it maintains ONE row per chain here and the apps' DISPLAY surfaces
 * read it with zero per-user RPC. Boundary (design §2, L51–52): pre-sign
 * paths keep reading the Diamond live — the snapshot is display-only.
 *
 * Refresh triggers, both fail-open (a refresh failure never blocks or
 * aborts ingest — the apps fall back to their chain read):
 *   - a scanned log whose event name is on the explicit governance
 *     allowlist below (a false positive costs one redundant eth_call,
 *     a miss costs only the backstop delay);
 *   - a time backstop, so a chain whose config predates this table (or
 *     a future setter missing from the allowlist) still converges.
 */

import type { Address, PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { Env } from './env';
import { jsonResponse } from './offerRoutes';

/** Explicit allowlist of GLOBAL governance config events (Codex #1231
 *  r1: a suffix rule also matched per-loan lifecycle names like
 *  `NFTStatusUpdated` and `PrepayListingUpdated`, spending the two
 *  refresh eth_calls on ordinary market activity). Source of truth:
 *  the ConfigFacet event list + AdminFacet's protocol-global setters.
 *  Deliberately EXCLUDED: per-user/per-asset events (KYCTierUpdated,
 *  KeeperAccessUpdated, TradeAllowanceSet, AssetPauseEnabled, ...) —
 *  they never change the served bundle/flags. Over-inclusion of a
 *  rare global setter is harmless (one redundant refresh); the 6h
 *  backstop covers any future setter missing from this list. */
const CONFIG_EVENT_NAMES: ReadonlySet<string> = new Set([
  // ConfigFacet
  'FeesConfigSet',
  'LiquidationConfigSet',
  'MaxSwapToRepaySlippageBpsSet',
  'RiskConfigSet',
  'VpfiTierThresholdsSet',
  'VpfiTierDiscountsSet',
  'FallbackSplitSet',
  'RangeAmountEnabledSet',
  'RangeRateEnabledSet',
  'PartialFillEnabledSet',
  'RangeCollateralEnabledSet',
  'GraceBucketsUpdated',
  'AssetMinPartialBpsUpdated',
  'LifMatcherFeeBpsSet',
  'PrepayListingBufferBpsSet',
  'PrepayListingEnabledSet',
  'PrepayListingDutchGraceMarginSecSet',
  'PrepayListingAutoListConduitKeySet',
  'TreasuryConvertTargetsSet',
  'TreasuryConvertThresholdsSet',
  'MaxPartialLiquidationCloseFactorBpsSet',
  'TierLtvParamsSet',
  'AutoPauseDurationSet',
  'MaxOfferDurationDaysSet',
  'NotificationFeeSet',
  'DepthTieredLtvEnabledSet',
  'LiquiditySlippageBpsSet',
  'TwapGuardSet',
  'LiquidityTierSizesSet',
  'TierMaxInitLtvBpsSet',
  'PaaAssetsSet',
  'KeeperTierSet',
  'RiskAccessGateEnabledSet',
  'DiscountPathEnabledSet',
  'TierLiqDiscountBpsSet',
  'TierLiquidationLtvBpsSet',
  'InternalMatchEnabledSet',
  'InternalMatchConfigSet',
  'TierTableVersionBumped',
  'TwaRecentDaysSet',
  'TwaWindowDaysSet',
  'TwaRecentWeightSet',
  'TwaMinStakedDaysSet',
  'MirrorTierMaxAgeSecSet',
  // AdminFacet / ProfileFacet protocol-globals
  'AutoExtendEnabledSet',
  'AutoLendEnabledSet',
  'AutoRefinanceEnabledSet',
  'KYCEnforcementSet',
  'KYCThresholdsUpdated',
  'KeepersPausedSet',
  'AggregatorAdaptersPausedSet',
  'PeerLtvReadsPausedSet',
  'RateModelSet',
  'RateModelMaxDeviationBpsSet',
  'PartialLiquidationSizingSet',
  'SwapAdapterAdded',
  'SwapAdapterRemoved',
  'SwapAdapterDisabledSet',
  'SwapAdaptersReordered',
  'UniswapV2FactorySet',
  'SushiswapV2FactorySet',
  'SushiswapV3FactorySet',
  'PancakeswapV2FactorySet',
  'PancakeswapV3FactorySet',
  'TreasurySet',
  'ZeroExProxySet',
  'AllowanceTargetSet',
  'SanctionsOracleSet',
]);

/** Backstop refresh age: config flips are event-driven within one scan
 *  (~60s); the backstop covers bootstrap + any setter missing from the
 *  allowlist. */
const BACKSTOP_SECONDS = 6 * 3600;

/** Only refresh when the scan reached (near) the live head: during a
 *  cold backfill / stalled-cursor catch-up the scan's upper bound is
 *  historic, and stamping a fresh `updated_at` on an OLD-block read
 *  would let clients trust values that miss later governance changes
 *  (Codex #1231 r1). ~2 minutes of Base blocks. */
const NEAR_HEAD_BLOCKS = 60n;

export function isConfigEventName(name: string): boolean {
  return CONFIG_EVENT_NAMES.has(name);
}

/** Decide whether this scan needs a snapshot refresh. Pure, for tests. */
export function shouldRefreshConfig(opts: {
  sawConfigEvent: boolean;
  rowUpdatedAt: number | null; // null = no row yet
  nowSec: number;
}): boolean {
  if (opts.sawConfigEvent) return true;
  if (opts.rowUpdatedAt === null) return true;
  return opts.nowSec - opts.rowUpdatedAt > BACKSTOP_SECONDS;
}

/** Zero a row's freshness stamp so clients refuse it (their 24h
 *  freshness check fails on 0) and the next scan's backstop math
 *  retries immediately. Guarded on `source_block` so a LATE-finishing
 *  older scan can never invalidate a row a newer scan already wrote:
 *  a stored row pinned at or past `belowBlock` already reflects every
 *  event this scan saw (Codex #1231 r2). */
async function markStaleBelow(
  env: Env,
  chainId: number,
  belowBlock: bigint,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE protocol_config SET updated_at = 0
     WHERE chain_id = ? AND source_block < ?`,
  )
    .bind(chainId, Number(belowBlock))
    .run();
}

/** JSON-serialize a tuple with bigints as decimal strings — via a
 *  REPLACER so NESTED arrays/structs (the uint256[4] VPFI tier slots)
 *  convert too; a top-level-only map left nested BigInts for
 *  JSON.stringify to throw on, which fail-opened every refresh
 *  (Codex #1231 r1). */
export function serializeTuple(values: readonly unknown[]): string {
  return JSON.stringify(values, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

/**
 * Refresh the snapshot row for one chain if warranted. Called at the
 * end of a successful scan, AFTER the cursor advance — a failure here
 * logs and returns (fail-open; the row simply stays at its previous
 * state and the apps' chain fallback covers display).
 */
export async function maybeRefreshProtocolConfig(opts: {
  env: Env;
  chainId: number;
  client: PublicClient;
  diamond: Address;
  scannedEventNames: Iterable<string>;
  /** Block to pin the reads to — the scan's upper bound, so the row
   *  can never be AHEAD of what the ingest pass processed. */
  blockNumber: bigint;
  /** The chain head the scan was bounded by — refreshes are skipped
   *  while the cursor is still far behind it (see NEAR_HEAD_BLOCKS). */
  headBlock: bigint;
}): Promise<void> {
  let saw = false;
  for (const n of opts.scannedEventNames) {
    if (isConfigEventName(n)) {
      saw = true;
      break;
    }
  }
  try {
    // Catch-up scans read historic state — never stamp those fresh.
    // But a catch-up window can still CONTAIN a governance event, and
    // dropping that signal would let the pre-change row keep serving
    // as fresh through the whole backstop window once the cursor
    // reaches head (Codex #1231 r2): stale-mark so clients refuse the
    // row now and the first near-head scan refreshes promptly.
    if (opts.headBlock - opts.blockNumber > NEAR_HEAD_BLOCKS) {
      if (saw) await markStaleBelow(opts.env, opts.chainId, opts.blockNumber);
      return;
    }
    const row = await opts.env.DB.prepare(
      `SELECT updated_at, grace_buckets_json FROM protocol_config WHERE chain_id = ?`,
    )
      .bind(opts.chainId)
      .first<{ updated_at: number; grace_buckets_json: string | null }>();
    const now = Math.floor(Date.now() / 1000);
    // #1213 PR 2 (Codex #1298 r3) — a fresh pre-0039 row has
    // `grace_buckets_json IS NULL`, and the calendar sweep would fall
    // back to the DEFAULT schedule until the 6h backstop — wrong on a
    // chain where governance buckets are set. Force the read once so
    // the column is populated on the first near-head tick after the
    // migration lands (after which it is always non-null: the read
    // stores '[]' for the no-buckets state).
    const graceColumnUnpopulated = row !== null && row.grace_buckets_json === null;
    if (
      !graceColumnUnpopulated &&
      !shouldRefreshConfig({
        sawConfigEvent: saw,
        rowUpdatedAt: row?.updated_at ?? null,
        nowSec: now,
      })
    ) {
      return;
    }

    const [bundle, flags, graceBuckets] = await Promise.all([
      opts.client.readContract({
        address: opts.diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getProtocolConfigBundle',
        blockNumber: opts.blockNumber,
      }) as Promise<readonly unknown[]>,
      opts.client.readContract({
        address: opts.diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getMasterFlags',
        blockNumber: opts.blockNumber,
      }) as Promise<readonly [boolean, boolean, boolean]>,
      // #1213 PR 2 (Codex #1298 r1) — the effective governance grace
      // buckets. Not part of the bundle tuple; the calendar sweep derives
      // grace windows from this snapshot column (empty array = the
      // compile-time default schedule, the retail deploy's state). The
      // refresh already triggers on `GraceBucketsUpdated`.
      //
      // Isolated failure handling (Codex #1298 r3): this one read must
      // never sink the bundle/flags refresh.
      //   - MISSING SELECTOR (a deployed diamond that predates the
      //     getter): the getter and setter ship in the same ConfigFacet
      //     cut, so no getter ⇒ no setter ⇒ buckets cannot be set ⇒ the
      //     empty array is DEFINITIVE, not a guess.
      //   - any other (transient) failure: `null` → the upsert PRESERVES
      //     the existing column (COALESCE below) rather than clobbering
      //     real buckets with '[]'; if the column was never populated it
      //     stays NULL and the unpopulated-column force-refresh retries
      //     next tick.
      (
        opts.client.readContract({
          address: opts.diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getGraceBuckets',
          blockNumber: opts.blockNumber,
        }) as Promise<readonly { maxDurationDays: bigint; graceSeconds: bigint }[]>
      ).catch((err: unknown) => {
        // The Diamond's fallback reverts `FunctionDoesNotExist()`
        // (selector 0xa9ad62f8) for an uncut selector — match the
        // decoded name AND the raw selector, exactly like alpha02's
        // shared `isMissingSelectorError` does, plus viem's generic
        // wordings (Codex #1298 r4: the spaced-string-only matcher
        // missed the repo's own error, so a pre-getter diamond fell
        // into the transient branch and re-forced the three config
        // reads on every near-head scan forever).
        const raw = (err as { data?: unknown })?.data;
        const msg = `${typeof raw === 'string' ? raw : ''} ${String(err)}`;
        if (
          /function.*(does not exist|not found)|FunctionNotFound|FunctionDoesNotExist|0xa9ad62f8/i.test(
            msg,
          )
        ) {
          return [] as const; // pre-getter diamond — definitively no buckets
        }
        // eslint-disable-next-line no-console
        console.error(
          `[configSnapshot] getGraceBuckets read failed for chain ${opts.chainId} (keeping previous value)`,
          err,
        );
        return null;
      }),
    ]);

    await opts.env.DB.prepare(
      `INSERT INTO protocol_config
         (chain_id, bundle_json, master_flags_json, grace_buckets_json, source_block, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (chain_id) DO UPDATE SET
         bundle_json = excluded.bundle_json,
         master_flags_json = excluded.master_flags_json,
         grace_buckets_json = COALESCE(excluded.grace_buckets_json, protocol_config.grace_buckets_json),
         source_block = excluded.source_block,
         updated_at = excluded.updated_at
       WHERE excluded.source_block >= protocol_config.source_block`,
    )
      .bind(
        opts.chainId,
        serializeTuple(bundle),
        JSON.stringify([flags[0], flags[1], flags[2]]),
        graceBuckets === null ? null : serializeTuple(graceBuckets),
        Number(opts.blockNumber),
        now,
      )
      .run();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[configSnapshot] refresh failed for chain ${opts.chainId} (fail-open)`,
      err,
    );
    // A refresh that failed ON a config event must not leave the old
    // row looking fresh for the whole backstop window (Codex #1231
    // r1): zero its stamp so (a) clients refuse it and fall back to
    // chain, and (b) the next scan's backstop check retries promptly.
    if (saw) {
      try {
        await markStaleBelow(opts.env, opts.chainId, opts.blockNumber);
      } catch {
        /* stale-marking is best-effort */
      }
    }
  }
}

/** GET /config/:chainId — the display snapshot. `available: false` when
 *  the chain has no row yet (apps fall back to their chain read). */
export async function handleConfigSnapshot(
  chainId: number,
  env: Env,
): Promise<Response> {
  try {
    const row = await env.DB.prepare(
      `SELECT bundle_json, master_flags_json, source_block, updated_at
       FROM protocol_config WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{
        bundle_json: string;
        master_flags_json: string;
        source_block: number;
        updated_at: number;
      }>();
    if (!row) return jsonResponse({ chainId, available: false });
    return jsonResponse({
      chainId,
      available: true,
      bundle: JSON.parse(row.bundle_json) as unknown[],
      masterFlags: JSON.parse(row.master_flags_json) as boolean[],
      sourceBlock: row.source_block,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[configSnapshot] route failed', err);
    return jsonResponse({ error: 'config-failed' }, 500);
  }
}
