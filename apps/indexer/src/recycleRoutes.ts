/**
 * M5 (#1218 / #1349) — recycling transparency read surface
 * (docs/DesignsAndPlans/VpfiRecyclingCompletionPlan.md §M5;
 *  figures ratified in VpfiRecyclingBalanceGovernorDesign.md §9).
 *
 * GET /metrics/recycling?chainId=&days=
 *
 * Serves the per-day recycling series the public dashboard reads:
 *
 *   scheduleFloor[D], recycledBudget[D]      — the day's pool, as stamped
 *   absorbed[D] = local + mirror             — global credit for the day
 *   freshDrawdown[D]                         — the schedule floor actually
 *                                              drawn; `netEmission` maps to
 *                                              exactly this
 *   selfFundingRatio[D] = recycledBudget / dailyPool
 *
 * ── Three ways this endpoint refuses to publish a misleading number ──
 *
 * 1. **Unstamped days serve `null`, never `0`.** A day accrues absorption
 *    long before it is finalized, so a row can hold real absorbed figures
 *    with no pool at all. Emitting `0` for the pool would be
 *    indistinguishable from a genuine zero — the exact defect #1487 fixed
 *    for the absorption term, so reintroducing it here would be
 *    self-defeating.
 *
 * 2. **Unarmed days are marked `estimate` and carry no `netEmission`.**
 *    Before the governor is armed nothing reserves against the day's
 *    figures: claim pricing reads an uncapped half while the stamp records
 *    a capped one. The numbers are still worth showing — they are the
 *    schedule the programme is running — but publishing them AS net
 *    emission would overstate, in the flattering direction. That is what
 *    the event's `armed` field exists to prevent, so the wire format
 *    withholds the derived figure rather than trusting every consumer to
 *    check a flag.
 *
 * 3. **The GLOBAL aggregate is published only for a finalized day.** A
 *    day's cross-chain reports arrive one at a time and before the day is
 *    stamped, so an unstamped day holds *some* mirrors' credits — summing
 *    them yields a plausible partial figure wearing a global label. Both
 *    components are always published; the sum is withheld until the day
 *    is finalized. This is also what makes the endpoint correct on a
 *    MIRROR deployment without asking which chain is canonical: a mirror
 *    never stamps a day, so it never publishes a global figure, and it
 *    keeps reporting the local absorption it genuinely observes. Deciding
 *    by the deployment's current role instead would erase a demoted
 *    chain's history — the mistake #1487 was corrected for.
 *
 * 4. **No days before coverage begins.** The dense window starts at the
 *    first day actually observed, never at `today − days`. Synthesising
 *    unstamped zero buckets in front of the first observation would make
 *    "not indexed yet" indistinguishable from "quiet", which is the very
 *    distinction the dense series exists to draw.
 *
 * 5. **No claim about day 0's provenance.** On a deployment upgraded in
 *    place, credits taken before the split are already inside day 0 and
 *    nothing separates them. Which contract version a chain runs is
 *    DEPLOYMENT PROVENANCE, not something the event stream carries — and
 *    the tempting inference ("this chain emitted a pre-launch event, so it
 *    has the split") is false on the ordinary case of a fresh deployment
 *    that simply took no credits before launch (Codex #1508 r3 P2). So no
 *    flag is published in either direction: a wrong one is worse than none
 *    here. `absorbedPreLaunch` reports what IS observed.
 *
 * 6. **No calendar dates.** Days are reported by their reward `dayId`
 *    only. Mapping those to dates needs `interactionLaunchTimestamp`, and
 *    embedding it here would make this endpoint a second authority on
 *    where day boundaries fall — the precise conflation the 0045 migration
 *    warns about, since reward days do not roll at UTC midnight.
 *
 * Amounts are wei decimal strings; ratios are numbers with 6-dp precision
 * computed in BigInt. Reads are open-CORS like every other indexer read.
 */

import { createPublicClient, http, type Address } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import {
  InteractionRewardsLensFacetABI,
  RewardAggregatorFacetABI,
} from '@vaipakam/contracts/abis';

import type { Env } from './env';
import { getChainConfigs } from './env';
import { DO_PATH_CADENCE_MINUTES } from './cronRouting';
import { jsonResponse } from './offerRoutes';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/**
 * Trailing smoothing window `W`, in reward days.
 *
 * MUST match the protocol's own `RECYCLE_TRAILING_WINDOW_DAYS = 7`
 * (`LibVaipakam.sol`; governor design §"smoothing window", a compile-time
 * constant deliberately not a knob). An earlier version of this file used
 * 30, which made the published runway a different metric from the ratified
 * one — same name, different denominator — and delayed the self-funded
 * terminal state (Codex #1507 r3 P2). A dashboard figure that quietly
 * disagrees with the protocol's own is worse than no figure.
 */
const RUNWAY_WINDOW_DAYS = 7;

/**
 * The retained-reserve figure, read LIVE from the chain.
 *
 * Every other figure this route serves comes from stored counters, and a
 * counter cannot notice that the tokens behind it have left. The ratified
 * requirement is therefore that the reserve is published ALONGSIDE the
 * balance actually held, so a reader can tell whether the tokens backing
 * the reported reserve exist at all — the difference between a healthy
 * deployment and a corrupted one, and unreadable from D1 by construction.
 *
 * The read is live because there is no honest cached version of it: a
 * stale balance is exactly the failure the figure exists to expose.
 *
 * WITHHELD, NEVER GUESSED. If the RPC read fails, every field is null and
 * `unavailableReason` says why. It must not fall back to zeros (a zero
 * reserve and an unreadable one are opposite claims) and must not be
 * derived from the counters this route already holds — a counter-derived
 * reserve with no balance beside it is precisely what the requirement
 * exists to prevent. A failure here also must not fail the ROUTE: the
 * day series is D1-derived and remains true regardless.
 */
/**
 * FIXED reason codes, never underlying error text.
 *
 * A public, open-CORS body must not carry an operator's error detail:
 * transport errors embed the RPC URL and this repository's RPC URLs carry
 * provider API keys. Detail goes to the log; the caller gets a code.
 */
