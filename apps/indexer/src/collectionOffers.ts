// apps/indexer/src/collectionOffers.ts
//
// #3688 — NFT collection offers (#3328) in the indexer: the set each offer
// takes (`collection_offer_set`), the check of a listed set's published
// list against the offer, and the list store.
//
// A listed set is identified on-chain only by its root. The contract stores
// the list's count and hash as the lender gave them and never checks them,
// so the platform checks them where the list is (design section 5): the
// canonical list file's keccak256 must be the offer's `listHash`, the file
// must name the offer's `listCount` distinct ids, and the sorted standard
// tree over them must have the offer's root. One rule, in
// `@vaipakam/lib/collateralSet`, read by the indexer, the keeper, the app
// and the Console.
//
// A list of up to 256 ids arrives in the creation event. A larger one is a
// file the app posts after the creation transaction (`POST /collection-lists`).
// Anyone may post one and nothing needs authentication: the file is stored
// only when an indexed offer carries its hash, and only after it checks out
// against that offer, so the store holds nothing an offer does not name.
// Every list that checks out is kept in object storage under its hash and
// served publicly from it (`GET /collection-lists/:hash`), so anyone can
// recompute the root.
//
// A listed offer whose list is missing or does not check out is kept out of
// the default book (`bookFilterSql`); its row states which (`list_check`).

import type { Hex } from 'viem';
import { keccak256 } from 'viem';
import {
  CollateralSetKind,
  canonicalListFile,
  checkPublishedList,
  listFileHash,
  parseListFile,
  type ListProblem,
} from '@vaipakam/lib/collateralSet';
import { readBodyBytes } from '@vaipakam/lib/requestBody';
import { slotRefusalStatus, takeCallerSlot } from '@vaipakam/lib/rateLimit';
import { redactedError } from '@vaipakam/lib/errorDescription';
import type { Env } from './env';
import { isMissingSetTable } from './collectionOfferSets';
import { jsonResponse } from './offerRoutes';

/** What a row's `list_check` says. */
export type ListCheck = 'not_listed' | 'ok' | 'not_published' | ListProblem;

/** The most bytes a posted list file may have. A canonical file of a million
 *  small ids fits; one of a million 78-digit ids does not, and its lender
 *  publishes a shorter list or splits the offer. */
export const MAX_LIST_FILE_BYTES = 8 * 1024 * 1024;

/** The store key of a list file. */
export const listKey = (hash: Hex) => `lists/${hash.toLowerCase()}`;

/** A `CollectionOfferCreated` as the scan decodes it. */
export interface CollectionOfferCreated {
  offerId: bigint;
  lender: string;
  kind: number;
  perLoan: bigint;
  loans: number;
  low: bigint;
  high: bigint;
  root: Hex;
  listCount: number;
  listHash: Hex;
  label: string;
  exclusions: readonly bigint[];
  publishedIds: readonly bigint[];
}

/** The event's args as the scan's decoder hands them over. */
export function liftCollectionOfferCreated(args: Record<string, unknown>): CollectionOfferCreated {
  return {
    offerId: args['offerId'] as bigint,
    lender: String(args['lender']).toLowerCase(),
    kind: Number(args['kind']),
    perLoan: args['perLoan'] as bigint,
    loans: Number(args['loans']),
    low: args['low'] as bigint,
    high: args['high'] as bigint,
    root: args['root'] as Hex,
    listCount: Number(args['listCount']),
    listHash: args['listHash'] as Hex,
    label: String(args['label'] ?? ''),
    exclusions: (args['exclusions'] as readonly bigint[] | undefined) ?? [],
    publishedIds: (args['publishedIds'] as readonly bigint[] | undefined) ?? [],
  };
}

/** The check of an offer's list: the ids the event published, else the file
 *  the store holds under the offer's hash, else 'not_published'. Pure but
 *  for the store read, which `readStored` makes. */
export async function checkOfferList(
  ev: Pick<CollectionOfferCreated, 'kind' | 'root' | 'listCount' | 'listHash' | 'publishedIds'>,
  readStored: (hash: Hex) => Promise<bigint[] | null>,
): Promise<{ check: ListCheck; source: 'event' | 'file' | null; file: string | null }> {
  if (ev.kind !== CollateralSetKind.Listed) return { check: 'not_listed', source: null, file: null };
  const set = { root: ev.root, listCount: ev.listCount, listHash: ev.listHash };
  if (ev.publishedIds.length > 0) {
    const r = checkPublishedList(ev.publishedIds, set);
    return r.ok
      ? { check: 'ok', source: 'event', file: canonicalListFile(ev.publishedIds) }
      : { check: r.problem, source: 'event', file: null };
  }
  const stored = await readStored(ev.listHash);
  if (stored === null) return { check: 'not_published', source: null, file: null };
  const r = checkPublishedList(stored, set);
  return { check: r.ok ? 'ok' : r.problem, source: 'file', file: null };
}

/** A stored list file's ids, or null when the store does not hold one (or
 *  holds something that is not a canonical file, which it never writes). */
export async function readStoredList(env: Env, hash: Hex): Promise<bigint[] | null> {
  const store = env.COLLECTION_LISTS;
  if (!store) return null;
  const got = await store.get(listKey(hash));
  if (!got) return null;
  return parseListFile(await got.text());
}

/**
 * Record one `CollectionOfferCreated`: the set, and the check of its list.
 * A list the event published that checks out is also written to the store,
 * so every list the book shows is served the same way. Idempotent: a re-scan
 * writes the same row.
 */
