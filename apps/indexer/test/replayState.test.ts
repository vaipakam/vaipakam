/**
 * Row 3.9 (#3411 follow-up): the index says when it is replaying, why, and
 * how far behind the safe head it is. Run against the REAL migration DDL.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { adoptDeployment, requestChainRebuild } from '../src/deploymentEpoch';
import {
  REPLAY_CAUGHT_UP_BLOCKS,
  readReplayState,
  readReplayStates,
  recordChainHead,
  unknownReplayState,
} from '../src/replayState';
import { REPLAY_ENVELOPE_KEY, withReplayEnvelope } from '../src/replayEnvelope';
import { CURSOR_KIND, SCAN_PASS_MAX_BLOCKS } from '../src/chainIndexer';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const OLD = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const NEW = '0x2535baC87F3df287268fC697F2f31cf418365303';
const BASE = 84532;

function fresh() {
  return createSqliteD1(migrations());
}

function setCursor(h: ReturnType<typeof fresh>, block: number) {
  h.db
    .prepare(
      `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, 1)
       ON CONFLICT(chain_id, kind) DO UPDATE SET last_block = excluded.last_block`,
    )
    .run(BASE, CURSOR_KIND, block);
}

describe('pinned constants', () => {
  it('the caught-up cut is one scan pass, and the cursor kind is the scan’s', () => {
    expect(BigInt(REPLAY_CAUGHT_UP_BLOCKS)).toBe(SCAN_PASS_MAX_BLOCKS);
    expect(CURSOR_KIND).toBe('diamond');
    expect(REPLAY_ENVELOPE_KEY).toBe('ingest');
  });
});

describe('the replay latch', () => {
  it('a first adoption starts a replay, stated with its reason and an unknown lag until a head is read', async () => {
    const h = fresh();
    await adoptDeployment(h.d1 as never, {
      chainId: BASE,
      diamond: NEW,
      deployBlock: 1000,
      nowSec: 5,
    });
    expect(await readReplayState(h.d1 as never, BASE)).toEqual({
      ...unknownReplayState(),
      replaying: true,
      reason: 'deployment',
    });
  });

  it('stays replaying while the cursor is more than one scan pass behind, then ends', async () => {
    const h = fresh();
    await adoptDeployment(h.d1 as never, {
      chainId: BASE,
      diamond: NEW,
      deployBlock: 1000,
      nowSec: 5,
    });
    setCursor(h, 1000);
    await recordChainHead(h.d1 as never, {
      chainId: BASE,
      safeHead: 50_000n,
      nowSec: 10,
    });
    let s = await readReplayState(h.d1 as never, BASE);
    expect(s).toMatchObject({
      replaying: true,
      reason: 'deployment',
      cursorBlock: 1000,
      safeHead: 50_000,
      safeHeadObservedAt: 10,
      lagBlocks: 49_000,
    });

    setCursor(h, 50_000 - REPLAY_CAUGHT_UP_BLOCKS);
    await recordChainHead(h.d1 as never, {
      chainId: BASE,
      safeHead: 50_000n,
      nowSec: 20,
    });
    s = await readReplayState(h.d1 as never, BASE);
    expect(s).toMatchObject({
      replaying: false,
      reason: null,
      lagBlocks: REPLAY_CAUGHT_UP_BLOCKS,
    });
  });

  it('a pass with no settled head records the head as unknown and never ends a replay on a guess', async () => {
    const h = fresh();
    await adoptDeployment(h.d1 as never, {
      chainId: BASE,
      diamond: NEW,
      deployBlock: 1000,
      nowSec: 5,
    });
    setCursor(h, 49_999);
    await recordChainHead(h.d1 as never, {
      chainId: BASE,
      safeHead: null,
      nowSec: 10,
    });
    expect(await readReplayState(h.d1 as never, BASE)).toMatchObject({
      replaying: true,
      safeHead: null,
      lagBlocks: null,
      safeHeadObservedAt: 10,
    });
  });

  it('ordinary lag after the replay ended is lag, not a replay', async () => {
    const h = fresh();
    await adoptDeployment(h.d1 as never, {
      chainId: BASE,
      diamond: NEW,
      deployBlock: 1000,
      nowSec: 5,
    });
    setCursor(h, 10_000);
    await recordChainHead(h.d1 as never, {
      chainId: BASE,
      safeHead: 10_000n,
    });
    await recordChainHead(h.d1 as never, {
      chainId: BASE,
      safeHead: 90_000n,
    });
    expect(await readReplayState(h.d1 as never, BASE)).toMatchObject({
      replaying: false,
      reason: null,
      lagBlocks: 80_000,
    });
  });

  it('a reorg rebuild starts a replay named as such, and a claimed reset reads as replaying before it lands', async () => {
    const h = fresh();
    await adoptDeployment(h.d1 as never, {
      chainId: BASE,
      diamond: NEW,
      deployBlock: 1000,
      nowSec: 5,
    });
    setCursor(h, 10_000);
    await recordChainHead(h.d1 as never, {
      chainId: BASE,
      safeHead: 10_000n,
    });
    expect(await requestChainRebuild(h.d1 as never, { chainId: BASE, diamond: NEW })).toBe(true);
    // Pending: the head write must not end it even though the cursor is caught up.
    await recordChainHead(h.d1 as never, {
      chainId: BASE,
      safeHead: 10_000n,
    });
    expect(await readReplayState(h.d1 as never, BASE)).toMatchObject({
      replaying: true,
      reason: 'rebuild',
    });
    // The next pass lands the reset; the replay stays announced as a rebuild.
    await adoptDeployment(h.d1 as never, {
      chainId: BASE,
      diamond: NEW,
      deployBlock: 1000,
      nowSec: 6,
    });
    expect(await readReplayState(h.d1 as never, BASE)).toMatchObject({
      replaying: true,
      reason: 'rebuild',
      cursorBlock: null,
      lagBlocks: null,
    });
  });

  it('a Diamond change starts a deployment replay over a finished one', async () => {
    const h = fresh();
    await adoptDeployment(h.d1 as never, {
      chainId: BASE,
      diamond: OLD,
      deployBlock: 500,
      nowSec: 5,
    });
    setCursor(h, 10_000);
    await recordChainHead(h.d1 as never, {
      chainId: BASE,
      safeHead: 10_000n,
    });
    expect((await readReplayState(h.d1 as never, BASE)).replaying).toBe(false);
    await adoptDeployment(h.d1 as never, {
      chainId: BASE,
      diamond: NEW,
      deployBlock: 9000,
      nowSec: 6,
    });
    expect(await readReplayState(h.d1 as never, BASE)).toMatchObject({
      replaying: true,
      reason: 'deployment',
    });
  });

  it('a chain without a record, or a database before migration 0099, is unknown, never "not replaying"', async () => {
    const h = fresh();
    expect(await readReplayState(h.d1 as never, BASE)).toEqual(unknownReplayState());
    const old = createSqliteD1([
      `CREATE TABLE indexer_deployment (chain_id INTEGER PRIMARY KEY, diamond TEXT NOT NULL, deploy_block INTEGER NOT NULL,
         adopted_at INTEGER NOT NULL, reset_pending INTEGER NOT NULL DEFAULT 0, adopted_blind INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE indexer_cursor (chain_id INTEGER NOT NULL, kind TEXT NOT NULL, last_block INTEGER NOT NULL,
         updated_at INTEGER NOT NULL, PRIMARY KEY (chain_id, kind))`,
    ]);
    old.db
      .prepare(`INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at) VALUES (?, ?, 1, 1)`)
      .run(BASE, NEW);
    expect((await readReplayStates(old.d1 as never)).size).toBe(0);
  });

  it('a read that fails for another reason propagates', async () => {
    const faulty = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error('D1_ERROR: internal error');
          },
        }),
      }),
    };
    await expect(readReplayStates(faulty as never)).rejects.toThrow(/internal error/);
  });
});

describe('the read envelope', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10',
        'Access-Control-Allow-Origin': '*',
      },
    });

  it('adds the chain’s replay state under `ingest`, keeping the body and the headers', async () => {
    const h = fresh();
    await adoptDeployment(h.d1 as never, {
      chainId: BASE,
      diamond: NEW,
      deployBlock: 1000,
      nowSec: 5,
    });
    const out = await withReplayEnvelope(json({ loans: [1, 2] }), h.d1 as never, BASE);
    expect(out.status).toBe(200);
    expect(out.headers.get('Cache-Control')).toBe('public, max-age=10');
    expect(out.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await out.json()).toEqual({
      loans: [1, 2],
      ingest: {
        chainId: BASE,
        ...unknownReplayState(),
        replaying: true,
        reason: 'deployment',
      },
    });
  });

  it('passes a non-200 answer and a non-object body through untouched', async () => {
    const h = fresh();
    const refused = await withReplayEnvelope(json({ error: 'chain-not-configured' }, 503), h.d1 as never, BASE);
    expect(await refused.json()).toEqual({ error: 'chain-not-configured' });
    const list = await withReplayEnvelope(json([1, 2]), h.d1 as never, BASE);
    expect(await list.json()).toEqual([1, 2]);
  });

  it('states the replay as unknown when it cannot be read, and still serves the answer', async () => {
    const faulty = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error('D1_ERROR: internal error');
          },
        }),
      }),
    };
    const out = await withReplayEnvelope(json({ offers: [] }), faulty as never, BASE);
    expect(await out.json()).toEqual({
      offers: [],
      ingest: { chainId: BASE, ...unknownReplayState() },
    });
  });
});
