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
    scope: string;
    coverageFromDay: number | null;
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
        // Finalize the day, so the global aggregate is publishable at all.
        stamped(4n),
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
    expect(body.cumulative.absorbed).toBe('1000');
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

describe('handleRecyclingSeries — scope, coverage and partial globals', () => {
  it('withholds the GLOBAL aggregate until the day is finalized', async () => {
    const { env } = makeHarness();
    // One mirror has reported; others may not have. The components are
    // real, the sum is not yet global.
    await applyRecycleDaySeries(
      [
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 10n, dayId: 3n }),
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 3n,
          cumulative: 5n,
          forDayReported: 5n,
          dayCreditAccepted: 5n,
        }),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    const d3 = day(body, 3);
    expect(d3.stamped).toBe(false);
    expect(d3.absorbedLocal).toBe('10');
    expect(d3.absorbedMirror).toBe('5');
    expect(d3.absorbed).toBeNull();
    // …and it stays out of the lifetime global total too, while both
    // components remain visible there.
    expect(body.cumulative.absorbed).toBe('0');
    expect(body.cumulative.absorbedLocal).toBe('10');
    expect(body.cumulative.absorbedMirror).toBe('5');
  });

  it('reports local-only scope for a deployment that never finalizes a day', async () => {
    const { env } = makeHarness();
    // A mirror: it observes its own credits and never stamps a day.
    await applyRecycleDaySeries(
      [log('VpfiRecycled', { source: 1, refId: 1n, amount: 60n, dayId: 2n })],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    expect(body.scope).toBe('local-only');
    expect(day(body, 2).absorbed).toBeNull();
    expect(body.cumulative.absorbedLocal).toBe('60');
  });

  it('never synthesizes days before coverage begins', async () => {
    const { env } = makeHarness();
    // Consumer deployed mid-programme: the first thing it ever saw is
    // day 300. A 30-day default window must not invent 271..299.
    await applyRecycleDaySeries([stamped(300n), stamped(301n)], env, CHAIN);
    const body = await readSeries(env, 30);
    expect(body.coverageFromDay).toBe(300);
    expect(body.fromDay).toBe(300);
    expect(body.daily.map((d) => d.dayId)).toEqual([300, 301]);
  });

  it('keeps the runway window independent of the requested range', async () => {
    const { env } = makeHarness();
    // The days must DIFFER. An earlier version of this fixture used two
    // identical days, which made the trailing mean the same at any window
    // size — so it passed while the window was still coupled to `days`,
    // and a mutation re-coupling them survived it.
    await applyRecycleDaySeries(
      [
        stamped(1n, { scheduleFloor: 4000n, recycledBudget: 0n }),
        stamped(2n, { scheduleFloor: 1000n, recycledBudget: 0n }),
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 500n, dayId: 2n }),
      ],
      env,
      CHAIN,
    );
    const wide = await readSeries(env, 30);
    const narrow = await readSeries(env, 1);
    // Same chain state, different question shape — the lifetime metric
    // must not move.
    expect(narrow.cumulative.runwayExtensionDays).toBe(
      wide.cumulative.runwayExtensionDays,
    );
    expect(narrow.cumulative.absorbed).toBe(wide.cumulative.absorbed);
  });

  it('files pre-launch absorption apart from the day series', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        // No dayId at all — the contracts stopped naming one (#1504).
        log('VpfiRecycledPreLaunch', { source: 1, refId: 1n, amount: 900n }),
        stamped(0n),
        log('VpfiRecycled', { source: 1, refId: 2n, amount: 7n, dayId: 0n }),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    // Day 0 is the first SCHEDULED day and nothing else.
    expect(day(body, 0).absorbedLocal).toBe('7');
    // …and the pre-launch stock is published, not dropped — it is what
    // reconciles the bucket against the sum of the days.
    expect(body.cumulative.absorbedPreLaunch).toBe('900');
  });

  it('never lets a pre-launch credit reach a day bucket', async () => {
    const { h, env } = makeHarness();
    await applyRecycleDaySeries(
      [log('VpfiRecycledPreLaunch', { source: 1, refId: 1n, amount: 5n })],
      env,
      CHAIN,
    );
    const rows = h.db
      .prepare(`SELECT day_id FROM recycle_day_pool WHERE chain_id = ?`)
      .all(CHAIN) as Array<{ day_id: number }>;
    expect(rows).toHaveLength(0);
    // Audited as -1, so it can never be mistaken for day 0 downstream.
    const ev = h.db
      .prepare(`SELECT day_id FROM recycle_series_events WHERE chain_id = ?`)
      .all(CHAIN) as Array<{ day_id: number }>;
    expect(ev[0].day_id).toBe(-1);
  });

  it('rebuilds the series from activity_events when the cursor has passed', async () => {
    const { h, env } = makeHarness();
    // The shared scan cursor is already beyond these blocks, so the live
    // path will never see them; only the one-time replay can.
    const rows: Array<[number, number, string, string, string]> = [
      [
        10,
        0,
        '0xaa',
        'GovernorDayPoolStamped',
        JSON.stringify({
          dayId: '7',
          scheduleFloor: '100',
          recycledBudget: '20',
          aBar: '30',
          marginBps: '40',
          freshDrawdown: '90',
          armed: true,
        }),
      ],
      [
        11,
        1,
        '0xbb',
        'VpfiRecycled',
        JSON.stringify({ source: 1, refId: '1', amount: '55', dayId: '7' }),
      ],
    ];
    for (const [b, li, tx, kind, args] of rows) {
      h.db
        .prepare(
          `INSERT INTO activity_events
             (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(CHAIN, b, li, tx, kind, args, 1_700_000_000);
    }

    // A completely quiet scan — no logs at all. The backfill must still run.
    await applyRecycleDaySeries([], env, CHAIN);

    const d7 = day(await readSeries(env), 7);
    expect(d7.stamped).toBe(true);
    expect(d7.freshDrawdown).toBe('90');
    expect(d7.absorbedLocal).toBe('55');
  });

  it('replays the feed ONCE and does not re-read it afterwards', async () => {
    const { h, env } = makeHarness();
    const insert = (b: number, amount: string, dayId: string) =>
      h.db
        .prepare(
          `INSERT INTO activity_events
             (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          CHAIN,
          b,
          0,
          `0x${b.toString(16)}`,
          'VpfiRecycled',
          JSON.stringify({ source: 1, refId: '1', amount, dayId }),
          1_700_000_000,
        );

    insert(10, '77', '4');
    await applyRecycleDaySeries([], env, CHAIN);
    expect(day(await readSeries(env), 4).absorbedLocal).toBe('77');

    // A row appearing in the feed AFTER the replay has completed belongs
    // to the live path, which has its own dedup. The replay must not go
    // back for it. Asserting the amount is unchanged after a second call
    // would prove nothing — the dedup table makes a repeated replay
    // harmless either way, which is exactly why the earlier version of
    // this test survived a mutation that removed the one-time guard.
    insert(11, '5', '4');
    await applyRecycleDaySeries([], env, CHAIN);
    expect(day(await readSeries(env), 4).absorbedLocal).toBe('77');
  });

  it('keeps the empty response schema identical to a populated one', async () => {
    const { env } = makeHarness();
    const body = await readSeries(env);
    expect(body.cumulative.selfFunded).toBe(false);
    expect(body.cumulative.absorbedLocal).toBe('0');
    expect(body.cumulative.absorbedMirror).toBe('0');
    expect(body.coverageFromDay).toBeNull();
    expect(body.scope).toBe('empty');
  });
});

