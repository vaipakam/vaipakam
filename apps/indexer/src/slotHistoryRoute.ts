/**
 * GET /loans/slot-history
 *   ?chainId=84532&owner=0x..&lendingAsset=0x..&collateralAsset=0x..&slot=0
 *
 * One Auto-lend slot's history card, computed here once (`slotHistory.ts`
 * holds the rules). Pure D1 over the decoded-event ledger and the loans
 * table; open CORS, like every `/loans/*` read, since every row derives from
 * public on-chain events.
 *
 * → {
 *     chainId, owner, lendingAsset, collateralAsset, slot,
 *     basis: 'past-loans-not-a-forecast',
 *     terms: { state, minRateBps, maxDurationDays, minFillAmount, maxExposure,
 *              maxInitLtvBps, lendUntil, termsSince, lastChangedAt },
 *     lentShare: { available: true, periodStart, periodEnd, daysOfRecord,
 *                  shareBps | null, fundedSeconds }
 *              | { available: false, periodStart, periodEnd, daysOfRecord, reason },
 *     rates: { periodStart, periodEnd, slotMinimumBps,
 *              minLoans, minBorrowers,
 *              comparison: { enough: true, loanCount, borrowerCount,
 *                             lowestBps, highestBps, halfAmountBps }
 *                        | { enough: false },
 *              excluded: { selfLoans, belowMinimumFill, partiesUnknown },
 *              truncated },
 *   }
 *
 * 404 `slot-not-indexed` when the ledger holds no readable set for the slot
 * (its terms are then unknown, so nothing can be compared against them);
 * 400 on a malformed parameter; 503 when the chain is not indexed here.
 */
import { redactedError } from '@vaipakam/lib/errorDescription';
import type { Env } from './env';
import { chainNotServed, requestedChainId } from './servedChain';
import {
  COMPARABLE_SCAN_CAP,
  MIN_COMPARABLE_BORROWERS,
  MIN_COMPARABLE_LOANS,
  SLOT_EVENT_SCAN_CAP,
  SLOT_HISTORY_WINDOW_DAYS,
  SLOT_LEDGER_SCAN_CAP,
  compareRates,
  lentSharePeriod,
  lentShareFrom,
  slotTermsFrom,
  type ComparableCandidate,
  type LentShare,
  type SlotEventRow,
  type SlotKey,
  type SlotLedgerRow,
} from './slotHistory';

const ADDRESS = /^0x[0-9a-f]{40}$/;
/** `LibVaipakam.MAX_INTENT_SLOTS` is far below this; the bound only keeps a
 *  malformed value out of the SQL. */
const MAX_SLOT = 255;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

/** The slot the request names, or null when any part is malformed. */
export function parseSlotKey(url: URL): SlotKey | null {
  const owner = url.searchParams.get('owner')?.toLowerCase() ?? '';
  const lendingAsset = url.searchParams.get('lendingAsset')?.toLowerCase() ?? '';
  const collateralAsset = url.searchParams.get('collateralAsset')?.toLowerCase() ?? '';
  const rawSlot = url.searchParams.get('slot');
  const slot = rawSlot !== null && /^\d{1,3}$/.test(rawSlot) ? Number(rawSlot) : NaN;
  if (!ADDRESS.test(owner) || !ADDRESS.test(lendingAsset) || !ADDRESS.test(collateralAsset)) return null;
  if (!Number.isInteger(slot) || slot > MAX_SLOT) return null;
  return { owner, lendingAsset, collateralAsset, slot };
}

/* The statements below are spelled out in full, not built from shared
 * fragments, so the SQL-vs-schema guard prepares each one. The owner
 * expression and the kind conditions are spelled exactly as migration
 * 0114's partial indexes, so the planner can use them. */

function slotBinds(k: SlotKey): (string | number)[] {
  return [k.owner, k.lendingAsset, k.collateralAsset, k.slot];
}

