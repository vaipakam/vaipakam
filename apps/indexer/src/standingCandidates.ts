/**
 * #3720 — the standing lender offers a borrow preview can be pointed at.
 *
 *   GET /offers/standing-candidates?chainId=&lendingAsset=&collateralAsset=
 *       &durationDays=[&amount=][&borrower=][&limit=]
 *
 * The platform's `StandingOfferCheckFacet` checks ONE standing offer the
 * caller points to (`checkForAmount`, `checkAgainstRequest`) and never says
 * an offer is the best on the book (IntegratorFeeShareDesign.md §7). A
 * front end finds the offers to point it at here: the open lender offers on
 * the same pair and term, lowest rate first.
 *
 * A CANDIDATE LIST, NEVER A VERDICT. The index can lag the chain and does
 * not run the acceptance checks, so every answer says the chain's check
 * decides, and the app shows "a better standing offer exists" only for an
 * offer the chain checked.
 *
 * WHAT IS LISTED. Open, unexpired lender offers on exactly the pair and the
 * term (the check refuses any other term as "different terms"), token for
 * token, read back from the chain (no stub), not a loan's sale or offset
 * vehicle, and not the borrower's own. With `amount`, only offers whose open
 * amount is exactly that: a direct accept lends an offer's whole open amount,
 * and the check answers any other amount "not comparable".
 */
import { type Env } from './env';
import { redactedError } from '@vaipakam/lib/errorDescription';
import { chainNotServed, requestedChainId } from './servedChain';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** Rows read before the exact-amount filter, lowest rate first. */
const SCAN = 200;

export const STANDING_CANDIDATES_NOTICE =
  'Candidates from the index, lowest rate first. Not a verdict: the platform’s own check decides whether an offer can be taken and whether it beats a quote. Not the best on the book.';

interface CandidateRow {
  offer_id: number;
  creator: string;
  interest_rate_bps: number;
  amount: string;
  amount_max: string;
  amount_filled: string;
  collateral_amount: string;
  expires_at: number;
}

/** An offer's open amount: its maximum (or its amount, for one with no range) less what is filled. */
export function openAmount(r: Pick<CandidateRow, 'amount' | 'amount_max' | 'amount_filled'>): bigint | null {
  const num = /^\d+$/;
  if (!num.test(r.amount) || !num.test(r.amount_max) || !num.test(r.amount_filled)) return null;
  const whole = r.amount_max === '0' ? BigInt(r.amount) : BigInt(r.amount_max);
  const open = whole - BigInt(r.amount_filled);
  return open > 0n ? open : 0n;
}

function json(body: unknown, status = 200, cacheSeconds = 10): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  });
}

/** `GET /offers/standing-candidates` */
export async function handleStandingCandidates(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  const p = url.searchParams;
  const lending = p.get('lendingAsset') ?? '';
  const collateral = p.get('collateralAsset') ?? '';
  if (!ADDRESS.test(lending) || !ADDRESS.test(collateral)) return json({ error: 'bad-asset' }, 400);
  const daysRaw = p.get('durationDays') ?? '';
  if (!/^\d{1,5}$/.test(daysRaw) || Number(daysRaw) < 1) return json({ error: 'bad-duration' }, 400);
  const durationDays = Number(daysRaw);
  const amountRaw = p.get('amount');
  if (amountRaw !== null && !/^\d{1,78}$/.test(amountRaw)) return json({ error: 'bad-amount' }, 400);
  const amount = amountRaw === null ? null : BigInt(amountRaw);
  const borrowerRaw = p.get('borrower');
  if (borrowerRaw !== null && !ADDRESS.test(borrowerRaw)) return json({ error: 'bad-borrower' }, 400);
  const limitRaw = p.get('limit');
  const limit = limitRaw === null ? DEFAULT_LIMIT : /^\d{1,2}$/.test(limitRaw) ? Number(limitRaw) : 0;
  if (limit < 1 || limit > MAX_LIMIT) return json({ error: 'bad-limit' }, 400);

  const now = Math.floor(Date.now() / 1000);
  try {
    const rows = await env.DB.prepare(
      `SELECT offer_id, creator, interest_rate_bps, amount, amount_max, amount_filled,
              collateral_amount, expires_at
         FROM offers
        WHERE chain_id = ? AND status = 'active' AND offer_type = 0 AND is_stub = 0
          AND lending_asset = ? AND collateral_asset = ? AND duration_days = ?
          AND asset_type = 0 AND collateral_asset_type = 0
          AND is_sale_vehicle = 0 AND is_offset_vehicle = 0
          AND (? IS NULL OR lower(creator) <> ?)
          AND (expires_at = 0 OR expires_at > ?)
        ORDER BY interest_rate_bps ASC, offer_id ASC
        LIMIT ?`,
    )
      .bind(
        chainId,
        lending.toLowerCase(),
        collateral.toLowerCase(),
        durationDays,
        borrowerRaw,
        borrowerRaw?.toLowerCase() ?? null,
        now,
        SCAN,
      )
      .all<CandidateRow>();
    const candidates = [];
    for (const r of rows.results ?? []) {
      const open = openAmount(r);
      if (open === null || open === 0n) continue;
      if (amount !== null && open !== amount) continue;
      candidates.push({
        offerId: r.offer_id,
        creator: r.creator,
        rateBps: r.interest_rate_bps,
        openAmount: open.toString(),
        collateralAmount: r.collateral_amount,
        expiresAt: r.expires_at === 0 ? null : r.expires_at,
      });
      if (candidates.length === limit) break;
    }
    return json({
      chainId,
      lendingAsset: lending.toLowerCase(),
      collateralAsset: collateral.toLowerCase(),
      durationDays,
      amount: amount?.toString() ?? null,
      candidates,
      notice: STANDING_CANDIDATES_NOTICE,
    });
  } catch (err) {
    console.error('[standingCandidates] read failed', redactedError(err));
    return json({ error: 'candidates-unavailable' }, 503, 0);
  }
}