type BackingReason =
  | 'not-captured-yet'
  | 'read-failed'
  | 'snapshot-stale'
  | 'chain-behind';

interface BackingSnapshot {
  vpfiBalance: string | null;
  bucket: string | null;
  unearmarked: string | null;
  outstandingRecycled: string | null;
  paidOutRecycled: string | null;
  keeperBudget: string | null;
  platformRetained: string | null;
  /** The block both pinned reads observed, so the figures are
   *  reproducible by anyone once the chain has moved on. */
  blockNumber: string | null;
  /**
   * Value that LEFT the bucket and is stranded in transport.
   *
   * `restoreReleasedRemit` puts the commitment back into
   * `outstandingCommitRecycled` WITHOUT re-crediting `recycleBucket`, so
   * `platformRetained` falls by that amount and can floor to zero while
   * the value is neither lost nor spent — merely in flight. Without this
   * term beside it, a stranded remittance renders as a depleted platform
   * reserve, which the lens natspec warns about in as many words.
   */
  releasedRemitStranded: string | null;
  unavailableReason: BackingReason | null;
  asOf: string | null;
}

const BACKING_UNAVAILABLE = (reason: BackingReason): BackingSnapshot => ({
  vpfiBalance: null,
  bucket: null,
  unearmarked: null,
  outstandingRecycled: null,
  paidOutRecycled: null,
  keeperBudget: null,
  platformRetained: null,
  releasedRemitStranded: null,
  blockNumber: null,
  unavailableReason: reason,
  asOf: null,
});

/**
 * `platformRetained = bucket − outstandingRecycled − keeperBudget`, floored
 * at zero (ratified; TokenomicsTechSpec + plan §M5).
 *
 * The keeper term is why deriving from `getRecycleBucket` alone is wrong:
 * once `recycleRegisterKeeperBps` is non-zero, each day's margin is
 * earmarked into `recycleKeeperBudget` from INSIDE the bucket, so the
 * bucket does not move and a reserve computed without it overstates for as
 * long as the register runs.
 *
 * The floor is not cosmetic: the subtraction goes negative in the breached
 * state, and a negative reserve on a public page reads as a display bug
 * rather than as the shortfall it is. The balance published beside it is
 * what makes that state visible instead.
 */
export function retainedFrom(bucket: bigint, outstanding: bigint, keeper: bigint): bigint {
  const net = bucket - outstanding - keeper;
  return net > 0n ? net : 0n;
}


/**
 * The browser aborts the whole `/metrics/recycling` request at 4s, so an
 * unbounded read here does not fail gracefully — it takes the D1-derived
 * day series down with it, which is the containment this block claims to
 * have. viem's default is a 10s timeout WITH retries, comfortably past
 * that, so the bound has to be set explicitly and retries disabled.
 */
const BACKING_RPC_TIMEOUT_MS = 2500;

/**
 * Capture the backing snapshot from the chain. Called on the SCHEDULED
 * path only — never from a request.
 *
 * Everything the request path used to need for this — a deadline inside
 * the browser's abort, request coalescing, a cross-isolate cache, a
 * per-joiner budget — existed solely because a chain call sat inside a
 * public HTTP handler. None of it is needed here: the scheduled pass has
 * its own budget, runs once a minute, and is already where chain reads
 * are accounted for.
 */