describe('handleRecyclingSeries — the ratified window, and what anchors it', () => {
  /** Stamp days [from..to] armed, with an explicit floor per day. */
  function floors(from: number, perDay: (d: number) => bigint) {
    const out = [];
    for (let d = from; ; d++) {
      const f = perDay(d);
      if (f < 0n) break;
      out.push(stamped(BigInt(d), { scheduleFloor: f, recycledBudget: 0n }));
    }
    return out;
  }

  it('uses the protocol\'s SEVEN-day window, not a longer one', async () => {
    const { env } = makeHarness();
    // Day 1 is a huge outlier. Inside a 7-day window (days 4..10) it is
    // excluded; inside a 30-day one it dominates the mean. The days must
    // therefore differ — a flat fixture would report the same mean at
    // every window size and prove nothing.
    await applyRecycleDaySeries(
      [
        ...floors(1, (d) => (d > 10 ? -1n : d === 1 ? 10_000n : 100n)),
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 700n, dayId: 5n }),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env, 30);
    // mean over days 4..10 = 100  ->  700 / 100 = 7
    expect(body.cumulative.runwayExtensionDays).toBe(7);
  });

  it('anchors the window on the latest FINALIZED day, not the latest row', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        ...floors(3, (d) => (d > 9 ? -1n : d === 3 ? 700n : 100n)),
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 700n, dayId: 5n }),
      ],
      env,
      CHAIN,
    );
    const before = (await readSeries(env, 30)).cumulative.runwayExtensionDays;
    // mean over days 3..9 = 1300/7  ->  700 / (1300/7) = 3.76923
    expect(before).toBe(3.76923);

    // The next day BEGINS: a credit lands on day 10, which is not
    // finalized. Anchoring on the highest row of any kind would slide the
    // window to 4..10 and drop day 3, changing a lifetime figure because
    // a day started.
    await applyRecycleDaySeries(
      [log('VpfiRecycled', { source: 1, refId: 2n, amount: 1n, dayId: 10n })],
      env,
      CHAIN,
    );
    const after = (await readSeries(env, 30)).cumulative.runwayExtensionDays;
    // The NUMERATOR legitimately grows by the new credit — it is a lifetime
    // recycled stock and that value is really in the bucket. What must not
    // move is the DENOMINATOR: the window stays days 3..9.
    //
    // An earlier version of this test asserted `after === before`, which
    // held only because the numerator then summed finalized days alone. It
    // was pinning an accident of that implementation, not the window rule,
    // and it broke the moment the numerator was corrected. Assert the
    // denominator instead, by recomputing against it.
    //   701 / (1300 / 7) = 3.774615
    expect(after).toBe(3.774615);
    // Non-vacuous: anchoring on the highest row of ANY kind would slide the
    // window to 4..10, drop day 3 (the outlier), and report 701/(600/6).
    expect(after).not.toBe(7.01);
    // …and the credit really did land, so the fixture is live.
    expect(day(await readSeries(env, 30), 10).absorbedLocal).toBe('1');
  });
});

