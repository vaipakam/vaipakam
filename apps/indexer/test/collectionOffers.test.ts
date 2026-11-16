/**
 * #3688 — NFT collection offers in the indexer (NftCollectionOffersDesign.md
 * s5, s12): the set row each `CollectionOfferCreated` writes, the default
 * book's filter (a listed offer stays out until its list checks out), the
 * list store's POST and GET routes, and the previous-schema tolerance every
 * HTTP handler owes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { Hex } from 'viem';
import { keccak256, stringToBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { buildTree, canonicalListFile, CollateralSetKind } from '@vaipakam/lib/collateralSet';
import type { Env } from '../src/env';
import {
  handleCollectionListGet,
  handleCollectionListPost,
  listKey,
  recordCollectionOfferCreated,
  type CollectionOfferCreated,
} from '../src/collectionOffers';
import { handleOffersActive } from '../src/offerRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const migrations = (upTo?: string) =>
  MIGRATION_FILES.filter((f) => upTo === undefined || f < upTo).map((f) =>
    readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'),
  );

const CHAIN = 84532;
const IDS = [7n, 3n, 42n, 1000n];
const FILE = canonicalListFile(IDS);
const HASH = keccak256(stringToBytes(FILE));
const ROOT = buildTree(IDS).nodes[0] as Hex;

/** An in-memory stand-in for the R2 bucket, enough for get and put. */
function fakeStore() {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      async get(key: string) {
        const v = objects.get(key);
        if (v === undefined) return null;
        return { text: async () => v, body: v };
      },
      async put(key: string, value: string) {
        objects.set(key, value);
        return {};
      },
    },
  };
}

const allowAll = { limit: async () => ({ success: true }) };

function harness(upTo?: string) {
  const h = createSqliteD1(migrations(upTo));
  const store = fakeStore();
  const env = {
    DB: h.d1,
    COLLECTION_LISTS: store.bucket,
    COLLECTION_LISTS_RATELIMIT: allowAll,
    RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
  } as unknown as Env;
  const seedOffer = (offerId: number) =>
    h.db
      .prepare(
        `INSERT INTO offers (chain_id, offer_id, status, creator, creator_current_owner, offer_type, asset_type,
           collateral_asset_type, lending_asset, collateral_asset, amount, interest_rate_bps, collateral_amount,
           duration_days, expires_at, first_seen_block, first_seen_at, updated_at)
         VALUES (?, ?, 'active', '0xc0', '0xc0', 0, 0, 1, '0xa1', '0xb1', '1000', 500, '1', 30, 0, 1, 1, 1)`,
      )
      .run(CHAIN, offerId);
  return { h, env, store, seedOffer };
}

function event(over: Partial<CollectionOfferCreated> = {}): CollectionOfferCreated {
  return {
    offerId: 1n,
    lender: '0xc0',
    kind: CollateralSetKind.Listed,
    perLoan: 1000n,
    loans: 2,
    low: 0n,
    high: 0n,
    root: ROOT,
    listCount: IDS.length,
    listHash: HASH,
    label: 'four ids',
    exclusions: [],
    publishedIds: [],
    ...over,
  };
}

