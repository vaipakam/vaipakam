/**
 * RPC read-diet PR B — the config-snapshot refresh decision, pinned.
 * The explicit event allowlist and the backstop decide when the indexer
 * spends the two `eth_call`s that keep GET /config/:chainId current; a
 * miss means the apps' display config lags governance until the
 * backstop, an over-trigger burns a redundant read per scan.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import {
  abiOutputNames,
  handleConfigSnapshot,
  isConfigEventName,
  maybeRefreshProtocolConfig,
  serializeTuple,
  shouldRefreshConfig,
} from '../src/configSnapshot';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATION_0039 = readFileSync(
  new URL('../migrations/0039_protocol_config_grace_buckets.sql', import.meta.url),
  'utf8',
);
const MIGRATION_0035 = readFileSync(
  new URL('../migrations/0035_protocol_config.sql', import.meta.url),
  'utf8',
);
const MIGRATION_0067 = readFileSync(
  new URL('../migrations/0067_protocol_config_label_binding.sql', import.meta.url),
  'utf8',
);
const MIGRATION_0069 = readFileSync(
  new URL('../migrations/0069_protocol_config_knobs.sql', import.meta.url),
  'utf8',
);

/** Env + client stubs for the refresh path: real SQLite behind the D1
 *  shape (the upsert/stale-mark guards ARE SQL), canned reads. */
/** The ConfigFacet address this build's deployment artifact records for
 *  the test chain: what the loupe answers when the chain runs this build's
 *  code (#2073, Codex #2653 r1). */
const BUILD_CONFIG_FACET = getDeployment(84532)!.facets.configFacet!;

function refreshHarness(opts?: {
  graceRead?: () => Promise<unknown>;
  /** What the loupe reports as the getters' host; defaults to this build's. */
  loupeHost?: () => Promise<string>;
  /** #2071 — the batched settings read; absent = the client has none, so
   *  that read fails and the row stores no settings. */
  multicall?: (args: { contracts: readonly { functionName: string }[]; blockNumber?: bigint }) => Promise<unknown>;
}) {
  const { db, d1 } = createSqliteD1([MIGRATION_0035, MIGRATION_0039, MIGRATION_0067, MIGRATION_0069]);
  const reads: string[] = [];
  const client = {
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === 'facetAddress') {
        return opts?.loupeHost ? opts.loupeHost() : BUILD_CONFIG_FACET;
      }
      reads.push(args.functionName);
      if (args.functionName === 'getMasterFlags') return [true, true, false] as const;
      // #1213 PR 2 — the grace-bucket read rides the same refresh; the
      // retail default is an empty array (compile-time schedule).
      if (args.functionName === 'getGraceBuckets') {
        return opts?.graceRead ? opts.graceRead() : ([] as const);
      }
      return [100n, [1n, 2n, 3n, 4n]] as const;
    },
    ...(opts?.multicall ? { multicall: opts.multicall } : {}),
  } as unknown as PublicClient;
  const env = { DB: d1 } as unknown as Env;
  const row = () =>
    db
      .prepare(
        `SELECT source_block AS sb, updated_at AS ua, bundle_json AS bj,
                grace_buckets_json AS gb
         FROM protocol_config WHERE chain_id = 84532`,
      )
      .get() as { sb: number; ua: number; bj: string; gb: string | null } | undefined;
  return { db, env, client, reads, row };
}

const DIAMOND = '0x0000000000000000000000000000000000000d1a' as const;
/** An RPC binding, so the route treats the test chain as served (#1140). */
const SERVED_RPC = 'http://127.0.0.1:9';