describe('applyRecycleDaySeries — the pre-cutover event shape', () => {
  it('REFUSES a legacy five-field stamp instead of coercing it', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        // Emitted before the event was widened: no freshDrawdown, no armed.
        log('GovernorDayPoolStamped', {
          dayId: 2n,
          scheduleFloor: 500n,
          recycledBudget: 60n,
          aBar: 70n,
          marginBps: 80n,
        }),
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 12n, dayId: 2n }),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    const d2 = day(body, 2);
    // Coercing the absent fields would have stored this as a stamped,
    // unarmed day with a zero drawdown — fabricated history shaped like
    // real history.
    expect(d2.stamped).toBe(false);
    expect(d2.scheduleFloor).toBeNull();
    expect(d2.freshDrawdown).toBeNull();
    // The absorption it genuinely observed is still recorded.
    expect(d2.absorbedLocal).toBe('12');
    // …and it does not count as a finalized day anywhere.
    expect(body.scope).toBe('local-only');
    expect(body.cumulative.absorbed).toBe('0');
  });

  it('records the refused stamp so a replay cannot re-decide it', async () => {
    const { h, env } = makeHarness();
    await applyRecycleDaySeries(
      [
        log('GovernorDayPoolStamped', {
          dayId: 2n,
          scheduleFloor: 500n,
          recycledBudget: 60n,
          aBar: 70n,
          marginBps: 80n,
        }),
      ],
      env,
      CHAIN,
    );
    const seen = h.db
      .prepare(
        `SELECT kind FROM recycle_series_events WHERE chain_id = ? AND day_id = ?`,
      )
      .all(CHAIN, 2) as Array<{ kind: string }>;
    expect(seen).toHaveLength(1);
  });

  it('still accepts the widened stamp for the same day', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [stamped(2n, { freshDrawdown: 42n, armed: true })],
      env,
      CHAIN,
    );
    expect(day(await readSeries(env), 2).freshDrawdown).toBe('42');
  });
});

describe('handleRecyclingSeries — pre-launch stock, honestly scoped', () => {
  it('reports pre-launch absorption when there are NO day rows at all', async () => {
    const { env } = makeHarness();
    // The normal state before the schedule starts: credits exist, days do
    // not. Reading the total after the empty-series branch would report
    // zero for exactly the period the figure describes.
    await applyRecycleDaySeries(
      [log('VpfiRecycledPreLaunch', { source: 1, refId: 1n, amount: 640n })],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    expect(body.daily).toEqual([]);
    expect(body.cumulative.absorbedPreLaunch).toBe('640');
  });

  it('publishes what it observes about day 0 and claims nothing more', async () => {
    // A fresh deployment that takes NO credits before launch never emits a
    // pre-launch event, so "has this chain emitted one?" cannot stand in
    // for "does this chain have the split" — it marks the clean case as
    // legacy. No provenance flag is published in either direction.
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 30n, dayId: 0n }),
        stamped(0n),
      ],
      env,
      CHAIN,
    );
    const d0 = day(await readSeries(env), 0);
    expect(d0.absorbedLocal).toBe('30');
    expect('preLaunchConflated' in d0).toBe(false);
  });

  it('counts the pre-launch stock in the runway numerator', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        stamped(1n, { scheduleFloor: 100n, recycledBudget: 0n }),
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 300n, dayId: 1n }),
      ],
      env,
      CHAIN,
    );
    const before = (await readSeries(env)).cumulative.runwayExtensionDays;
    // 300 / 100 = 3
    expect(before).toBe(3);

    // The pre-launch stock is real recycled value in the bucket, so the
    // LIFETIME numerator includes it. Keeping it out of the trailing rate
    // says nothing about this total.
    await applyRecycleDaySeries(
      [log('VpfiRecycledPreLaunch', { source: 1, refId: 2n, amount: 200n })],
      env,
      CHAIN,
    );
    // (300 + 200) / 100 = 5
    expect((await readSeries(env)).cumulative.runwayExtensionDays).toBe(5);
  });
});