export async function handleSlotHistory(req: Request, env: Env, nowSec = Math.floor(Date.now() / 1000)): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const key = parseSlotKey(url);
  if (!key) return json({ error: 'bad-slot' }, 400);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    const termRows = await env.DB.prepare(
      `SELECT kind, block_number, log_index, block_at, args_json
         FROM activity_events
        WHERE chain_id = ? AND kind IN ('LenderIntentSet', 'LenderIntentCancelled')
          AND lower(json_extract(args_json, '$.owner')) = ?
          AND lower(json_extract(args_json, '$.lendingAsset')) = ?
          AND lower(json_extract(args_json, '$.collateralAsset')) = ?
          AND CAST(json_extract(args_json, '$.slot') AS INTEGER) = ?
        ORDER BY block_number DESC, log_index DESC
        LIMIT ?`,
    )
      .bind(chainId, ...slotBinds(key), SLOT_EVENT_SCAN_CAP + 1)
      .all<SlotEventRow>();
    const events = termRows.results ?? [];
    const termsTruncated = events.length > SLOT_EVENT_SCAN_CAP;
    const terms = slotTermsFrom(termsTruncated ? events.slice(0, SLOT_EVENT_SCAN_CAP) : events);
    if (!terms) return json({ error: 'slot-not-indexed' }, 404);

    const ratesFrom = nowSec - SLOT_HISTORY_WINDOW_DAYS * 86_400;
    const period = lentSharePeriod(terms, nowSec);
    const [loanRows, beforeRows, withinRows] = await env.DB.batch([
      env.DB.prepare(
        `SELECT l.loan_id, l.init_rate_bps, l.init_principal,
                json_extract(ae.args_json, '$.lender') AS init_lender,
                json_extract(ae.args_json, '$.borrower') AS init_borrower
           FROM loans l
           LEFT JOIN activity_events ae
             ON ae.chain_id = l.chain_id AND ae.loan_id = l.loan_id AND ae.kind = 'LoanInitiated'
          WHERE l.chain_id = ? AND l.lending_asset = ? AND l.collateral_asset = ?
            AND l.start_at >= ?
            AND l.init_terms_unbacked = 0 AND l.init_principal_unbacked = 0
            AND l.is_sale_vehicle = 0 AND l.asset_type = 0 AND l.collateral_asset_type = 0
            AND l.init_duration_days <= ?
          ORDER BY l.start_at DESC, l.loan_id DESC
          LIMIT ?`,
      ).bind(
        chainId,
        key.lendingAsset,
        key.collateralAsset,
        ratesFrom,
        terms.maxDurationDays,
        COMPARABLE_SCAN_CAP + 1,
      ),
      env.DB.prepare(
        `SELECT block_number, log_index, block_at, args_json
           FROM activity_events
          WHERE chain_id = ? AND kind = 'SlotLedgerSet'
            AND lower(json_extract(args_json, '$.owner')) = ?
            AND lower(json_extract(args_json, '$.lendingAsset')) = ?
            AND lower(json_extract(args_json, '$.collateralAsset')) = ?
            AND CAST(json_extract(args_json, '$.slot') AS INTEGER) = ?
            AND block_at <= ?
          ORDER BY block_number DESC, log_index DESC
          LIMIT 1`,
      ).bind(chainId, ...slotBinds(key), period.periodStart),
      env.DB.prepare(
        `SELECT block_number, log_index, block_at, args_json
           FROM activity_events
          WHERE chain_id = ? AND kind = 'SlotLedgerSet'
            AND lower(json_extract(args_json, '$.owner')) = ?
            AND lower(json_extract(args_json, '$.lendingAsset')) = ?
            AND lower(json_extract(args_json, '$.collateralAsset')) = ?
            AND CAST(json_extract(args_json, '$.slot') AS INTEGER) = ?
            AND block_at > ? AND block_at <= ?
          ORDER BY block_number ASC, log_index ASC
          LIMIT ?`,
      ).bind(chainId, ...slotBinds(key), period.periodStart, period.periodEnd, SLOT_LEDGER_SCAN_CAP + 1),
    ]);

    // One row per loan: a ledger holding two opening rows for one loan
    // (never expected) must not count it twice.
    const seen = new Set<number>();
    const candidates: ComparableCandidate[] = [];
    const rawLoans = (loanRows.results ?? []) as ComparableCandidate[];
    const truncated = rawLoans.length > COMPARABLE_SCAN_CAP;
    for (const row of truncated ? rawLoans.slice(0, COMPARABLE_SCAN_CAP) : rawLoans) {
      if (seen.has(row.loan_id)) continue;
      seen.add(row.loan_id);
      candidates.push(row);
    }
    const { comparison, excluded } = compareRates(candidates, terms.minFillAmount);

    const within = (withinRows.results ?? []) as SlotLedgerRow[];
    let lentShare: LentShare;
    if (termsTruncated || within.length > SLOT_LEDGER_SCAN_CAP) {
      lentShare = { available: false, ...period, reason: 'record-too-long' };
    } else {
      const before = ((beforeRows.results ?? []) as SlotLedgerRow[])[0] ?? null;
      lentShare = lentShareFrom(terms, before, within, nowSec);
    }

    return json({
      chainId,
      ...key,
      basis: 'past-loans-not-a-forecast',
      terms,
      lentShare,
      rates: {
        periodStart: ratesFrom,
        periodEnd: nowSec,
        slotMinimumBps: terms.minRateBps,
        minLoans: MIN_COMPARABLE_LOANS,
        minBorrowers: MIN_COMPARABLE_BORROWERS,
        comparison,
        excluded,
        truncated,
      },
    });
  } catch (err) {
    console.error('[slotHistory] read failed', redactedError(err));
    return json({ error: 'slot-history-failed' }, 500);
  }
}