export async function recordCollectionOfferCreated(
  env: Env,
  chainId: number,
  ev: CollectionOfferCreated,
  blockNumber: bigint,
  now: number,
): Promise<void> {
  const list = await checkOfferList(ev, (hash) => readStoredList(env, hash));
  if (list.file !== null && env.COLLECTION_LISTS) {
    await env.COLLECTION_LISTS.put(listKey(ev.listHash), list.file, {
      httpMetadata: { contentType: 'application/json' },
    });
  }
  await env.DB.prepare(
    `INSERT INTO collection_offer_set
       (chain_id, offer_id, lender, kind, per_loan, loans, low, high, root,
        list_count, list_hash, label, exclusions, list_check, list_source,
        block_number, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chain_id, offer_id) DO UPDATE SET
       lender = excluded.lender, kind = excluded.kind,
       per_loan = excluded.per_loan, loans = excluded.loans,
       low = excluded.low, high = excluded.high, root = excluded.root,
       list_count = excluded.list_count, list_hash = excluded.list_hash,
       label = excluded.label, exclusions = excluded.exclusions,
       list_check = excluded.list_check, list_source = excluded.list_source,
       block_number = excluded.block_number, updated_at = excluded.updated_at`,
  )
    .bind(
      chainId,
      Number(ev.offerId),
      ev.lender,
      ev.kind,
      ev.perLoan.toString(),
      ev.loans,
      ev.low.toString(),
      ev.high.toString(),
      ev.root.toLowerCase(),
      ev.listCount,
      ev.listHash.toLowerCase(),
      ev.label,
      JSON.stringify(ev.exclusions.map((x) => x.toString())),
      list.check,
      list.source,
      Number(blockNumber),
      now,
    )
    .run();
}

/** A posted file's text, decoded strictly: UTF-8 that fails to decode, or a
 *  byte-order mark, is refused rather than repaired. */
function decodeStrict(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * POST /collection-lists — a listed collection offer's list file.
 *
 * Body: the canonical list file itself. Stored only when an indexed listed
 * offer carries its hash and the file checks out against that offer (count,
 * root); every such offer's row is re-checked and the answer names them.
 * Rate-limited per caller, fail-closed, like the signed-offer route.
 */
export async function handleCollectionListPost(req: Request, env: Env): Promise<Response> {
  const refusal = slotRefusalStatus(await takeCallerSlot(req, env.COLLECTION_LISTS_RATELIMIT));
  if (refusal) return jsonResponse({ error: refusal.error }, refusal.status);
  const store = env.COLLECTION_LISTS;
  if (!store) return jsonResponse({ error: 'list-store-not-configured' }, 503);

  const read = await readBodyBytes(req, MAX_LIST_FILE_BYTES);
  if (!read.ok) return jsonResponse({ error: read.error }, read.status);
  const text = decodeStrict(read.bytes);
  const ids = text === null ? null : parseListFile(text);
  if (ids === null) return jsonResponse({ error: 'not-a-canonical-list-file' }, 400);
  if (ids.length === 0) return jsonResponse({ error: 'empty-list' }, 400);
  const hash = keccak256(read.bytes);
  // The same as `listFileHash(text)`: the text is the bytes, decoded strictly.
  if (hash !== listFileHash(text!)) return jsonResponse({ error: 'not-a-canonical-list-file' }, 400);

  try {
    const rows = await env.DB.prepare(
      `SELECT chain_id, offer_id, root, list_count, list_hash, list_check
         FROM collection_offer_set
        WHERE list_hash = ? AND kind = ?`,
    )
      .bind(hash, CollateralSetKind.Listed)
      .all<{ chain_id: number; offer_id: number; root: string; list_count: number; list_hash: string; list_check: string }>();
    const offers = rows.results ?? [];
    if (offers.length === 0) return jsonResponse({ error: 'no-offer-carries-this-list-hash', listHash: hash }, 404);

    const verdicts = offers.map((o) => {
      const r = checkPublishedList(ids, { root: o.root as Hex, listCount: o.list_count, listHash: o.list_hash as Hex });
      return { chainId: o.chain_id, offerId: o.offer_id, listCheck: (r.ok ? 'ok' : r.problem) as ListCheck };
    });
    if (!verdicts.some((v) => v.listCheck === 'ok')) {
      return jsonResponse({ error: 'list-does-not-match', listHash: hash, offers: verdicts }, 422);
    }
    await store.put(listKey(hash), text!, { httpMetadata: { contentType: 'application/json' } });
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch(
      verdicts.map((v) =>
        env.DB.prepare(
          `UPDATE collection_offer_set SET list_check = ?, list_source = 'file', updated_at = ?
            WHERE chain_id = ? AND offer_id = ? AND list_source IS NOT 'event'`,
        ).bind(v.listCheck, now, v.chainId, v.offerId),
      ),
    );
    return jsonResponse({ listHash: hash, ids: ids.length, offers: verdicts }, 201);
  } catch (err) {
    // Before migration 0097 no offer can carry a list hash yet.
    if (isMissingSetTable(err)) return jsonResponse({ error: 'list-store-not-ready' }, 503);
    console.error('[collectionOffers] list post failed', redactedError(err));
    return jsonResponse({ error: 'list-post-failed' }, 500);
  }
}

/** GET /collection-lists/:hash — a stored list file, public and immutable
 *  (the key is the file's own hash). */
export async function handleCollectionListGet(env: Env, hashRaw: string): Promise<Response> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashRaw)) return jsonResponse({ error: 'bad-list-hash' }, 400);
  const store = env.COLLECTION_LISTS;
  if (!store) return jsonResponse({ error: 'list-store-not-configured' }, 503);
  const got = await store.get(listKey(hashRaw as Hex));
  if (!got) return jsonResponse({ error: 'not-found' }, 404);
  return new Response(got.body, {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

/** CORS preflight for `/collection-lists` (the app posts from its own origin). */
export function handleCollectionListsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