describe('configSnapshot', () => {
  it('matches every governance setter shape (representatives)', () => {
    for (const name of [
      'FeesConfigSet',
      'RiskConfigSet',
      'MaxOfferDurationDaysSet',
      'PartialFillEnabledSet',
      'SanctionsOracleSet',
      'GraceBucketsUpdated',
      'AssetMinPartialBpsUpdated',
      'TierTableVersionBumped',
    ]) {
      expect(isConfigEventName(name), name).toBe(true);
    }
  });

  it('never matches domain lifecycle events', () => {
    for (const name of [
      'OfferCreated',
      'OfferAccepted',
      'OfferCanceled',
      'LoanInitiated',
      'LoanRepaid',
      'LoanDefaulted',
      'Transfer',
      'PartialRepaid',
      'InternalMatchExecuted',
      // Suffix-shaped lifecycle names the retired /(Set|Updated|Bumped)$/
      // rule wrongly matched (Codex #1231 r1) — pinned as negatives so
      // an allowlist regression can't silently re-trigger on them.
      'NFTStatusUpdated',
      'PrepayListingUpdated',
      // Per-user admin events — they never change the served bundle.
      'KYCTierUpdated',
      'KeeperAccessUpdated',
      'TradeAllowanceSet',
    ]) {
      expect(isConfigEventName(name), name).toBe(false);
    }
  });

  it('refreshes on config events, bootstrap, and the backstop — not otherwise', () => {
    const now = 1_000_000;
    // Config event in the scan → always refresh.
    expect(
      shouldRefreshConfig({ sawConfigEvent: true, rowUpdatedAt: now, nowSec: now }),
    ).toBe(true);
    // No row yet (bootstrap) → refresh.
    expect(
      shouldRefreshConfig({ sawConfigEvent: false, rowUpdatedAt: null, nowSec: now }),
    ).toBe(true);
    // Fresh row, quiet scan → skip (this is the steady state).
    expect(
      shouldRefreshConfig({
        sawConfigEvent: false,
        rowUpdatedAt: now - 60,
        nowSec: now,
      }),
    ).toBe(false);
    // Row older than the 6h backstop → refresh.
    expect(
      shouldRefreshConfig({
        sawConfigEvent: false,
        rowUpdatedAt: now - 7 * 3600,
        nowSec: now,
      }),
    ).toBe(true);
    // Stale-marked row (updated_at zeroed after a failed config-event
    // refresh) → the backstop math retries immediately.
    expect(
      shouldRefreshConfig({ sawConfigEvent: false, rowUpdatedAt: 0, nowSec: now }),
    ).toBe(true);
  });

  it('stale-marks (not refreshes) when a catch-up scan contains a config event', async () => {
    // Codex #1231 r2: dropping the signal here would let the pre-change
    // row serve as fresh through the whole backstop once caught up.
    const h = refreshHarness();
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, source_block, updated_at)
         VALUES (84532, '[]', '[]', 50, ?)`,
      )
      .run(Math.floor(Date.now() / 1000));
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: ['OfferCreated', 'FeesConfigSet'],
      blockNumber: 100n, // far behind…
      headBlock: 1_000n, // …the head → historic read, skip the eth_calls
    });
    expect(h.reads).toEqual([]);
    expect(h.row()?.ua).toBe(0); // …but the old row no longer looks fresh
  });

  it('lets a late older scan neither overwrite nor stale-mark a newer row', async () => {
    // Codex #1231 r2: the cursor advance is monotonic for overlapping
    // scans; the snapshot writes follow the same discipline.
    const h = refreshHarness();
    const freshAt = Math.floor(Date.now() / 1000);
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, source_block, updated_at)
         VALUES (84532, '["newer"]', '[]', 200, ?)`,
      )
      .run(freshAt);
    // Older scan, near head, saw a config event → reads happen, but the
    // guarded upsert must not replace the newer row.
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: ['FeesConfigSet'],
      blockNumber: 100n,
      headBlock: 110n,
    });
    expect(h.row()).toMatchObject({ sb: 200, bj: '["newer"]', ua: freshAt });
    // Same older scan during catch-up → the stale-mark is guarded too.
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: ['FeesConfigSet'],
      blockNumber: 100n,
      headBlock: 1_000n,
    });
    expect(h.row()?.ua).toBe(freshAt);
  });

  it('bootstraps the row from a near-head scan (happy path)', async () => {
    const h = refreshHarness();
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: [],
      blockNumber: 100n,
      headBlock: 110n,
    });
    expect(h.reads.sort()).toEqual([
      'getGraceBuckets',
      'getMasterFlags',
      'getProtocolConfigBundle',
    ]);
    expect(h.row()).toMatchObject({ sb: 100 });
    expect(JSON.parse(h.row()!.bj)).toEqual(['100', ['1', '2', '3', '4']]);
    // #2073 — the names this build decoded with are written beside the tuples.
    const names = h.db
      .prepare('SELECT bundle_names_json AS b, master_flags_names_json AS f FROM protocol_config WHERE chain_id = 84532')
      .get() as { b: string | null; f: string | null };
    expect(JSON.parse(names.b!)).toEqual(abiOutputNames('getProtocolConfigBundle'));
    expect(JSON.parse(names.f!)).toEqual(abiOutputNames('getMasterFlags'));
  });

  // #2073 (Codex #2653 r1) — names are stored only when the loupe shows
  // this build's ABI is the code that answered at the capture block.
  for (const [label, loupeHost] of [
    ['another facet hosts the getters (an in-place refresh this build predates)',
      async () => '0x00000000000000000000000000000000000000ff'],
    ['the loupe read fails', async () => { throw new Error('rpc down'); }],
  ] as const) {
    it(`withholds the names when ${label}`, async () => {
      const h = refreshHarness({ loupeHost });
      await maybeRefreshProtocolConfig({
        env: h.env,
        chainId: 84532,
        client: h.client,
        diamond: DIAMOND,
        scannedEventNames: [],
        blockNumber: 100n,
        headBlock: 110n,
      });
      // The figures are still captured; only their names are withheld.
      expect(JSON.parse(h.row()!.bj)).toEqual(['100', ['1', '2', '3', '4']]);
      const names = h.db
        .prepare('SELECT bundle_names_json AS b, master_flags_names_json AS f FROM protocol_config WHERE chain_id = 84532')
        .get() as { b: string | null; f: string | null };
      expect(names).toEqual({ b: null, f: null });
    });
  }

  it("treats the Diamond's FunctionDoesNotExist revert as a definitive empty bucket set (Codex #1298 r4)", async () => {
    // A pre-getter diamond's fallback reverts `FunctionDoesNotExist()`
    // (selector 0xa9ad62f8). That must store '[]' — getter and setter
    // ship in the same facet cut, so no getter ⇒ no buckets — NOT fall
    // into the transient branch, which would leave the column NULL and
    // re-force the three config reads on every near-head scan forever.
    const h = refreshHarness({
      graceRead: async () => {
        throw new Error(
          'The contract function "getGraceBuckets" reverted. Error: FunctionDoesNotExist() (0xa9ad62f8)',
        );
      },
    });
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: [],
      blockNumber: 100n,
      headBlock: 110n,
    });
    expect(h.row()?.gb).toBe('[]');
  });

  it('preserves a snapshotted bucket set through a transient grace-read failure', async () => {
    // Codex #1298 r3: a transient RPC hiccup must not clobber real
    // governance buckets back to defaults — COALESCE keeps the column.
    const h = refreshHarness({
      graceRead: async () => {
        throw new Error('HTTP request failed: 503');
      },
    });
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, grace_buckets_json, source_block, updated_at)
         VALUES (84532, '[]', '[]', '[{"maxDurationDays":"0","graceSeconds":"3888000"}]', 50, 0)`,
      )
      .run();
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: [],
      blockNumber: 100n,
      headBlock: 110n,
    });
    // Bundle/flags refreshed (the isolated grace failure never sinks
    // them), buckets preserved.
    expect(h.row()).toMatchObject({
      sb: 100,
      gb: '[{"maxDurationDays":"0","graceSeconds":"3888000"}]',
    });
  });

  it('invalidates (not preserves) stored buckets when the grace read fails ON a GraceBucketsUpdated scan (Codex #1298 r5)', async () => {
    // The scan proves the buckets CHANGED; a transient read failure must
    // not keep the pre-change schedule looking current — force the
    // column to NULL so the sweep defers and the unpopulated-column
    // force-refresh retries next tick.
    const h = refreshHarness({
      graceRead: async () => {
        throw new Error('HTTP request failed: 503');
      },
    });
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, grace_buckets_json, source_block, updated_at)
         VALUES (84532, '[]', '[]', '[{"maxDurationDays":"0","graceSeconds":"3888000"}]', 50, 0)`,
      )
      .run();
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: ['GraceBucketsUpdated'],
      blockNumber: 100n,
      headBlock: 110n,
    });
    expect(h.row()).toMatchObject({ sb: 100, gb: null });
  });

  it('clears stored buckets when a CATCH-UP scan carries GraceBucketsUpdated (Codex #1298 r6)', async () => {
    // The stale-mark path only zeroed updated_at; the later near-head
    // retry no longer carries the event, so a transient grace failure
    // there would COALESCE-resurrect the pre-change schedule as fresh.
    // Clearing to NULL here keeps the sweep deferred until a successful
    // read lands.
    const h = refreshHarness();
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, grace_buckets_json, source_block, updated_at)
         VALUES (84532, '[]', '[]', '[{"maxDurationDays":"0","graceSeconds":"3888000"}]', 50, ?)`,
      )
      .run(Math.floor(Date.now() / 1000));
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: ['GraceBucketsUpdated'],
      blockNumber: 100n, // far behind…
      headBlock: 1_000n, // …the head → stale-mark, no reads
    });
    expect(h.reads).toEqual([]);
    expect(h.row()).toMatchObject({ ua: 0, gb: null });
  });

  it('force-refreshes a populated row whose grace column is still NULL (Codex #1298 r3)', async () => {
    const h = refreshHarness();
    // Fresh pre-0039 row: updated_at is current, so the event/backstop
    // gates would skip — the NULL grace column alone must trigger.
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, source_block, updated_at)
         VALUES (84532, '[]', '[]', 50, ?)`,
      )
      .run(Math.floor(Date.now() / 1000));
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: [],
      blockNumber: 100n,
      headBlock: 110n,
    });
    expect(h.reads).toContain('getGraceBuckets');
    expect(h.row()?.gb).toBe('[]'); // populated — the force stops firing
  });

  it('serializes nested bigint arrays (the uint256[4] tier slots)', () => {
    // A top-level-only map left nested BigInts for JSON.stringify to
    // throw on, which fail-opened every refresh (Codex #1231 r1).
    const json = serializeTuple([
      100n,
      [1n, 2n, 3n, 4n],
      { threshold: 5_000_000_000_000_000_000n },
      true,
      'addr',
    ]);
    expect(JSON.parse(json)).toEqual([
      '100',
      ['1', '2', '3', '4'],
      { threshold: '5000000000000000000' },
      true,
      'addr',
    ]);
  });

  /**
   * The labelled view (#1664 item 3). This endpoint is public and now
   * advertised to automated consumers in `llms.txt`; an outside reader
   * has no decoder, so the positional tuple alone told them nothing.
   * The labels come from the compiled ABI, which is also what makes the
   * mismatch case load-bearing: a wrong label on a real number is worse
   * than no label, because nothing about it looks wrong.
   */
  describe('GET /config/:chainId labelled view', () => {
    /** Store one row with a bundle of the ABI's own arity. */
    /** The names a capture by THIS build records beside the tuples. */
    const BUNDLE_NAMES = abiOutputNames('getProtocolConfigBundle');
    const FLAG_NAMES = abiOutputNames('getMasterFlags');

    async function seed(
      bundle: readonly unknown[],
      names: { bundle: readonly string[] | null; flags: readonly string[] | null } = {
        bundle: BUNDLE_NAMES,
        flags: FLAG_NAMES,
      },
    ) {
      const { db, d1 } = createSqliteD1([MIGRATION_0035, MIGRATION_0039, MIGRATION_0067]);
      db.prepare(
        `INSERT INTO protocol_config
           (chain_id, bundle_json, master_flags_json, source_block, updated_at,
            bundle_names_json, master_flags_names_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        84532,
        serializeTuple(bundle),
        JSON.stringify([true, true, false]),
        1,
        2,
        names.bundle === null ? null : JSON.stringify(names.bundle),
        names.flags === null ? null : JSON.stringify(names.flags),
      );
      return { env: { DB: d1, RPC_BASE_SEPOLIA: SERVED_RPC } as unknown as Env };
    }

    /** The real bundle arity, so the ABI names line up. */
    const FULL_BUNDLE = [
      '200',
      '20',
      '200',
      '600',
      '300',
      '11000',
      '500',
      ['100', '200', '300', '400'],
      ['1000', '1500', '2000', '2400'],
      true,
      true,
      true,
      '100',
      '1800',
      '365',
    ];

    it('labels every slot by its ABI name, alongside the raw tuple', async () => {
      const { env } = await seed(FULL_BUNDLE);
      const body = (await (await handleConfigSnapshot(84532, env)).json()) as {
        bundle: unknown[];
        values?: Record<string, unknown>;
        flags?: Record<string, unknown>;
      };
      // The positional array stays — it is the apps' wire contract.
      expect(body.bundle).toEqual(FULL_BUNDLE);
      // ...and the same numbers arrive named.
      expect(body.values?.treasuryFeeBps).toBe('200');
      expect(body.values?.loanInitiationFeeBps).toBe('20');
      expect(body.values?.maxOfferDurationDays).toBe('365');
      expect(body.flags).toEqual({
        rangeAmount: true,
        rangeRate: true,
        partialFill: false,
      });
    });

    it('flags a stale-marked row so an outside consumer can skip it', async () => {
      // markStaleBelow zeroes updated_at when a catch-up scan saw a
      // governance event the row predates. The site rejects that via its
      // own freshness window; an external reader following llms.txt had
      // only a magic timestamp to infer it from (Codex #1821 r1 P2).
      const { db, d1 } = createSqliteD1([MIGRATION_0035, MIGRATION_0039, MIGRATION_0067]);
      db.prepare(
        `INSERT INTO protocol_config
           (chain_id, bundle_json, master_flags_json, source_block, updated_at, bundle_names_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(84532, serializeTuple(FULL_BUNDLE), JSON.stringify([true, true, false]), 1, 0, JSON.stringify(BUNDLE_NAMES));
      const body = (await (
        await handleConfigSnapshot(84532, { DB: d1, RPC_BASE_SEPOLIA: SERVED_RPC } as unknown as Env)
      ).json()) as { stale?: boolean; values?: Record<string, unknown> };
      expect(body.stale).toBe(true);
      // Still served — a consumer may want the last-known figures — but
      // now it is told, rather than left to read a zero stamp.
      expect(body.values?.treasuryFeeBps).toBe('200');
    });

    it('carries no stale flag on a normal row', async () => {
      const { env } = await seed(FULL_BUNDLE);
      const body = (await (await handleConfigSnapshot(84532, env)).json()) as Record<
        string,
        unknown
      >;
      expect(body).not.toHaveProperty('stale');
    });

    it('omits the labelled view rather than mislabelling a drifted row', async () => {
      // A row stored before/after an ABI arity change. Zipping by
      // position here would name a real number wrongly, and a consumer
      // has no way to detect that; an absent key they can detect.
      const { env } = await seed(FULL_BUNDLE.slice(0, 5));
      const body = (await (await handleConfigSnapshot(84532, env)).json()) as {
        bundle: unknown[];
        values?: Record<string, unknown>;
      };
      expect(body.bundle).toHaveLength(5);
      expect(body).not.toHaveProperty('values');
    });

    // #2073 — the labels are bound at capture time.
    it('labels with the names captured beside the row, not with the serving build\'s ABI', async () => {
      // A capture under an ABI whose first two outputs were the other way
      // round, at the same arity: this build's names would put each value
      // under the other's name, and equal length would not notice.
      const swapped = [...(BUNDLE_NAMES as string[])];
      [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
      const { env } = await seed(FULL_BUNDLE, { bundle: swapped, flags: FLAG_NAMES });
      const body = (await (await handleConfigSnapshot(84532, env)).json()) as {
        values?: Record<string, unknown>;
      };
      expect(body.values?.[swapped[0]]).toBe(FULL_BUNDLE[0]);
      expect(body.values?.[swapped[1]]).toBe(FULL_BUNDLE[1]);
    });

    it('withholds the labelled view for a row captured before names were recorded', async () => {
      const { env } = await seed(FULL_BUNDLE, { bundle: null, flags: null });
      const body = (await (await handleConfigSnapshot(84532, env)).json()) as Record<string, unknown>;
      expect(body.bundle).toEqual(FULL_BUNDLE);
      expect(body).not.toHaveProperty('values');
      expect(body).not.toHaveProperty('flags');
    });

    it('refuses a chain this Worker no longer indexes, even with a stored row (Codex #2653 r1)', async () => {
      const { db, d1 } = createSqliteD1([MIGRATION_0035, MIGRATION_0039, MIGRATION_0067]);
      db.prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, source_block, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(84532, serializeTuple(FULL_BUNDLE), JSON.stringify([true, true, false]), 1, 2);
      const res = await handleConfigSnapshot(84532, { DB: d1 } as unknown as Env);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'chain-not-configured' });
    });

    it('still answers on a database migration 0067 has not reached, with no labels', async () => {
      const { db, d1 } = createSqliteD1([MIGRATION_0035, MIGRATION_0039]);
      db.prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, source_block, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(84532, serializeTuple(FULL_BUNDLE), JSON.stringify([true, true, false]), 1, 2);
      const res = await handleConfigSnapshot(84532, { DB: d1, RPC_BASE_SEPOLIA: SERVED_RPC } as unknown as Env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.available).toBe(true);
      expect(body).not.toHaveProperty('values');
    });
  });

  /**
   * #2071 — the single-output settings the bundle does not carry: read at
   * the capture block, stored named, and served inside `values` with the
   * ones the chain did not answer listed in `unreported`.
   */
  describe('settings beside the bundle (#2071)', () => {
    const multicallAnswering = (answers: Record<string, unknown>) =>
      async (args: { contracts: readonly { functionName: string }[]; blockNumber?: bigint }) => {
        expect(args.blockNumber).toBe(100n);
        return args.contracts.map((c) =>
          c.functionName in answers
            ? { status: 'success', result: answers[c.functionName] }
            : { status: 'failure', error: new Error('FunctionDoesNotExist') },
        );
      };
    const refresh = (h: ReturnType<typeof refreshHarness>) =>
      maybeRefreshProtocolConfig({
        env: h.env,
        chainId: 84532,
        client: h.client,
        diamond: DIAMOND,
        scannedEventNames: [],
        blockNumber: 100n,
        headBlock: 110n,
      });
    const knobColumn = (h: ReturnType<typeof refreshHarness>) =>
      (h.db.prepare('SELECT knob_values_json AS k FROM protocol_config WHERE chain_id = 84532').get() as {
        k: string | null;
      }).k;

    it('refreshes on a setter event of a published setting', () => {
      for (const name of ['MinHealthFactorSet', 'PythOracleSet', 'PreNotifyDaysSet', 'RewardReporterConfigUpdated']) {
        expect(isConfigEventName(name), name).toBe(true);
      }
    });

    it('stores the settings the chain answered, and names the rest', async () => {
      const h = refreshHarness({
        multicall: multicallAnswering({ getMinHealthFactor: 15n * 10n ** 17n, getAutoLendEnabled: true }),
      });
      await refresh(h);
      const stored = JSON.parse(knobColumn(h)!) as { values: Record<string, unknown>; unreported: string[] };
      expect(stored.values).toEqual({ minHealthFactor: '1500000000000000000', autoLendEnabled: true });
      expect(stored.unreported).toContain('treasury');
      expect(stored.unreported).not.toContain('minHealthFactor');
    });

    it('stores nothing, not a guess, when the batched read fails', async () => {
      const h = refreshHarness({
        multicall: async () => {
          throw new Error('rpc down');
        },
      });
      await refresh(h);
      // The bundle refresh is unaffected.
      expect(JSON.parse(h.row()!.bj)).toEqual(['100', ['1', '2', '3', '4']]);
      expect(knobColumn(h)).toBeNull();
    });

    const BUNDLE_NAMES = abiOutputNames('getProtocolConfigBundle')!;
    const FULL_BUNDLE = [
      '200', '20', '200', '600', '300', '11000', '500',
      ['100', '200', '300', '400'], ['1000', '1500', '2000', '2400'],
      true, true, true, '100', '1800', '365',
    ];
    async function serve(knobs: string | null, bundleNames: readonly string[] | null = BUNDLE_NAMES) {
      const { db, d1 } = createSqliteD1([MIGRATION_0035, MIGRATION_0039, MIGRATION_0067, MIGRATION_0069]);
      db.prepare(
        `INSERT INTO protocol_config
           (chain_id, bundle_json, master_flags_json, source_block, updated_at,
            bundle_names_json, knob_values_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        84532,
        serializeTuple(FULL_BUNDLE),
        JSON.stringify([true, true, false]),
        1,
        2,
        bundleNames === null ? null : JSON.stringify(bundleNames),
        knobs,
      );
      return (await (
        await handleConfigSnapshot(84532, { DB: d1, RPC_BASE_SEPOLIA: SERVED_RPC } as unknown as Env)
      ).json()) as { values?: Record<string, unknown>; unreported?: string[] };
    }

    it('serves the settings inside the named values, with what went unreported', async () => {
      const body = await serve(
        JSON.stringify({ values: { minHealthFactor: '1500000000000000000' }, unreported: ['treasury'] }),
      );
      expect(body.values?.treasuryFeeBps).toBe('200');
      expect(body.values?.minHealthFactor).toBe('1500000000000000000');
      expect(body.unreported).toEqual(['treasury']);
    });

    it('serves no settings and no unreported list for a row that has none', async () => {
      const body = await serve(null);
      expect(body.values?.treasuryFeeBps).toBe('200');
      expect(body.values).not.toHaveProperty('minHealthFactor');
      expect(body).not.toHaveProperty('unreported');
    });

    it('withholds the settings with the values when the bundle cannot be labelled', async () => {
      const body = await serve(
        JSON.stringify({ values: { minHealthFactor: '1500000000000000000' }, unreported: [] }),
        null,
      );
      expect(body).not.toHaveProperty('values');
      expect(body).not.toHaveProperty('unreported');
    });

    it('ignores a stored column of the wrong shape', async () => {
      const body = await serve(JSON.stringify({ values: { minHealthFactor: 15 }, unreported: [] }));
      expect(body.values).not.toHaveProperty('minHealthFactor');
      expect(body).not.toHaveProperty('unreported');
    });
  });
});
