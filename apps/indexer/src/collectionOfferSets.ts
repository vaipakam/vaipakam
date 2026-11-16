// apps/indexer/src/collectionOfferSets.ts
//
// #3688 — the read side of `collection_offer_set` that the offer routes use:
// the default book's filter (a listed collection offer stays out until its
// list checks out) and the `collectionSet` each offer's JSON carries. Kept
// apart from `collectionOffers.ts` (the writer and the list routes) so the
// offer routes depend on it without a cycle.

import { CollateralSetKind } from '@vaipakam/lib/collateralSet';
import type { Env } from './env';

/** The book's default filter: an offer that is a listed collection offer
 *  stays out unless its list checks out. A SQL condition on `offers`. */
/** True for the error D1 raises before migration 0097 is applied. Every HTTP
 *  handler must tolerate the previous schema (the migrations land before the
 *  code, but a request can still meet an older database), and before 0097
 *  there is no collection offer to describe or filter. */
export function isMissingSetTable(err: unknown): boolean {
  return /no such table: collection_offer_set/i.test(String((err as Error)?.message ?? err));
}

export const bookFilterSql = `NOT EXISTS (
  SELECT 1 FROM collection_offer_set c
   WHERE c.chain_id = offers.chain_id AND c.offer_id = offers.offer_id
     AND c.kind = ${CollateralSetKind.Listed} AND c.list_check <> 'ok')`;

interface SetRow {
  offer_id: number;
  kind: number;
  per_loan: string;
  loans: number;
  low: string;
  high: string;
  root: string;
  list_count: number;
  list_hash: string;
  label: string;
  exclusions: string;
  list_check: string;
  list_source: string | null;
}

/** The set of each collection offer among `offerIds`, keyed by offer id, as
 *  the offer JSON carries it (`collectionSet`; null for any other offer). */
export async function collectionSets(
  env: Env,
  chainId: number,
  offerIds: readonly number[],
): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  if (offerIds.length === 0) return out;
  try {
    await readSets(env, chainId, offerIds, out);
  } catch (err) {
    if (!isMissingSetTable(err)) throw err;
  }
  return out;
}

async function readSets(
  env: Env,
  chainId: number,
  offerIds: readonly number[],
  out: Map<number, Record<string, unknown>>,
): Promise<void> {
  // D1 binds at most 100 parameters per statement.
  for (let i = 0; i < offerIds.length; i += 90) {
    const chunk = offerIds.slice(i, i + 90);
    const rows = await env.DB.prepare(
      `SELECT offer_id, kind, per_loan, loans, low, high, root, list_count,
              list_hash, label, exclusions, list_check, list_source
         FROM collection_offer_set
        WHERE chain_id = ? AND offer_id IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(chainId, ...chunk)
      .all<SetRow>();
    for (const r of rows.results ?? []) out.set(r.offer_id, setJson(r));
  }
}

function setJson(r: SetRow): Record<string, unknown> {
  let exclusions: string[] = [];
  try {
    exclusions = JSON.parse(r.exclusions) as string[];
  } catch {
    // An unreadable column states no exclusions rather than failing the page.
  }
  const listed = r.kind === CollateralSetKind.Listed;
  return {
    kind: r.kind === CollateralSetKind.Collection ? 'collection' : r.kind === CollateralSetKind.Range ? 'range' : 'listed',
    perLoan: r.per_loan,
    loans: r.loans,
    low: r.kind === CollateralSetKind.Range ? r.low : null,
    high: r.kind === CollateralSetKind.Range ? r.high : null,
    root: listed ? r.root : null,
    listCount: listed ? r.list_count : null,
    listHash: listed ? r.list_hash : null,
    // The label is the lender's description; nothing checks it against the ids.
    label: r.label,
    exclusions,
    listCheck: r.list_check,
    listSource: r.list_source,
    // Where anyone can read the list and recompute the root.
    listFile: listed && r.list_check === 'ok' ? `/collection-lists/${r.list_hash}` : null,
  };
}