const activeIds = async (env: Env, query = '') => {
  const res = await handleOffersActive(new Request(`https://x/offers/active?chainId=${CHAIN}${query}`), env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { offers: { offerId: number; collectionSet: Record<string, unknown> | null }[] };
  return body.offers;
};

const post = (env: Env, body: string) =>
  handleCollectionListPost(new Request('https://x/collection-lists', { method: 'POST', body }), env);

describe('collection offer sets in the indexer (#3688)', () => {
  it('stores a list the event published and keeps the offer in the book', async () => {
    const { env, store, seedOffer } = harness();
    seedOffer(1);
    await recordCollectionOfferCreated(env, CHAIN, event({ publishedIds: IDS }), 10n, 100);
    expect(store.objects.get(listKey(HASH))).toBe(FILE);
    const offers = await activeIds(env);
    expect(offers.map((o) => o.offerId)).toEqual([1]);
    expect(offers[0].collectionSet).toMatchObject({
      kind: 'listed',
      loans: 2,
      listCheck: 'ok',
      listSource: 'event',
      listFile: `/collection-lists/${HASH}`,
    });
  });

  it('records a published list that does not match and keeps the offer out', async () => {
    const { env, store, seedOffer } = harness();
    seedOffer(1);
    await recordCollectionOfferCreated(env, CHAIN, event({ publishedIds: [7n, 3n, 42n, 999n] }), 10n, 100);
    expect(store.objects.size).toBe(0);
    expect(await activeIds(env)).toEqual([]);
    const all = await activeIds(env, '&includeUnverifiedLists=1');
    expect(all[0].collectionSet).toMatchObject({ listCheck: 'hash', listFile: null });
  });

  it('holds an unpublished list out of the book until a matching file is posted', async () => {
    const { env, store, seedOffer } = harness();
    seedOffer(1);
    seedOffer(2); // an ordinary offer, never filtered
    await recordCollectionOfferCreated(env, CHAIN, event(), 10n, 100);
    expect((await activeIds(env)).map((o) => o.offerId)).toEqual([2]);
    const hidden = await activeIds(env, '&includeUnverifiedLists=1');
    expect(hidden.find((o) => o.offerId === 1)?.collectionSet).toMatchObject({ listCheck: 'not_published' });
    expect(hidden.find((o) => o.offerId === 2)?.collectionSet).toBeNull();

    const res = await post(env, FILE);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ listHash: HASH, ids: 4, offers: [{ offerId: 1, listCheck: 'ok' }] });
    expect(store.objects.get(listKey(HASH))).toBe(FILE);
    expect((await activeIds(env)).map((o) => o.offerId)).toEqual([2, 1]);

    const got = await handleCollectionListGet(env, HASH);
    expect(got.status).toBe(200);
    expect(got.headers.get('Cache-Control')).toContain('immutable');

    // A re-scan reads the stored file and writes the same verdict.
    await recordCollectionOfferCreated(env, CHAIN, event(), 10n, 200);
    expect((await activeIds(env)).map((o) => o.offerId)).toEqual([2, 1]);
  });

  it('refuses a file no offer names, one that does not match, and a non-canonical one', async () => {
    const { env, store, seedOffer } = harness();
    seedOffer(1);
    await recordCollectionOfferCreated(env, CHAIN, event({ listCount: 5 }), 10n, 100);

    // Matches the hash, but the offer states five ids.
    const mismatch = await post(env, FILE);
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({ offers: [{ offerId: 1, listCheck: 'count' }] });

    expect((await post(env, canonicalListFile([1n, 2n]))).status).toBe(404);
    expect((await post(env, '["3","7","42","1000"]\n')).status).toBe(400);
    expect((await post(env, '["7","3","42","1000"]')).status).toBe(400);
    expect((await post(env, '﻿' + FILE)).status).toBe(400);
    expect(store.objects.size).toBe(0);
  });

  it('refuses a post without a limiter or a store', async () => {
    const { env } = harness();
    const noLimiter = { ...env, COLLECTION_LISTS_RATELIMIT: undefined } as Env;
    expect((await post(noLimiter, FILE)).status).toBe(503);
    const noStore = { ...env, COLLECTION_LISTS: undefined } as Env;
    expect((await post(noStore, FILE)).status).toBe(503);
    expect((await handleCollectionListGet(env, 'nothex')).status).toBe(400);
  });

  it('serves the book on a database before migration 0097', async () => {
    const { env, seedOffer } = harness('0097');
    seedOffer(1);
    const offers = await activeIds(env);
    expect(offers.map((o) => o.offerId)).toEqual([1]);
    expect(offers[0].collectionSet).toBeNull();
    expect((await post(env, FILE)).status).toBe(503);
  });
});