export async function captureBackingSnapshot(
  env: Env,
  chainId: number,
): Promise<void> {
  // Recorded WITH the row: the cadence that produced it.
  const chainCount = (() => {
    try {
      return Math.max(1, getChainConfigs(env).length);
    } catch {
      return 1;
    }
  })();
  let chain;
  try {
    chain = getChainConfigs(env).find((c) => c.id === chainId);
  } catch {
    chain = undefined;
  }
  if (!chain?.rpc) return;

  const client = createPublicClient({
    // No retry: a retry doubles this capture's subrequest count inside an
    // invocation whose budget the ingest pass already reserves most of.
    // A missed capture is picked up on the chain's next turn.
    transport: http(chain.rpc, { timeout: 10_000, retryCount: 0 }),
  });
  // Identity BEFORE trust: a secret pointed at the wrong network still
  // answers, and a fork or a matching deterministic address would store
  // another chain's reserve under this chain's id.
  // SAFE head, not `latest`. Pinning to the unsafe tip means a 1-32 block
  // reorg leaves the stored amounts describing an ORPHANED block while the
  // published block number now resolves to different canonical state — so
  // the snapshot stops being reproducible by the reader it was published
  // for, and can serve an obsolete verdict for the whole staleness window.
  // `chainIndexer` already avoids exactly this, with the same fallback for
  // RPCs that do not support the safe tag.
  const [observedChainId, head] = await Promise.all([
    client.getChainId(),
    (async () => {
      try {
        const b = await client.getBlock({ blockTag: 'safe' });
        return { number: b.number, timestamp: b.timestamp };
      } catch {
        const latest = await client.getBlockNumber();
        const number =
          latest > SAFE_FALLBACK_BUFFER ? latest - SAFE_FALLBACK_BUFFER : 0n;
        const b = await client.getBlock({ blockNumber: number });
        return { number, timestamp: b.timestamp };
      }
    })(),
  ]);
  const blockNumber = head.number;
  if (observedChainId !== chainId) {
    console.warn(
      `[recycling] RPC for chain ${chainId} reports ${observedChainId}; not storing backing`,
    );
    return;
  }
  // PINNED TO ONE BLOCK. These two reads explain each other — the second
  // is what stops a released remittance rendering as a depleted reserve —
  // so they have to describe the same moment.
  const [snap, composition] = await Promise.all([
    client.readContract({
      address: chain.diamond as Address,
      abi: InteractionRewardsLensFacetABI,
      functionName: 'getRecycleBackingSnapshot',
      blockNumber,
    }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>,
    client.readContract({
      address: chain.diamond as Address,
      abi: RewardAggregatorFacetABI,
      functionName: 'getRecycleCompositionPosition',
      blockNumber,
    }) as Promise<readonly [bigint, bigint, boolean, boolean]>,
  ]);
  const [vpfiBalance, bucket, unearmarked, outstanding, paidOut, keeper] = snap;
  const payload = {
    vpfiBalance: vpfiBalance.toString(),
    bucket: bucket.toString(),
    unearmarked: unearmarked.toString(),
    outstandingRecycled: outstanding.toString(),
    paidOutRecycled: paidOut.toString(),
    keeperBudget: keeper.toString(),
    platformRetained: retainedFrom(bucket, outstanding, keeper).toString(),
    releasedRemitStranded: composition[1].toString(),
  };
  await env.DB.prepare(
    `INSERT INTO recycle_backing_snapshot
       (chain_id, payload, observed_at, block_time, block_number, chain_count)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(chain_id) DO UPDATE SET
       payload = excluded.payload,
       observed_at = excluded.observed_at,
       block_time = excluded.block_time,
       block_number = excluded.block_number,
       chain_count = excluded.chain_count`,
  )
    .bind(
      chainId,
      JSON.stringify(payload),
      new Date().toISOString(),
      new Date(Number(head.timestamp) * 1000).toISOString(),
      blockNumber.toString(),
      chainCount,
    )
    .run();
}

/**
 * Serve the stored snapshot. NO network I/O.
 *
 * `asOf` is the capture time, and the surface renders its age — a figure
 * whose currency the reader can judge is a different object from one they
 * are asked to trust.
 */
/**
 * How old a stored snapshot may be before it is withheld.
 *
 * DERIVED from the refresh cadence, not a fixed number. Captures are
 * round-robin — one chain per executed tick — so a chain's own refresh
 * interval is `chains × tick`. A fixed 30 minutes silently became
 * UNSATISFIABLE past six chains on the DO path (7 × 5 = 35 > 30), which
 * would have marked every healthy chain stale for five minutes of every
 * cycle, and the bindings already support eleven.
 *
 * Two full cycles: one missed turn is a blip, not a wedged capture.
 */
const SNAPSHOT_MIN_MAX_AGE_MS = 30 * 60_000;

function snapshotMaxAgeMs(env: Env, chainCount: number): number {
  const chains = Math.max(1, chainCount);
  // The FLAG only — the route's `Env` does not carry the DO binding that
  // `doIngestEnabled` also checks. The asymmetry is safe in one direction
  // and that is why it is acceptable: flag set but binding absent means
  // ingest actually falls back to the 1-minute path, so the real refresh
  // cadence is FASTER than assumed and this expiry is merely more
  // generous than it needed to be. The reverse — assuming fast while the
  // slow path runs — is what would mark healthy snapshots stale, and
  // cannot happen here.
  const tickMinutes =
    env.CHAIN_INGEST_VIA_DO === 'true' ? DO_PATH_CADENCE_MINUTES : 1;
  return Math.max(SNAPSHOT_MIN_MAX_AGE_MS, chains * tickMinutes * 2 * 60_000);
}

/** Mirrors `chainIndexer`'s buffer for RPCs without a `safe` tag. */
const SAFE_FALLBACK_BUFFER = 32n;

/**
 * How far the safe head may trail the wall clock before the CHAIN, rather
 * than the schedule, is treated as the problem.
 *
 * Finality lag plus the 32-block fallback is minutes on the chains in
 * scope; an RPC frozen for half an hour is not lag.
 */
const MAX_BLOCK_LAG_MS = 30 * 60_000;

async function readBacking(env: Env, chainId: number): Promise<BackingSnapshot> {
  try {
    const row = await env.DB.prepare(
      `SELECT payload, observed_at, block_time, block_number, chain_count
         FROM recycle_backing_snapshot WHERE chain_id = ?1`,
    )
      .bind(chainId)
      .first<{
        payload: string;
        observed_at: string;
        block_time: string;
        block_number: string;
        chain_count: number;
      }>();
    if (!row) return BACKING_UNAVAILABLE('not-captured-yet');

    // Has the SCHEDULE kept up? Measured against observation time and the
    // cadence THIS ROW was captured under — not the chain set readable on
    // this request, which a transient secrets failure can shrink.
    const observedAge = Date.now() - Date.parse(row.observed_at);
    if (
      !Number.isFinite(observedAge) ||
      observedAge > snapshotMaxAgeMs(env, row.chain_count)
    ) {
      return BACKING_UNAVAILABLE('snapshot-stale');
    }
    // Is the CHAIN still moving? A frozen RPC answers happily with an old
    // head, and the schedule check cannot see that at all.
    const blockLag = Date.parse(row.observed_at) - Date.parse(row.block_time);
    if (!Number.isFinite(blockLag) || blockLag > MAX_BLOCK_LAG_MS) {
      return BACKING_UNAVAILABLE('chain-behind');
    }
    return {
      ...(JSON.parse(row.payload) as Omit<
        BackingSnapshot,
        'unavailableReason' | 'asOf' | 'blockNumber'
      >),
      // The BLOCK, not just the time. A timestamp does not identify which
      // state was read, so an independent reader could not reproduce these
      // figures once the chain moved on — and the ratified requirement is
      // that the series be reconstructible without trusting this indexer.
      blockNumber: row.block_number,
      unavailableReason: null,
      // The BLOCK's time is what these figures describe, so it is what the
      // surface shows — the observation time is bookkeeping about the
      // schedule, not about the state being reported.
      asOf: row.block_time,
    };
  } catch (err) {
    console.warn(`[recycling] backing snapshot read failed: ${String(err)}`);
    return BACKING_UNAVAILABLE('read-failed');
  }
}

/**
 * This route must never be cached. The shared `jsonResponse` sets
 * `Cache-Control: public, max-age=10`, and a replayed `vpfiBalance` can
 * briefly conceal the very backing loss the live read exists to expose —
 * the figure would be stale exactly when it matters.
 */
function liveJsonResponse(body: unknown, status = 200): Response {
  const res = jsonResponse(body, status);
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

function parseChainId(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDays(raw: string | null): number {
  if (!raw) return DEFAULT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

/** 6-dp ratio from BigInt numerator/denominator; null when den == 0. */
function ratio6(num: bigint, den: bigint): number | null {
  if (den === 0n) return null;
  return Number((num * 1_000_000n) / den) / 1_000_000;
}

interface PoolRow {
  day_id: number;
  stamped: number;
  schedule_floor: string;
  recycled_budget: string;
  a_bar: string;
  margin_bps: number;
  fresh_drawdown: string;
  armed: number;
  absorbed_local: string;
  absorbed_mirror: string;
}

/**
 * A day as the rest of this handler sees it, whatever produced it.
 *
 * `a_bar` / `margin_bps` are nullable HERE and not on the event row: the
 * event carries both, the getter behind a backfilled day returns neither.
 * The merged shape has to admit that absence, or the merge would have to
 * invent a zero — and a zero margin is a real, different thing.
 */
interface MergedDay extends Omit<PoolRow, 'a_bar' | 'margin_bps'> {
  a_bar: string | null;
  margin_bps: number | null;
  origin: 'event' | 'backfill';
  /**
   * What the BACKFILL SNAPSHOT itself held for cross-chain absorption,
   * kept separate from `absorbed_mirror` because the merge can raise that
   * from a delayed report. Only the snapshot's own contribution is
   * undecomposable; a credit that arrived by event is reconcilable per
   * source (#1513 r6).
   */
  snapshot_mirror?: bigint;
}

export async function handleRecyclingSeries(
  req: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const days = parseDays(url.searchParams.get('days'));

  try {
    // The window is the last `days` REWARD days present for this chain.
    // Anchoring on the highest stored day rather than on wall-clock time
    // keeps this endpoint free of the launch timestamp (see the header):
    // the series describes protocol days, and the newest one it knows
    // about is the newest one there is.
    // Read BEFORE the empty-series branch below (Codex #1508 r2 P2). A
    // chain that has only ever taken pre-launch credits — the NORMAL state
    // before the schedule starts — has no day rows at all, so reading this
    // afterwards would report zero for exactly the period the figure exists
    // to describe, until some unrelated scheduled event created the first
    // day row.
    const preLaunchRow = await env.DB.prepare(
      `SELECT absorbed FROM recycle_prelaunch WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{ absorbed: string }>();
    const preLaunch = preLaunchRow?.absorbed ?? '0';

    // Coverage spans BOTH sources. The backfill exists precisely to supply
    // days EARLIER than the event stream reaches, so a boundary computed
    // from the event table alone would put every backfilled day outside the
    // window and serve none of them — the union would be silently inert.
    const headSql = (withBackfill: boolean) =>
      `SELECT MAX(day_id) AS max_day, MIN(day_id) AS min_day FROM (
         SELECT day_id FROM recycle_day_pool WHERE chain_id = ?1` +
      (withBackfill
        ? `
         UNION ALL
         SELECT day_id FROM recycle_day_backfill WHERE chain_id = ?1`
        : '') +
      `
       )`;
    const head = await env.DB.prepare(headSql(true))
      .bind(chainId)
      .first<{ max_day: number | null; min_day: number | null }>()
      .catch((err: unknown) => {
        // Same pre-migration window as the merge below.
        if (!/no such table/i.test(String(err))) throw err;
        return env.DB.prepare(headSql(false))
          .bind(chainId)
          .first<{ max_day: number | null; min_day: number | null }>();
      });

    const maxDay = head?.max_day ?? null;
    if (maxDay === null) {
      return liveJsonResponse({
        chainId,
        days,
        fromDay: null,
        toDay: null,
        daily: [],
        scope: 'empty',
        coverageFromDay: null,
        cumulative: {
          absorbed: '0',
          absorbedPreLaunch: preLaunch,
          absorbedLocal: '0',
          absorbedMirror: '0',
          freshDrawdown: '0',
          recycledBudget: '0',
          runwayExtensionDays: null,
          runwayUnavailableReason: 'no-armed-finalized-days',
          // Present with the same shape as every non-empty response, so a
          // dashboard's no-data state does not need a special case to tell
          // "not self-funded" from "field absent" (Codex #1507 r1 P2).
          selfFunded: false,
        },
        // The SAME rule the comment above states, which this block was
        // missing: a fresh or pre-launch deployment has no day rows but
        // can absolutely hold a recycled reserve, and omitting the field
        // makes a current indexer indistinguishable from one too old to
        // serve it — so the page withheld a readable reserve until an
        // unrelated day row happened to appear.
        backing: await readBacking(env, chainId),
      });
    }

    // Clamp the window to where this consumer's observations actually
    // begin (Codex #1507 r1 P1). `maxDay - days + 1` can precede the first
    // event ever recorded — on a consumer deployed mid-programme it always
    // does — and filling that gap with unstamped zero rows publishes
    // "quiet" where the truth is "not indexed". `coverageFromDay` is
    // reported so a consumer can see the boundary rather than infer it.
    const coverageFromDay = head?.min_day ?? maxDay;
    const cutoff = Math.max(coverageFromDay, maxDay - days + 1);

    // Projection readiness is read FIRST, before the attribution rows
    // (Codex #1513 r9). The rebuild writes the version LAST, so observing
    // version 2 here guarantees the rows fetched afterwards are complete.
    // Reading it after them inverts that: a concurrent first post-migration
    // scan can populate everything and commit the version in between, so
    // the request holds stale zeroes AND sees version 2 — publishing the
    // exact inflated runway the gate exists to suppress.
    const projectionState = await env.DB.prepare(
      `SELECT projection_version FROM recycle_series_state WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{ projection_version: number }>()
      .catch(() => null);

    // ── ONE merged view of the days, consumed by BOTH the lifetime fold
    // and the windowed series.
    //
    // Three times in this change I added a source and updated only one of
    // its readers: the coverage boundary, then the lifetime aggregates,
    // then the restore converter. The first two are the same defect, so
    // the merge happens ONCE here and every consumer reads its result —
    // there is no longer a "the other place that also reads days" to
    // forget. EVENT PRECEDENCE lives in this merge and nowhere else.
    //
    // Read lifetime-wide, not window-scoped: a cumulative that moved when
    // a caller changed `days` would be reporting the query rather than the
    // programme. The window is applied afterwards, to the merged result.
    const [poolAll, backfillAll, reportedRows] = await Promise.all([
      env.DB.prepare(
        `SELECT day_id, stamped, schedule_floor, recycled_budget, a_bar,
                margin_bps, fresh_drawdown, armed,
                absorbed_local, absorbed_mirror
           FROM recycle_day_pool WHERE chain_id = ?`,
      )
        .bind(chainId)
        .all<PoolRow>(),
      // Tolerates the table not existing yet (Codex #1513 r1 P2). Every
      // deploy script runs `wrangler deploy` BEFORE
      // `wrangler d1 migrations apply`, so on the rollout that introduces
      // 0047 the new Worker serves requests against a database that does
      // not have this table for as long as the migration takes — and if
      // the migration fails, indefinitely. An unconditional join would
      // 500 the whole endpoint over an ADDITIVE change, which is a worse
      // outcome than briefly serving the event-only series it served
      // yesterday. Only "no such table" is swallowed; anything else is a
      // real fault and propagates.
      env.DB.prepare(
        `SELECT day_id, stamped, schedule_floor, recycled_budget,
                fresh_drawdown, armed, absorbed_local, absorbed_mirror
           FROM recycle_day_backfill WHERE chain_id = ?`,
      )
        .bind(chainId)
        .all<Omit<PoolRow, 'a_bar' | 'margin_bps'>>()
        .catch((err: unknown) => {
          if (!/no such table/i.test(String(err))) throw err;
          return { results: [] as Array<Omit<PoolRow, 'a_bar' | 'margin_bps'>> };
        }),
      // Same rollout window as the backfill query below: every deploy
      // script deploys the Worker BEFORE applying migrations, so pre-0047
      // this table exists WITHOUT `attributed_cumulative` and an uncaught
      // `no such column` rejects the whole `Promise.all` — a 500 for the
      // length of the rollout, and indefinitely if the migration fails
      // (Codex #1513 r5 P2). I made the sibling query tolerant and left
      // this one, in the same expression.
      env.DB.prepare(
        `SELECT source_chain_id, reported_cumulative, attributed_cumulative
           FROM recycle_chain_reported WHERE chain_id = ?`,
      )
        .bind(chainId)
        .all<{
          source_chain_id: number;
          reported_cumulative: string;
          attributed_cumulative: string;
        }>()
        .catch((err: unknown) => {
          if (!/no such (column|table)/i.test(String(err))) throw err;
          return env.DB.prepare(
            `SELECT source_chain_id, reported_cumulative
               FROM recycle_chain_reported WHERE chain_id = ?`,
          )
            .bind(chainId)
            .all<{ source_chain_id: number; reported_cumulative: string }>()
            .then((r) => ({
              // `attributionUnavailable`, NOT a zero. Substituting zero
              // makes `mirrorUnreported` equal the ENTIRE fold, which is
              // then added to the source's full reported cumulative — a
              // knowingly double-counted runway published during the
              // rollout (Codex #1513 r6). The runway is withheld instead.
              attributionColumnMissing: true,
              results: (r.results ?? []).map((x) => ({
                ...x,
                attributed_cumulative: '0',
              })),
            }))
            .catch((e: unknown) => {
              if (!/no such table/i.test(String(e))) throw e;
              // A MISSING TABLE is not the 0047 rollout shape — that window
              // has the table without one column. This is the table gone:
              // data loss, or a partial restore. Treating it as "no reports
              // exist" publishes a runway built only from the accepted day
              // fold, silently omitting every mirror's reported-only
              // lifetime stock (pre-launch, clamped credits). Mark it
              // unavailable and withhold (Codex #1513 r7).
              return {
                attributionTableMissing: true,
                results: [] as Array<{
                  source_chain_id: number;
                  reported_cumulative: string;
                  attributed_cumulative: string;
                }>,
              };
            });
        }),
    ]);

    const merged = new Map<number, MergedDay>();
    // Backfill first, event second: the event overwrites where both
    // describe a day. It is immutable, while the backfill recomputes from
    // `dayCapThreshold18`, which a second writer can overwrite for an
    // already-finalized day on a demoted Diamond.
    for (const b of backfillAll.results ?? []) {
      merged.set(b.day_id, {
        ...b,
        // The getter returns neither, so a backfilled day genuinely does
        // not know them. NULL, not 0 — a zero margin is a real, different
        // thing, and this surface has been bitten by that ambiguity twice.
        a_bar: null,
        margin_bps: null,
        origin: 'backfill',
        snapshot_mirror: BigInt(b.absorbed_mirror),
      });
    }
    for (const r of poolAll.results ?? []) {
      // An UNSTAMPED event row must not displace a stamped backfill row —
      // it carries absorption but no pool, and the backfill is what knows
      // the pool for a pre-cutover day. It must not be ADDED to it either
      // (Codex #1513 r2 P1): the backfill's absorption comes from the LIVE
      // on-chain accumulators, which already include every historical
      // credit those same event rows folded. Summing them double-counts.
      //
      // The snapshot is authoritative and complete for a past day, not
      // merely preferred: local credits always land on the CURRENT day, and
      // the ingress refuses a mirror report for an already-finalized day —
      // so no new absorption can arrive for a day the backfill has covered.
      // My round-1 version merged the two, fixing a case that cannot occur
      // and creating one that can.
      const existing = merged.get(r.day_id);
      if (r.stamped !== 1 && existing?.origin === 'backfill') {
        // Component MAXIMA, never a sum, and unconditionally.
        //
        // Adding the two double-counts: the backfill snapshot reads the
        // live on-chain accumulators, which already include every credit
        // the event rows folded. That was this PR's r2 defect.
        //
        // On an UNSTAMPED day the snapshot can also be STALE — a delayed
        // mirror report is still accepted for a day that never finalized,
        // so the fold may carry more than the pinned capture saw (r4).
        //
        // On a stamped day the snapshot is provably complete (local credits
        // land on the current day; a late report for a finalized day is
        // refused at the ingress), so the fold cannot exceed it and the
        // maximum simply returns the snapshot. Gating the maximum on
        // `stamped` therefore distinguishes nothing any input can produce —
        // a branch no test can kill is a guarantee in a comment, and this
        // PR has already deleted one of those.
        const maxOf = (a: string, b: string) =>
          (BigInt(a) > BigInt(b) ? BigInt(a) : BigInt(b)).toString();
        merged.set(r.day_id, {
          ...existing,
          absorbed_local: maxOf(existing.absorbed_local, r.absorbed_local),
          absorbed_mirror: maxOf(existing.absorbed_mirror, r.absorbed_mirror),
        });
        continue;
      }
      merged.set(r.day_id, { ...r, origin: 'event' });
    }

    let cumAbsorbed = 0n;
    let cumAbsorbedLocal = 0n;
    let cumAbsorbedMirror = 0n;
    let cumFreshDrawdown = 0n;
    let cumRecycledBudget = 0n;
    let anyStamped = false;
    for (const r of merged.values()) {
      cumAbsorbedLocal += BigInt(r.absorbed_local);
      cumAbsorbedMirror += BigInt(r.absorbed_mirror);
      // The GLOBAL absorption total sums only FINALIZED days. An unstamped
      // day holds whichever cross-chain reports have arrived so far, so
      // folding it in would put a partial figure inside a total labelled
      // global — and a lifetime total is exactly where a partial value
      // stops being recognisable as one. The two components above are
      // unconditional, so nothing observed is hidden.
      if (r.stamped !== 1) continue;
      anyStamped = true;
      cumAbsorbed += BigInt(r.absorbed_local) + BigInt(r.absorbed_mirror);
      // Only ARMED, stamped days contribute to the emission and budget
      // cumulatives — an unarmed day's figures are estimates nothing
      // reserved, and summing them would launder that straight into a
      // lifetime total where the per-day `estimate` flag cannot follow.
      if (r.armed === 1) {
        cumFreshDrawdown += BigInt(r.fresh_drawdown);
        cumRecycledBudget += BigInt(r.recycled_budget);
      }
    }

    const daily = [];
    const rowsByDay: Map<number, MergedDay> = merged;

    // Event precedence, enforced by READ ORDER rather than by write order.
    //
    // Where the two sources disagree the event is the record: it is
    // immutable, while the backfill recomputes from `dayCapThreshold18`,
    // which a second writer can overwrite for an already-finalized day on a
    // demoted Diamond. Keeping them in separate tables makes "prefer the
    // event" a property of this lookup, which nothing can violate — a
    // single table with a source column would have made it a rule about
    // which write happened last.
    // Dense series: emit EVERY day in the window so a consumer can tell a
    // quiet day from a missing bucket (the same convention RL-2 pins).
    for (let dayId = cutoff; dayId <= maxDay; dayId++) {
      const r = rowsByDay.get(dayId);
      const absorbedLocal = BigInt(r?.absorbed_local ?? '0');
      const absorbedMirror = BigInt(r?.absorbed_mirror ?? '0');
      const stamped = r?.stamped === 1;
      const armed = r?.armed === 1;

      if (!stamped) {
        daily.push({
          dayId,
          stamped: false,
          armed: false,
          estimate: false,
          // A real stored row keeps its provenance. Hardcoding null here
          // made an absorption-only row — from either source — look
          // identical to a synthetic dense-series gap, even though its
          // absorption is published (Codex #1513 r7). `null` is reserved
          // for a day with no stored row at all.
          origin: r?.origin ?? null,
          scheduleFloor: null,
          recycledBudget: null,
          aBar: null,
          marginBps: null,
          freshDrawdown: null,
          netEmission: null,
          selfFundingRatio: null,
          absorbedLocal: absorbedLocal.toString(),
          absorbedMirror: absorbedMirror.toString(),
          // Withheld until the day is finalized: mirrors report one at a
          // time, so this sum would be a partial figure under a global
          // label. On a mirror deployment no day is ever stamped, which
          // is why this endpoint needs no canonical-chain check.
          absorbed: null,
        });
        continue;
      }

      const scheduleFloor = BigInt(r!.schedule_floor);
      const recycledBudget = BigInt(r!.recycled_budget);
      const freshDrawdown = BigInt(r!.fresh_drawdown);
      const dailyPool = scheduleFloor + recycledBudget;

      daily.push({
        dayId,
        stamped: true,
        armed,
        // An unarmed day's pool figures are unreserved estimates. Shown,
        // but labelled, and with the derived emission withheld.
        estimate: !armed,
        origin: r!.origin,
        scheduleFloor: scheduleFloor.toString(),
        recycledBudget: recycledBudget.toString(),
        aBar: r!.a_bar ?? null,
        marginBps: r!.margin_bps ?? null,
        freshDrawdown: freshDrawdown.toString(),
        netEmission: armed ? freshDrawdown.toString() : null,
        selfFundingRatio: ratio6(recycledBudget, dailyPool),
        absorbedLocal: absorbedLocal.toString(),
        absorbedMirror: absorbedMirror.toString(),
        absorbed: (absorbedLocal + absorbedMirror).toString(),
      });
    }

    // Runway (governor §9): cumulative recycled ÷ trailing-window mean of
    // `dailyPool`. Reported as null with `selfFunded: true` once the fresh
    // floor is zero across the window — the design's `∞ / self-funded`
    // terminal form, and NEVER a division by the zeroed floor.
    //
    // The trailing window is FIXED and read independently of `days`
    // (Codex #1507 r1 P2). Deriving it from the display window made a
    // lifetime metric move when a caller changed the range it asked to
    // see — `days=1` computed the mean from a single day — so the same
    // chain state answered differently depending on the question's shape.
    // A cumulative that depends on the query is reporting the query.
    // Anchored on the latest FINALIZED, armed day — not on the highest
    // row of any kind (Codex #1507 r3 P2). `maxDay` moves the moment the
    // next day's first credit arrives, and since the window then excludes
    // that unstamped row it would silently average W-1 days instead of W.
    // The reported lifetime runway would change because a day BEGAN,
    // which is not an event about the trailing window at all.
    let trailingPoolSum = 0n;
    let trailingFloorSum = 0n;
    let trailingCount = 0n;
    // Read from the MERGED view, like everything else (Codex #1513 r2 P1).
    // Round 1 claimed every consumer already did; this block still queried
    // `recycle_day_pool` directly, so a window containing armed BACKFILLED
    // days anchored short or returned null — and a backfill-only dataset
    // had no window at all. Asserting the completeness of a fix is not the
    // same as checking it, and I asserted.
    const armedDays = [...merged.values()]
      .filter((d) => d.stamped === 1 && d.armed === 1)
      .map((d) => d.day_id);
    const anchor = armedDays.length ? Math.max(...armedDays) : null;
    const trailingFrom =
      anchor === null ? 0 : Math.max(0, anchor - RUNWAY_WINDOW_DAYS + 1);
    for (const d of merged.values()) {
      if (anchor === null) break;
      if (d.stamped !== 1 || d.armed !== 1) continue;
      if (d.day_id < trailingFrom || d.day_id > anchor) continue;
      trailingPoolSum += BigInt(d.schedule_floor) + BigInt(d.recycled_budget);
      trailingFloorSum += BigInt(d.schedule_floor);
      trailingCount += 1n;
    }
    const selfFunded = trailingCount > 0n && trailingFloorSum === 0n;
    // The numerator is the LIFETIME recycled stock. Two rounds of getting
    // this wrong in the same direction:
    //
    //   r2 — it used only day-attributed absorption, so this chain's own
    //        pre-launch stock was missing. Keeping that out of `Ā` is a
    //        statement about a trailing RATE and says nothing about a
    //        lifetime total.
    //   r4 — adding only the LOCAL pre-launch stock fixed the single-chain
    //        case and still understated a mesh. A mirror's pre-launch stock
    //        never reaches this indexer (its `VpfiRecycledPreLaunch` is on
    //        its own chain), and its day reports carry only what was
    //        ACCEPTED — bounded by that chain's attribution headroom.
    //
    // So each mirror contributes its own reported LIFETIME cumulative, which
    // counts every credit it ever took, and its accepted day credits are
    // excluded to avoid counting the same value twice.
    // PER SOURCE, then sum (Codex #1513 r4 P1). Taking the maximum of the
    // two SUMS drops a backfill-only mirror whenever another mirror's
    // reported cumulative dominates: mirror A reporting 500 with 100
    // attributed, mirror B present only in the backfilled fold with 200,
    // gives max(500, 300) = 500 when the real stock is at least 700.
    //
    // The merged fold only knows the mirror total per DAY, not per source
    // — `dayMirrorRecycledCredit` is already summed on chain — so the
    // reconciliation is: every reported source contributes its own
    // reported figure, and whatever the fold saw ABOVE the attributed
    // portion of those sources is the part no report accounts for.
    let selfReported = 0n;
    let mirrorReported = 0n;
    let mirrorAttributed = 0n;
    for (const r of reportedRows.results ?? []) {
      if (r.source_chain_id === chainId) {
        selfReported = BigInt(r.reported_cumulative);
        continue;
      }
      // The reported figure, not a max against attribution. On chain,
      // `accepted` is clamped by the source's remaining headroom, so
      // `chainAttributedRecycled <= chainReportedRecycled` is a standing
      // invariant and both figures come from the SAME event — attribution
      // cannot outrun the report this consumer folded it from. A `max`
      // here would be a branch no input can reach, and an unreachable
      // guard reads as a guarantee while testing nothing.
      mirrorReported += BigInt(r.reported_cumulative);
      mirrorAttributed += BigInt(r.attributed_cumulative);
    }

    // The LOCAL term prefers this chain's own self-report when there is one
    // (Codex #1508 r5 P2). The event fold is bounded by this consumer's own
    // coverage — `coverageFromDay` exists precisely because indexing can
    // begin mid-programme — so credits taken before it started watching are
    // missing from it forever. The self-report carries the chain's
    // self-healing `recycleCreditedCumulative`, which counts every credit it
    // ever took, pre-launch included.
    //
    // MAX rather than a straight substitution: a self-report can lag the
    // newest locally observed credits, and a lifetime figure must never go
    // backwards because a report is a few blocks stale.
    const localFold = cumAbsorbedLocal + BigInt(preLaunch);
    const localTerm = selfReported > localFold ? selfReported : localFold;

    // The MIRROR term takes the same max, for the same reason (Codex #1513
    // r3 P1). Backfilled days recover mirror absorption from the getter,
    // but `recycle_chain_reported` only has a row if a self-healing report
    // happened to arrive within this consumer's coverage — so a
    // backfill-only history has a real merged mirror fold and a zero
    // reported total, and taking the reported figure alone drops every
    // recovered credit. Applying the rule to one side and not the other
    // was the same omission twice in one expression.
    // ── The mirror term is REFUSED rather than estimated when a backfilled
    // day contributes cross-chain absorption. Four consecutive review
    // rounds found this figure wrong in a new way, and they were all one
    // problem: the day series' mirror total is summed ACROSS MIRRORS on
    // chain, so a backfilled day cannot be decomposed per source, and no
    // arithmetic over aggregates recovers what the sources were.
    //
    //   r2: the fold left out this chain's own pre-launch stock.
    //   r3: it left out every other chain's.
    //   r4: max(Σ reported, Σ fold) drops a backfill-only mirror whenever
    //       another mirror's reported figure dominates.
    //   r5: max(snapshot, fold) is only valid when one source set CONTAINS
    //       the other — a snapshot holding B's 200 and a fold holding C's
    //       300 really total 500, and the maximum says 300.
    //
    // Each fix was locally right and the next case broke it, because the
    // information needed is not in the data. So the endpoint does what it
    // does everywhere else on this surface and REFUSES: a plausible wrong
    // number is worse than an absent one, and every component it is built
    // from is still published for anyone who wants to reason about it.
    //
    // Exactness is recoverable later — per-source per-day attribution, or
    // pinning the snapshot block and treating later credits as a delta —
    // but that is a change to what the backfill RECORDS, not to how this
    // arithmetic is arranged. Tracked as its own card.
    const mirrorFold = cumAbsorbedMirror;
    // (3) Test what the SNAPSHOT contributed, not the merged row (Codex
    // #1513 r6). An unstamped snapshot that captured zero mirror
    // absorption, later joined by a delayed report, keeps
    // `origin: 'backfill'` while carrying the EVENT's figure — which is
    // fully reconcilable per source. Refusing there contradicts the narrow
    // refusal this is supposed to be.
    const backfilledMirror = [...merged.values()].some(
      (d) => (d.snapshot_mirror ?? 0n) > 0n,
    );
    // Unavailable until the REBUILD has run, not merely until the column
    // exists (Codex #1513 r8). Migration 0047 creates it defaulted to zero,
    // so between the migration landing and the next scan every historical
    // accepted credit reads as unattributed — the whole mirror fold is then
    // added on top of the mirrors' full reported cumulatives and the runway
    // inflates. The projection version is what says the rebuild finished.
    //
    // NARROW, like every other refusal here. A stale rebuild only matters
    // if there is attribution to be stale about: with no reported rows and
    // no mirror fold the mirror term is zero either way. A first draft of
    // this gate withheld unconditionally and took three backfill-only
    // tests down with it — the gate was measuring the rebuild rather than
    // the risk.
    const rebuildStale = (projectionState?.projection_version ?? 0) < 2;
    // Only OBSERVED MIRROR ABSORPTION can be missing attribution (Codex
    // #1513 r9). My r8 version also tripped on "any report row exists",
    // which is true for a canonical self-report — whose accepted value is
    // deliberately never attributed — and for a mirror report that
    // accepted nothing. In both, `mirrorUnreported` is zero and the
    // numerator is already exact, so withholding was pure loss. Narrowed
    // twice now, in the same direction: the gate must measure the risk,
    // not its surroundings.
    const attributionAtStake = cumAbsorbedMirror > 0n;
    // The missing-COLUMN case gets the SAME narrowing as the version gate
    // (Codex #1513 r13). During the rollout a chain with only a canonical
    // self-report — never attributed by design — or a mirror report that
    // accepted nothing has `cumAbsorbedMirror === 0`, so attribution is
    // unused and `mirrorTerm` is exactly `mirrorReported`. Withholding
    // there was loss for the whole rollout, or forever if the migration
    // fails. Third time in this PR I have narrowed one gate and left its
    // sibling.
    //
    // The missing-TABLE case stays UNCONDITIONAL: that is data loss or a
    // partial restore, not a rollout shape, and the reported cumulatives it
    // would have supplied are gone rather than merely unattributed.
    const columnMissing =
      (reportedRows as { attributionColumnMissing?: boolean })
        .attributionColumnMissing === true;
    const tableMissing =
      (reportedRows as { attributionTableMissing?: boolean })
        .attributionTableMissing === true;
    const attributionUnavailable =
      tableMissing ||
      ((columnMissing || rebuildStale) && attributionAtStake);
    const mirrorUnreported =
      mirrorFold > mirrorAttributed ? mirrorFold - mirrorAttributed : 0n;
    const mirrorTerm = mirrorReported + mirrorUnreported;
    const runwayNumerator = localTerm + mirrorTerm;
    const runwayExtensionDays =
      trailingCount === 0n || selfFunded || backfilledMirror ||
      attributionUnavailable
        ? null
        : ratio6(runwayNumerator * trailingCount, trailingPoolSum);
    // Why it is null, so a consumer is not left guessing between "no data",
    // "self-funded" and "cannot be computed honestly".
    const runwayUnavailableReason = selfFunded
      ? 'self-funded'
      : trailingCount === 0n
        ? 'no-armed-finalized-days'
        : backfilledMirror
          ? 'backfilled-mirror-absorption-not-decomposable'
          : attributionUnavailable
            ? 'attribution-column-unavailable'
            : null;

    return liveJsonResponse({
      chainId,
      days,
      fromDay: cutoff,
      toDay: maxDay,
      // Whether this deployment can answer the GLOBAL question at all.
      // Derived from whether it has ever finalized a day — not from which
      // chain currently holds the canonical role, so a demoted deployment
      // keeps serving the days it did finalize.
      scope: anyStamped ? 'global' : 'local-only',
      coverageFromDay,
      daily,
      cumulative: {
        absorbed: cumAbsorbed.toString(),
        // #1504 — absorption credited before the schedule started. It has no
        // day, so it appears here and nowhere in `daily`. Day 0 used to
        // carry it, which made that bucket the sum of an arbitrarily long
        // pre-launch period and the first real day; the contracts now file
        // it separately and so does this. It is the term that reconciles the
        // recycle bucket against the sum of the day series.
        absorbedPreLaunch: preLaunch,
        absorbedLocal: cumAbsorbedLocal.toString(),
        absorbedMirror: cumAbsorbedMirror.toString(),
        freshDrawdown: cumFreshDrawdown.toString(),
        recycledBudget: cumRecycledBudget.toString(),
        runwayExtensionDays,
        runwayUnavailableReason,
        selfFunded,
      },
      // Live, and deliberately outside `cumulative`: every field there is
      // counter-derived, and the whole point of this block is that it is
      // not. Grouping them would invite a reader to trust both equally.
      backing: await readBacking(env, chainId),
    });
  } catch (err) {
    return liveJsonResponse(
      { error: 'recycling-series query failed', detail: String(err) },
      500,
    );
  }
}
