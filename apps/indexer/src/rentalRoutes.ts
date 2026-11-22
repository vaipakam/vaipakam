/**
 * #3882 — the two rental reads of the public data feed (ProjectKitDesign.md
 * §6 and §12), served at `/public/v1/rentals/by-collection` and
 * `/public/v1/rentals/may-use`:
 *
 *   by-collection  each active rental of ONE collection (optionally one
 *                  token): rental id, token id, user, expiry, quantity and
 *                  the owner of the vault holding the item; paginated by
 *                  rental id.
 *   may-use        the active rentals in ONE collection that name ONE
 *                  address as user (optionally one token).
 *
 * WHY THEY ARE PUBLIC. Every row restates one `VaultRentalUpdated` event,
 * which the chain already publishes; an ERC-721 renter can also be read from
 * the owner's vault. The routes are a convenience over that data. They do not
 * hide who rents: by-collection lists every renter of a collection.
 *
 * WHAT THEY NEVER DO. Each reads `rental_rights` and nothing else, so it can
 * never join anything the platform keeps for a wallet (alert links,
 * subscriptions, settings). Each takes exactly one collection, and may-use
 * exactly one user: a repeated parameter, a list or a wildcard is refused.
 * `publicFeedContract.test.ts` holds both.
 *
 * ACTIVE is judged at `activeAt`, the time of the answer (`isActiveRental`):
 * an expiry is a time, not an event, so a rental past its expiry is not
 * active even when the indexer has seen no block since. The feed envelope's
 * `asOf` names the block the clearings are known through.
 */
import { type Env } from './env';
import { redactedError } from '@vaipakam/lib/errorDescription';
import { chainNotServed, requestedChainId } from './servedChain';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID_RE = /^\d{1,78}$/;
const CURSOR_RE = /^\d{1,18}$/;

/** Rows per by-collection page. */
export const RENTALS_PAGE = 200;
/** The most rentals may-use returns for one user in one collection. */
export const MAY_USE_CAP = 500;

const UINT256_LIMIT = 2n ** 256n;

function json(body: unknown, status = 200, cacheSeconds = 30): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  });
}

/**
 * The single value of `name`, or a refusal. A repeated parameter (a list in
 * disguise), a comma list or a wildcard fails `re`, so the refusal is the
 * same for all of them.
 */
function one(url: URL, name: string, re: RegExp, required: boolean): { value: string | null } | { refusal: Response } {
  const all = url.searchParams.getAll(name);
  if (all.length === 0) {
    return required ? { refusal: json({ error: 'missing-parameter', parameter: name }, 400, 60) } : { value: null };
  }
  if (all.length > 1 || !re.test(all[0])) {
    return { refusal: json({ error: 'one-value-required', parameter: name }, 400, 60) };
  }
  return { value: all[0] };
}

/** A token id as stored: decimal, no leading zeros, within uint256. */
function tokenIdOf(raw: string | null): string | null | undefined {
  if (raw === null) return null;
  const v = BigInt(raw);
  return v < UINT256_LIMIT ? v.toString() : undefined;
}

interface RentalDbRow {
  loan_id: number;
  token_id: string;
  owner: string;
  user: string;
  expires: number;
  quantity: string;
}

function rentalOf(r: RentalDbRow) {
  return {
    rentalId: String(r.loan_id),
    tokenId: r.token_id,
    user: r.user,
    expires: r.expires,
    quantity: r.quantity,
    owner: r.owner,
  };
}

/** GET /rentals/by-collection?chainId=&collection=[&tokenId=][&cursor=] */
export async function handleRentalsByCollection(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  const collection = one(url, 'collection', ADDRESS_RE, true);
  if ('refusal' in collection) return collection.refusal;
  const tokenRaw = one(url, 'tokenId', TOKEN_ID_RE, false);
  if ('refusal' in tokenRaw) return tokenRaw.refusal;
  const cursor = one(url, 'cursor', CURSOR_RE, false);
  if ('refusal' in cursor) return cursor.refusal;
  const tokenId = tokenIdOf(tokenRaw.value);
  if (tokenId === undefined) return json({ error: 'one-value-required', parameter: 'tokenId' }, 400, 60);

  const activeAt = Math.floor(Date.now() / 1000);
  try {
    const res = await env.DB.prepare(
      `SELECT loan_id, token_id, owner, user, expires, quantity
         FROM rental_rights
        WHERE chain_id = ? AND collection = ? AND (? IS NULL OR token_id = ?)
          AND quantity <> '0' AND expires > ? AND loan_id > ?
        ORDER BY loan_id
        LIMIT ?`,
    )
      .bind(
        chainId,
        collection.value!.toLowerCase(),
        tokenId,
        tokenId,
        activeAt,
        cursor.value === null ? -1 : Number(cursor.value),
        RENTALS_PAGE + 1,
      )
      .all<RentalDbRow>();
    const rows = res.results ?? [];
    const page = rows.slice(0, RENTALS_PAGE);
    return json({
      collection: collection.value!.toLowerCase(),
      tokenId,
      activeAt,
      rentals: page.map(rentalOf),
      nextCursor: rows.length > RENTALS_PAGE ? String(page[page.length - 1].loan_id) : null,
    });
  } catch (err) {
    console.error('[rentals] by-collection read failed', redactedError(err));
    return json({ error: 'rentals-unavailable' }, 503, 0);
  }
}

/** GET /rentals/may-use?chainId=&collection=&user=[&tokenId=] */
export async function handleRentalsMayUse(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  const collection = one(url, 'collection', ADDRESS_RE, true);
  if ('refusal' in collection) return collection.refusal;
  const user = one(url, 'user', ADDRESS_RE, true);
  if ('refusal' in user) return user.refusal;
  const tokenRaw = one(url, 'tokenId', TOKEN_ID_RE, false);
  if ('refusal' in tokenRaw) return tokenRaw.refusal;
  const tokenId = tokenIdOf(tokenRaw.value);
  if (tokenId === undefined) return json({ error: 'one-value-required', parameter: 'tokenId' }, 400, 60);

  const activeAt = Math.floor(Date.now() / 1000);
  try {
    const res = await env.DB.prepare(
      `SELECT loan_id, token_id, owner, user, expires, quantity
         FROM rental_rights
        WHERE chain_id = ? AND collection = ? AND user = ? AND (? IS NULL OR token_id = ?)
          AND quantity <> '0' AND expires > ?
        ORDER BY loan_id
        LIMIT ?`,
    )
      .bind(
        chainId,
        collection.value!.toLowerCase(),
        user.value!.toLowerCase(),
        tokenId,
        tokenId,
        activeAt,
        MAY_USE_CAP + 1,
      )
      .all<RentalDbRow>();
    const rows = res.results ?? [];
    return json({
      collection: collection.value!.toLowerCase(),
      user: user.value!.toLowerCase(),
      tokenId,
      activeAt,
      rentals: rows.slice(0, MAY_USE_CAP).map(rentalOf),
      // True when the address holds more than the cap in this collection;
      // the list then holds the first MAY_USE_CAP by rental id.
      truncated: rows.length > MAY_USE_CAP,
    });
  } catch (err) {
    console.error('[rentals] may-use read failed', redactedError(err));
    return json({ error: 'rentals-unavailable' }, 503, 0);
  }
}
