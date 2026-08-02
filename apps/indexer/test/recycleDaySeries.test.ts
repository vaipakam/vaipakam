/**
 * M5 (#1218 / #1349) — recycling transparency day series
 * (docs/DesignsAndPlans/VpfiRecyclingCompletionPlan.md §M5).
 *
 * Runs against the REAL migrated schema (0045). Covers the rules that,
 * if broken, would make the public dashboard publish a wrong number
 * rather than a missing one:
 *
 *   - the canonical chain's OWN ChainRecycledReported is excluded from
 *     the mirror term (double-count, in the flattering direction);
 *   - unstamped days serve `null`, never `0`;
 *   - unarmed days are flagged `estimate` and carry no `netEmission`,
 *     and are excluded from the lifetime emission cumulative;
 *   - the day key is the EVENT's reward day, never a block-derived one;
 *   - exactly-once under replay, so an absorption credit cannot be
 *     counted twice by overlapping scan ranges.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  applyRecycleDaySeries,
  type RecycleSeriesLog,
} from '../src/recycleDaySeries';
import { handleRecyclingSeries } from '../src/recycleRoutes';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532; // the "canonical" chain under test
const MIRROR = 421614;

function makeHarness() {
  const h: SqliteD1 = createSqliteD1(ALL_MIGRATIONS);
  const env = { DB: h.d1 } as unknown as Env;
  return { h, env };
}

let logCounter = 0;
function log(
  eventName: string,
  args: Record<string, unknown>,
  blockNumber = 100n,
): RecycleSeriesLog {
  logCounter++;
  return {
    eventName,
    args,
    blockNumber,
    transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
    logIndex: logCounter,
  };
}

function stamped(
  dayId: bigint,
  opts: {
    scheduleFloor?: bigint;
    recycledBudget?: bigint;
    aBar?: bigint;
    marginBps?: bigint;
    freshDrawdown?: bigint;
    armed?: boolean;
  } = {},
): RecycleSeriesLog {
  return log('GovernorDayPoolStamped', {
    dayId,
    scheduleFloor: opts.scheduleFloor ?? 20_000n * 10n ** 18n,
    recycledBudget: opts.recycledBudget ?? 5_000n * 10n ** 18n,
    aBar: opts.aBar ?? 6_000n * 10n ** 18n,
    marginBps: opts.marginBps ?? 1_000n,
    freshDrawdown: opts.freshDrawdown ?? 20_000n * 10n ** 18n,
    armed: opts.armed ?? true,
  });
}

async function readSeries(env: Env, days = 30) {
  const res = await handleRecyclingSeries(
    new Request(
      `https://indexer.test/metrics/recycling?chainId=${CHAIN}&days=${days}`,
    ),
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    fromDay: number | null;
    toDay: number | null;
    daily: Array<Record<string, unknown>>;
    cumulative: Record<string, unknown>;
  };
}

function day(
  body: { daily: Array<Record<string, unknown>> },
  dayId: number,
): Record<string, unknown> {
  const row = body.daily.find((d) => d.dayId === dayId);
  expect(row, `day ${dayId} missing from the dense series`).toBeDefined();
  return row!;
}

describe('applyRecycleDaySeries — absorption attribution', () => {
  it('EXCLUDES the canonical chain reporting itself from the mirror term', async () => {
    const { env } = makeHarness();

    // The contract folds an accepted report into `dayMirrorRecycledCredit`
    // ONLY when `sourceChainId != block.chainid` — its own credit already
    // lives in the local series that VpfiRecycled feeds. Counting the
    // self-report here would add the canonical chain twice.
    await applyRecycleDaySeries(
      [
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 700n, dayId: 4n }),
        // Base reporting ITSELF — must not reach absorbed_mirror.
        log('ChainRecycledReported', {
          sourceChainId: CHAIN,
          dayId: 4n,
          cumulative: 700n,
          forDayReported: 700n,
          dayCreditAccepted: 700n,
        }),
        // A genuine mirror — must reach absorbed_mirror.
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 4n,
          cumulative: 300n,
          forDayReported: 300n,
          dayCreditAccepted: 300n,
        }),
      ],
      env,
      CHAIN,
    );

    const body = await readSeries(env);
    const d4 = day(body, 4);
    expect(d4.absorbedLocal).toBe('700');
    // 300, NOT 1000: the self-report is filtered.
    expect(d4.absorbedMirror).toBe('300');
    expect(d4.absorbed).toBe('1000');
  });

  it('accumulates several mirrors and several credits into one day', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 100n, dayId: 9n }),
        log('VpfiRecycled', { source: 2, refId: 2n, amount: 250n, dayId: 9n }),
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 9n,
          cumulative: 40n,
          forDayReported: 40n,
          dayCreditAccepted: 40n,
        }),
        log('ChainRecycledReported', {
          sourceChainId: 11155111,
          dayId: 9n,
          cumulative: 60n,
          forDayReported: 60n,
          dayCreditAccepted: 60n,
        }),
      ],
      env,
      CHAIN,
    );
    const d9 = day(await readSeries(env), 9);
    expect(d9.absorbedLocal).toBe('350');
    expect(d9.absorbedMirror).toBe('100');
  });

  it('keys the day on the EVENT payload, not on the block', async () => {
    const { env } = makeHarness();
    // Two credits in the SAME block carrying DIFFERENT reward days. A
    // block-derived key would collapse them into one bucket; the reward
    // day is stated by the event and must be honoured.
    await applyRecycleDaySeries(
      [
        log(
          'VpfiRecycled',
          { source: 1, refId: 1n, amount: 11n, dayId: 2n },
          500n,
        ),
        log(
          'VpfiRecycled',
          { source: 1, refId: 2n, amount: 22n, dayId: 3n },
          500n,
        ),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    expect(day(body, 2).absorbedLocal).toBe('11');
    expect(day(body, 3).absorbedLocal).toBe('22');
  });

  it('is exactly-once across overlapping scan ranges', async () => {
    const { env } = makeHarness();
    const credit = log('VpfiRecycled', {
      source: 1,
      refId: 1n,
      amount: 500n,
      dayId: 6n,
    });
    const first = await applyRecycleDaySeries([credit], env, CHAIN);
    const replay = await applyRecycleDaySeries([credit], env, CHAIN);
    expect(first).toBe(1);
    expect(replay).toBe(0); // dedup, not a second credit
    expect(day(await readSeries(env), 6).absorbedLocal).toBe('500');
  });

  it('records a filtered self-report so a replay cannot re-decide it', async () => {
    const { h, env } = makeHarness();
    const selfReport = log('ChainRecycledReported', {
      sourceChainId: CHAIN,
      dayId: 7n,
      cumulative: 900n,
      forDayReported: 900n,
      dayCreditAccepted: 900n,
    });
    await applyRecycleDaySeries([selfReport], env, CHAIN);
    const seen = h.db
      .prepare(
        `SELECT kind FROM recycle_series_events
          WHERE chain_id = ? AND day_id = ?`,
      )
      .all(CHAIN, 7) as Array<{ kind: string }>;
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('ChainRecycledReported');
  });
});

describe('applyRecycleDaySeries — pool stamps', () => {
  it('does not reset absorption already credited to the day', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 80n, dayId: 3n }),
        stamped(3n),
        log('VpfiRecycled', { source: 1, refId: 2n, amount: 20n, dayId: 3n }),
      ],
      env,
      CHAIN,
    );
    const d3 = day(await readSeries(env), 3);
    expect(d3.stamped).toBe(true);
    expect(d3.absorbedLocal).toBe('100');
  });

  it('carries every stamped field through to the read surface', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        stamped(1n, {
          scheduleFloor: 111n,
          recycledBudget: 222n,
          aBar: 333n,
          marginBps: 444n,
          freshDrawdown: 555n,
          armed: true,
        }),
      ],
      env,
      CHAIN,
    );
    const d1 = day(await readSeries(env), 1);
    expect(d1.scheduleFloor).toBe('111');
    expect(d1.recycledBudget).toBe('222');
    expect(d1.aBar).toBe('333');
    expect(d1.marginBps).toBe(444);
    expect(d1.freshDrawdown).toBe('555');
    expect(d1.netEmission).toBe('555');
    expect(d1.armed).toBe(true);
    expect(d1.estimate).toBe(false);
  });
});

describe('handleRecyclingSeries — refusing to publish a wrong number', () => {
  it('serves NULL, not 0, for a day that has absorption but no stamp', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 42n, dayId: 8n }),
        stamped(9n),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    const d8 = day(body, 8);
    expect(d8.stamped).toBe(false);
    // The distinction that matters: a zero here is indistinguishable
    // from a genuine zero pool.
    expect(d8.scheduleFloor).toBeNull();
    expect(d8.recycledBudget).toBeNull();
    expect(d8.freshDrawdown).toBeNull();
    expect(d8.netEmission).toBeNull();
    expect(d8.selfFundingRatio).toBeNull();
    // …while the absorption it DOES have is still reported.
    expect(d8.absorbedLocal).toBe('42');
  });

  it('withholds netEmission on an UNARMED day and marks it an estimate', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [stamped(5n, { freshDrawdown: 900n, armed: false })],
      env,
      CHAIN,
    );
    const d5 = day(await readSeries(env), 5);
    expect(d5.stamped).toBe(true);
    expect(d5.armed).toBe(false);
    expect(d5.estimate).toBe(true);
    // The raw figure is still shown — it IS the schedule the programme
    // is running — but nothing reserved against it, so it must not be
    // published as net emission.
    expect(d5.freshDrawdown).toBe('900');
    expect(d5.netEmission).toBeNull();
  });

  it('keeps unarmed days OUT of the lifetime emission cumulative', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        stamped(1n, {
          freshDrawdown: 700n,
          recycledBudget: 70n,
          armed: false,
        }),
        stamped(2n, { freshDrawdown: 300n, recycledBudget: 30n, armed: true }),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    // 300, not 1000: the per-day `estimate` flag cannot follow a figure
    // into a lifetime total, so the total must exclude it at the source.
    expect(body.cumulative.freshDrawdown).toBe('300');
    expect(body.cumulative.recycledBudget).toBe('30');
  });

  it('computes selfFundingRatio as recycledBudget / dailyPool', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [stamped(1n, { scheduleFloor: 750n, recycledBudget: 250n })],
      env,
      CHAIN,
    );
    // 250 / (750 + 250) = 0.25
    expect(day(await readSeries(env), 1).selfFundingRatio).toBe(0.25);
  });

  it('reports selfFunded (never a division by the zeroed floor)', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [stamped(1n, { scheduleFloor: 0n, recycledBudget: 400n })],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    expect(body.cumulative.selfFunded).toBe(true);
    expect(body.cumulative.runwayExtensionDays).toBeNull();
    expect(day(body, 1).selfFundingRatio).toBe(1);
  });

  it('emits a DENSE window so a quiet day differs from a missing one', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries([stamped(10n), stamped(14n)], env, CHAIN);
    const body = await readSeries(env, 5);
    expect(body.fromDay).toBe(10);
    expect(body.toDay).toBe(14);
    expect(body.daily.map((d) => d.dayId)).toEqual([10, 11, 12, 13, 14]);
    expect(day(body, 12).stamped).toBe(false);
  });

  it('returns an explicit empty shape for a chain with no series', async () => {
    const { env } = makeHarness();
    const body = await readSeries(env);
    expect(body.fromDay).toBeNull();
    expect(body.daily).toEqual([]);
    expect(body.cumulative.absorbed).toBe('0');
  });

  it('handles wei magnitudes that overflow int64', async () => {
    const { env } = makeHarness();
    const huge = 9_000_000n * 10n ** 18n; // ≫ 2^63
    await applyRecycleDaySeries(
      [
        stamped(1n, { freshDrawdown: huge, recycledBudget: huge }),
        log('VpfiRecycled', { source: 1, refId: 1n, amount: huge, dayId: 1n }),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    expect(day(body, 1).freshDrawdown).toBe(huge.toString());
    expect(body.cumulative.absorbed).toBe(huge.toString());
    expect(body.cumulative.freshDrawdown).toBe(huge.toString());
  });
});