describe('handleRecyclingSeries — a mesh runway counts every chain in full', () => {
  it("includes a mirror's LIFETIME reported cumulative, not just its accepted days", async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        stamped(1n, { scheduleFloor: 100n, recycledBudget: 0n }),
        // The mirror reports a lifetime total of 500 but only 100 is
        // attributable to this day — the rest is its own pre-launch stock
        // plus whatever attribution headroom clamped away. All 500 is real
        // recycled value sitting in that chain's bucket.
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 1n,
          cumulative: 500n,
          forDayReported: 100n,
          dayCreditAccepted: 100n,
        }),
      ],
      env,
      CHAIN,
    );
    // 500 / 100 = 5. Counting only the accepted day credit would give 1.
    expect((await readSeries(env)).cumulative.runwayExtensionDays).toBe(5);
  });

  it('does not count a mirror twice when its day credit is also attributed', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        stamped(1n, { scheduleFloor: 100n, recycledBudget: 0n }),
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 1n,
          cumulative: 300n,
          forDayReported: 300n,
          dayCreditAccepted: 300n,
        }),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    // The day still shows its attributed credit…
    expect(day(body, 1).absorbedMirror).toBe('300');
    // …but the lifetime numerator counts 300 once, not 600.
    expect(body.cumulative.runwayExtensionDays).toBe(3);
  });

  it('never walks a reported cumulative backwards on a replayed report', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        stamped(1n, { scheduleFloor: 100n, recycledBudget: 0n }),
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 1n,
          cumulative: 400n,
          forDayReported: 0n,
          dayCreditAccepted: 0n,
        }),
        // An out-of-order / stale report for an earlier day.
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 0n,
          cumulative: 50n,
          forDayReported: 0n,
          dayCreditAccepted: 0n,
        }),
      ],
      env,
      CHAIN,
    );
    // 400 / 100 = 4 — the stale 50 must not replace it.
    expect((await readSeries(env)).cumulative.runwayExtensionDays).toBe(4);
  });
});

describe('handleRecyclingSeries — coverage-bounded folds vs self-healing reports', () => {
  it("uses this chain's own self-report when it exceeds the observed fold", async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        stamped(1n, { scheduleFloor: 100n, recycledBudget: 0n }),
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 50n, dayId: 1n }),
        // This consumer started indexing mid-programme, so its fold sees 50.
        // The chain says it has absorbed 800 in its lifetime.
        log('ChainRecycledReported', {
          sourceChainId: CHAIN,
          dayId: 1n,
          cumulative: 800n,
          forDayReported: 50n,
          dayCreditAccepted: 50n,
        }),
      ],
      env,
      CHAIN,
    );
    // 800 / 100 = 8, not 50/100.
    expect((await readSeries(env)).cumulative.runwayExtensionDays).toBe(8);
  });

  it('never goes backwards when the self-report lags observed credits', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries(
      [
        stamped(1n, { scheduleFloor: 100n, recycledBudget: 0n }),
        log('ChainRecycledReported', {
          sourceChainId: CHAIN,
          dayId: 1n,
          cumulative: 200n,
          forDayReported: 0n,
          dayCreditAccepted: 0n,
        }),
        // Credits observed AFTER the report was sent.
        log('VpfiRecycled', { source: 1, refId: 9n, amount: 700n, dayId: 1n }),
      ],
      env,
      CHAIN,
    );
    // The fold (700) exceeds the stale self-report (200); take the larger.
    expect((await readSeries(env)).cumulative.runwayExtensionDays).toBe(7);
  });

  it('rebuilds the per-source projection on a database that already backfilled', async () => {
    const { h, env } = makeHarness();
    // Simulate 0045's replay having completed before this projection existed:
    // the event is in the feed AND already marked seen by the dedup table.
    h.db
      .prepare(
        `INSERT INTO activity_events
           (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        CHAIN,
        10,
        0,
        '0xaa',
        'ChainRecycledReported',
        JSON.stringify({
          sourceChainId: MIRROR,
          dayId: '1',
          cumulative: '900',
          forDayReported: '0',
          dayCreditAccepted: '0',
        }),
        1_700_000_000,
      );
    h.db
      .prepare(
        `INSERT INTO recycle_series_events
           (chain_id, block_number, log_index, tx_hash, kind, day_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(CHAIN, 10, 0, '0xaa', 'ChainRecycledReported', 1);
    h.db
      .prepare(
        `INSERT INTO recycle_series_state (chain_id, backfill_done)
         VALUES (?, 1)`,
      )
      .run(CHAIN);

    // The ingest replay is gated by the dedup row, so ONLY a projection
    // rebuild can populate the new table here.
    await applyRecycleDaySeries(
      [stamped(1n, { scheduleFloor: 100n, recycledBudget: 0n })],
      env,
      CHAIN,
    );
    // 900 / 100 = 9 — the mirror is not omitted.
    expect((await readSeries(env)).cumulative.runwayExtensionDays).toBe(9);
  });
});

describe('handleRecyclingSeries — pre-cutover backfill', () => {
  function seedBackfill(
    h: SqliteD1,
    dayId: number,
    opts: {
      floor?: string;
      budget?: string;
      drawdown?: string;
      armed?: number;
      local?: string;
    } = {},
  ) {
    h.db
      .prepare(
        `INSERT INTO recycle_day_backfill
           (chain_id, day_id, stamped, schedule_floor, recycled_budget,
            fresh_drawdown, absorbed_local, absorbed_mirror, armed,
            armed_from_day, recorded_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, '0', ?, 0, 1700000000)`,
      )
      .run(
        CHAIN,
        dayId,
        opts.floor ?? '1000',
        opts.budget ?? '250',
        opts.drawdown ?? '900',
        opts.local ?? '0',
        opts.armed ?? 1,
      );
  }

  it('serves a pre-cutover day the event stream refuses', async () => {
    const { h, env } = makeHarness();
    seedBackfill(h, 4, { local: '55' });
    // A later day arrives by event, so the window covers day 4.
    await applyRecycleDaySeries([stamped(6n)], env, CHAIN);

    const d4 = day(await readSeries(env), 4);
    expect(d4.stamped).toBe(true);
    expect(d4.origin).toBe('backfill');
    expect(d4.scheduleFloor).toBe('1000');
    expect(d4.freshDrawdown).toBe('900');
    expect(d4.absorbedLocal).toBe('55');
    // 250 / (1000 + 250) = 0.2
    expect(d4.selfFundingRatio).toBe(0.2);
  });

  it('serves NULL for the two fields the getter cannot supply', async () => {
    const { h, env } = makeHarness();
    seedBackfill(h, 4);
    await applyRecycleDaySeries([stamped(6n)], env, CHAIN);
    const d4 = day(await readSeries(env), 4);
    // Not 0 — a zero margin is a real, different thing.
    expect(d4.aBar).toBeNull();
    expect(d4.marginBps).toBeNull();
  });

  it('withholds netEmission on an UNARMED backfilled day', async () => {
    const { h, env } = makeHarness();
    seedBackfill(h, 4, { armed: 0, drawdown: '777' });
    await applyRecycleDaySeries([stamped(6n)], env, CHAIN);
    const d4 = day(await readSeries(env), 4);
    expect(d4.armed).toBe(false);
    expect(d4.estimate).toBe(true);
    expect(d4.freshDrawdown).toBe('777');
    // The whole reason the backfill must carry arming status: these are
    // unreserved estimates and must not be republished as net emission.
    expect(d4.netEmission).toBeNull();
  });

  it('PREFERS THE EVENT where both sources describe the same day', async () => {
    const { h, env } = makeHarness();
    // The backfill recomputes from a slot a demotion can overwrite; the
    // event is immutable. Where they disagree, the event is the record.
    seedBackfill(h, 5, { floor: '111', drawdown: '111' });
    await applyRecycleDaySeries(
      [stamped(5n, { scheduleFloor: 999n, freshDrawdown: 999n })],
      env,
      CHAIN,
    );
    const d5 = day(await readSeries(env), 5);
    expect(d5.origin).toBe('event');
    expect(d5.scheduleFloor).toBe('999');
    expect(d5.freshDrawdown).toBe('999');
  });

  it('folds backfilled days into the LIFETIME aggregates, not just the chart', async () => {
    const { h, env } = makeHarness();
    seedBackfill(h, 2, {
      floor: '1000',
      budget: '400',
      drawdown: '900',
      local: '77',
      armed: 1,
    });
    await applyRecycleDaySeries([stamped(6n, { freshDrawdown: 10n, recycledBudget: 5n })], env, CHAIN);

    const body = await readSeries(env);
    // A backfilled day is a finalized day: it belongs in every total, not
    // only in the day it is drawn on.
    expect(body.cumulative.absorbed).toBe('77');
    expect(body.cumulative.absorbedLocal).toBe('77');
    expect(body.cumulative.freshDrawdown).toBe('910'); // 900 + 10
    expect(body.cumulative.recycledBudget).toBe('405'); // 400 + 5
  });

  it('reports GLOBAL scope for a backfill-only dataset', async () => {
    const { h, env } = makeHarness();
    seedBackfill(h, 2, { local: '5' });
    // No event rows at all — the only finalized days this chain has are
    // backfilled ones. Calling that "local-only" would say the deployment
    // never finalized a day, which is false.
    const body = await readSeries(env);
    expect(body.scope).toBe('global');
    expect(day(body, 2).origin).toBe('backfill');
  });

  it('does NOT add event absorption the backfill snapshot already counted', async () => {
    const { h, env } = makeHarness();
    // The backfill reads the LIVE on-chain accumulator, which already
    // includes the very credits the event rows folded. An ordinary
    // pre-cutover replay therefore has both rows describing the same 100 —
    // adding them would report 125 for a day that absorbed 100.
    seedBackfill(h, 3, { local: '100' });
    await applyRecycleDaySeries(
      [
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 25n, dayId: 3n }),
        stamped(6n),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    const d3 = day(body, 3);
    expect(d3.origin).toBe('backfill');
    expect(d3.scheduleFloor).toBe('1000');
    // The snapshot, not the sum.
    expect(d3.absorbedLocal).toBe('100');
    expect(body.cumulative.absorbedLocal).toBe('100');
  });

  it('computes the runway window over BACKFILLED armed days too', async () => {
    const { h, env } = makeHarness();
    // A backfill-only dataset: the runway block used to query the event
    // table directly, so it found no armed days and reported null.
    seedBackfill(h, 1, { floor: '100', budget: '0', local: '300', armed: 1 });
    const body = await readSeries(env);
    // 300 / 100 = 3
    expect(body.cumulative.runwayExtensionDays).toBe(3);
    expect(body.cumulative.selfFunded).toBe(false);
  });

  it('anchors the runway on a backfilled day when it is the latest armed one', async () => {
    const { h, env } = makeHarness();
    seedBackfill(h, 1, { floor: '400', budget: '0', local: '0', armed: 1 });
    seedBackfill(h, 2, { floor: '100', budget: '0', local: '600', armed: 1 });
    const body = await readSeries(env);
    // mean over days 1..2 = 250  ->  600 / 250 = 2.4
    expect(body.cumulative.runwayExtensionDays).toBe(2.4);
  });

  it('still serves the event series when migration 0047 has not run yet', async () => {
    // Every deploy script runs `wrangler deploy` BEFORE
    // `migrations apply`, so the new Worker answers requests against a
    // database without this table for the length of the rollout — and
    // indefinitely if the migration fails. 500ing the whole endpoint over
    // an ADDITIVE change is worse than serving yesterday's series.
    const { h, env } = makeHarness();
    h.db.prepare(`DROP TABLE recycle_day_backfill`).run();
    await applyRecycleDaySeries([stamped(3n, { freshDrawdown: 12n })], env, CHAIN);

    const body = await readSeries(env);
    expect(day(body, 3).freshDrawdown).toBe('12');
    expect(body.cumulative.freshDrawdown).toBe('12');
  });

  it('REFUSES the runway when a backfilled day carries mirror absorption', async () => {
    const { h, env } = makeHarness();
    // A backfilled day's mirror total is summed across mirrors ON CHAIN, so
    // it cannot be decomposed per source. No arithmetic over aggregates
    // recovers the real stock — four review rounds each fixed one case and
    // broke the next. The endpoint refuses, as it does everywhere else here.
    h.db
      .prepare(
        `INSERT INTO recycle_day_backfill
           (chain_id, day_id, stamped, schedule_floor, recycled_budget,
            fresh_drawdown, absorbed_local, absorbed_mirror, armed,
            armed_from_day, recorded_at, generator_rev)
         VALUES (?, 1, 1, '100', '0', '0', '0', '900', 1, 1, 1700000000, 'x')`,
      )
      .run(CHAIN);
    const body = await readSeries(env);
    expect(body.cumulative.runwayExtensionDays).toBeNull();
    expect(body.cumulative.runwayUnavailableReason).toBe(
      'backfilled-mirror-absorption-not-decomposable',
    );
    // The components it would have been built from are still published.
    expect(body.cumulative.absorbedMirror).toBe('900');
    expect(day(body, 1).absorbedMirror).toBe('900');
  });

  it('STILL computes the runway when backfilled days carry no mirror absorption', async () => {
    const { h, env } = makeHarness();
    // The refusal is narrow: a backfilled day is not itself disqualifying,
    // only an undecomposable cross-chain total is.
    h.db
      .prepare(
        `INSERT INTO recycle_day_backfill
           (chain_id, day_id, stamped, schedule_floor, recycled_budget,
            fresh_drawdown, absorbed_local, absorbed_mirror, armed,
            armed_from_day, recorded_at, generator_rev)
         VALUES (?, 1, 1, '100', '0', '0', '300', '0', 1, 1, 1700000000, 'x')`,
      )
      .run(CHAIN);
    const body = await readSeries(env);
    // 300 / 100 = 3
    expect(body.cumulative.runwayExtensionDays).toBe(3);
    expect(body.cumulative.runwayUnavailableReason).toBeNull();
  });

  it('keeps absorption-only backfilled days (unstamped, real credits)', async () => {
    const { h, env } = makeHarness();
    // The pass emits these for historical days that accrued absorption but
    // were never finalized — for a day predating event coverage the getter
    // is the only source for that attribution.
    h.db
      .prepare(
        `INSERT INTO recycle_day_backfill
           (chain_id, day_id, stamped, schedule_floor, recycled_budget,
            fresh_drawdown, absorbed_local, absorbed_mirror, armed,
            armed_from_day, recorded_at)
         VALUES (?, 2, 0, '0', '0', '0', '40', '0', 0, 0, 1700000000)`,
      )
      .run(CHAIN);
    await applyRecycleDaySeries([stamped(5n)], env, CHAIN);
    const body = await readSeries(env);
    const d2 = day(body, 2);
    expect(d2.stamped).toBe(false);
    expect(d2.absorbedLocal).toBe('40');
    // Not finalized, so it has no pool and no global aggregate…
    expect(d2.scheduleFloor).toBeNull();
    expect(d2.absorbed).toBeNull();
    // …but the component total still sees it.
    expect(body.cumulative.absorbedLocal).toBe('40');
  });

  it('still reconciles reported mirrors when no backfill is involved', async () => {
    const { env } = makeHarness();
    // With every day event-sourced the mirror stock IS decomposable: each
    // source contributes its own reported cumulative.
    await applyRecycleDaySeries(
      [
        stamped(5n, { scheduleFloor: 100n, recycledBudget: 0n }),
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 5n,
          cumulative: 500n,
          forDayReported: 100n,
          dayCreditAccepted: 100n,
        }),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    // 500 / 100 = 5 — the reported lifetime figure, not the accepted 100.
    expect(body.cumulative.runwayExtensionDays).toBe(5);
    expect(body.cumulative.runwayUnavailableReason).toBeNull();
  });

  it('serves the series when 0047 has added no column yet (rollout window)', async () => {
    // Every deploy script deploys the Worker BEFORE applying migrations, so
    // pre-0047 `recycle_chain_reported` exists WITHOUT
    // `attributed_cumulative`. An uncaught `no such column` rejects the
    // whole parallel read and 500s the endpoint for the rollout.
    const { h, env } = makeHarness();
    h.db.prepare(`DROP TABLE recycle_day_backfill`).run();
    h.db.prepare(`DROP TABLE recycle_chain_reported`).run();
    h.db
      .prepare(
        `CREATE TABLE recycle_chain_reported (
           chain_id INTEGER NOT NULL,
           source_chain_id INTEGER NOT NULL,
           reported_cumulative TEXT NOT NULL DEFAULT '0',
           PRIMARY KEY (chain_id, source_chain_id))`,
      )
      .run();
    h.db
      .prepare(
        `INSERT INTO recycle_chain_reported
           (chain_id, source_chain_id, reported_cumulative)
         VALUES (?, ?, '400')`,
      )
      .run(CHAIN, MIRROR);
    await applyRecycleDaySeries(
      [stamped(1n, { scheduleFloor: 100n, recycledBudget: 0n })],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    // TWO properties, and r5 only had the first:
    //   the endpoint SERVES (no 500) — that was the point of the fallback;
    //   and it WITHHOLDS the runway, because without attribution the
    //   unreported term equals the whole fold and gets added on top of the
    //   source's full reported cumulative. Defaulting attribution to zero
    //   publishes a knowingly double-counted figure (Codex #1513 r6).
    expect(body.cumulative.absorbedMirror).toBe('0');
    expect(body.cumulative.runwayExtensionDays).toBeNull();
    expect(body.cumulative.runwayUnavailableReason).toBe(
      'attribution-column-unavailable',
    );
    // …and the day series itself is unaffected by the missing column.
    expect(day(body, 1).scheduleFloor).toBe('100');
  });

  it('does NOT refuse when a delayed report supplies a zero-mirror snapshot', async () => {
    const { h, env } = makeHarness();
    // The snapshot captured no cross-chain absorption; a delayed report
    // arrived afterwards. The merge keeps origin='backfill' while carrying
    // the EVENT's figure — which is fully reconcilable per source, so
    // refusing here would contradict the narrow refusal (Codex #1513 r6).
    h.db
      .prepare(
        `INSERT INTO recycle_day_backfill
           (chain_id, day_id, stamped, schedule_floor, recycled_budget,
            fresh_drawdown, absorbed_local, absorbed_mirror, armed,
            armed_from_day, recorded_at, generator_rev)
         VALUES (?, 1, 0, '0', '0', '0', '0', '0', 0, 1, 1700000000, 'x')`,
      )
      .run(CHAIN);
    await applyRecycleDaySeries(
      [
        stamped(2n, { scheduleFloor: 100n, recycledBudget: 0n }),
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 1n,
          cumulative: 300n,
          forDayReported: 300n,
          dayCreditAccepted: 300n,
        }),
      ],
      env,
      CHAIN,
    );
    const body = await readSeries(env);
    expect(body.cumulative.runwayUnavailableReason).toBeNull();
    // 300 / 100 = 3
    expect(body.cumulative.runwayExtensionDays).toBe(3);
  });

  it('keeps scanning when 0047 has not applied yet (write path)', async () => {
    // The read path was made tolerant a round earlier; the rebuild and the
    // live write were not, so a scan in the rollout window aborted before
    // its cursor advanced — a stalled indexer, not a degraded metric.
    const { h, env } = makeHarness();
    h.db.prepare(`DROP TABLE recycle_chain_reported`).run();
    h.db
      .prepare(
        `CREATE TABLE recycle_chain_reported (
           chain_id INTEGER NOT NULL,
           source_chain_id INTEGER NOT NULL,
           reported_cumulative TEXT NOT NULL DEFAULT '0',
           PRIMARY KEY (chain_id, source_chain_id))`,
      )
      .run();
    const applied = await applyRecycleDaySeries(
      [
        stamped(1n),
        log('ChainRecycledReported', {
          sourceChainId: MIRROR,
          dayId: 1n,
          cumulative: 700n,
          forDayReported: 100n,
          dayCreditAccepted: 100n,
        }),
      ],
      env,
      CHAIN,
    );
    expect(applied).toBe(2);
    const row = h.db
      .prepare(
        `SELECT reported_cumulative FROM recycle_chain_reported
          WHERE chain_id = ? AND source_chain_id = ?`,
      )
      .get(CHAIN, MIRROR) as { reported_cumulative: string } | undefined;
    expect(row?.reported_cumulative).toBe('700');
  });

  it('keeps a real row distinguishable from a dense-series gap', async () => {
    const { h, env } = makeHarness();
    h.db
      .prepare(
        `INSERT INTO recycle_day_backfill
           (chain_id, day_id, stamped, schedule_floor, recycled_budget,
            fresh_drawdown, absorbed_local, absorbed_mirror, armed,
            armed_from_day, recorded_at, generator_rev)
         VALUES (?, 1, 0, '0', '0', '0', '60', '0', 0, 0, 1700000000, 'x')`,
      )
      .run(CHAIN);
    await applyRecycleDaySeries([stamped(3n)], env, CHAIN);
    const body = await readSeries(env);
    // A stored absorption-only row keeps its provenance…
    expect(day(body, 1).origin).toBe('backfill');
    expect(day(body, 1).absorbedLocal).toBe('60');
    // …while a synthesised gap has none.
    expect(day(body, 2).origin).toBeNull();
  });

  it('WITHHOLDS the runway when the reported table is gone (not a rollout)', async () => {
    const { h, env } = makeHarness();
    await applyRecycleDaySeries(
      [
        stamped(1n, { scheduleFloor: 100n, recycledBudget: 0n }),
        log('VpfiRecycled', { source: 1, refId: 1n, amount: 300n, dayId: 1n }),
      ],
      env,
      CHAIN,
    );
    // A missing TABLE is data loss or a partial restore — not the 0047
    // window, which has the table minus one column. Publishing then omits
    // every mirror's reported-only lifetime stock.
    h.db.prepare(`DROP TABLE recycle_chain_reported`).run();
    const body = await readSeries(env);
    expect(body.cumulative.runwayExtensionDays).toBeNull();
    expect(body.cumulative.runwayUnavailableReason).toBe(
      'attribution-column-unavailable',
    );
  });

  it('marks event-sourced days so a reader can tell the two apart', async () => {
    const { env } = makeHarness();
    await applyRecycleDaySeries([stamped(2n)], env, CHAIN);
    expect(day(await readSeries(env), 2).origin).toBe('event');
  });
});
