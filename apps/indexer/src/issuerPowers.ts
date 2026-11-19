/**
 * `GET /assets/issuer-powers?chainId=<token chain>[&address=<0x…>]` — what
 * the keeper machine's issuer-power checker last found about each token or
 * collection on one chain (#3433).
 *
 * WHAT IT IS FOR. A vault can lose an asset, or be unable to move it,
 * without any protocol call: an issuer that can claw tokens back, force or
 * freeze transfers, pause the token or replace its code; a collection whose
 * transfer validator can block the platform's conduit. The contracts stay
 * uncurated (owner decision 2026-11-15), so the checker runs off-chain and
 * writes migration 0117's two tables; this route only reads them, beside
 * the market-cap rankings (`/assets/rankings`, #3446).
 *
 * WHAT IT STATES — facts, never a verdict:
 *  - per asset: what the checker took it to be (`kind`), when it looked
 *    (`checkedAt`, `blockNumber`), which list of checks it applied
 *    (`checkerVersion`), whether every check ran (`complete`, with `detail`
 *    when not), and each check's result with its evidence.
 *  - `not_found` means the checker looked and did not find that power. It
 *    never means the asset is safe, and nothing here says so.
 *  - a check id this build does not know is still returned, marked
 *    `known: false`, so a newer checker's finding is never dropped.
 *  - with `address`, an asset that has no row comes back in `notChecked`:
 *    "never checked" is stated, not left for the caller to infer from an
 *    empty list.
 *  - `currentCheckerVersion` is the list this build carries, so a reader
 *    can tell a run made under an older list.
 *
 * `chainId` is the TOKEN's chain, not a Vaipakam deployment, and is
 * required (see `parseTokenChainId`).
 *
 * D1 only, dispatched before `resolveEnv` (index.ts) like the rankings.
 * Before 0117 is applied the tables do not exist and the route answers 503
 * `unavailable`, never an empty list. Cached for an hour.
 */
import { redactedError } from '@vaipakam/lib/errorDescription';
import { ISSUER_CHECKER_VERSION, isKnownIssuerCheck } from '@vaipakam/lib/issuerPowers';
import { parseTokenChainId } from './assetRankings';

/** The narrow D1 surface this route reads. */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

interface CheckRow {
  address: string;
  kind: string;
  checked_at: number;
  block_number: number;
  checker_version: string;
  complete: number;
  detail: string | null;
}

interface FindingRow {
  address: string;
  check_id: string;
  result: string;
  evidence: string | null;
  checked_at: number;
}

export interface IssuerFinding {
  check: string;
  result: string;
  evidence: string | null;
  /** False when this build does not know the check id (a newer checker's). */
  known: boolean;
}

export interface IssuerPowersAsset {
  /** Lowercase 0x address on the requested chain. */
  address: string;
  kind: string;
  checkedAt: number;
  blockNumber: number;
  checkerVersion: string;
  /** True only when every check in the run's list produced found / not_found. */
  complete: boolean;
  detail: string | null;
  checks: IssuerFinding[];
}

export interface IssuerPowers {
  chainId: number;
  currentCheckerVersion: string;
  assets: IssuerPowersAsset[];
  /** Requested addresses with no stored run: never checked. */
  notChecked: string[];
}

const HEADERS: HeadersInit = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3600',
};

/** Parse the optional `address`; undefined when absent, null when malformed. */
export function parseAssetAddress(raw: string | null): string | undefined | null {
  if (raw === null) return undefined;
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
}

/** Read one chain's results, or one asset's. Throws when the tables cannot be read. */
export async function readIssuerPowers(db: D1Like, chainId: number, address?: string): Promise<IssuerPowers> {
  const where = address === undefined ? 'chain_id = ?' : 'chain_id = ? AND address = ?';
  const binds = address === undefined ? [chainId] : [chainId, address];
  const [checks, findings] = await Promise.all([
    db
      .prepare(
        `SELECT address, kind, checked_at, block_number, checker_version, complete, detail FROM asset_issuer_check WHERE ${where} ORDER BY address`,
      )
      .bind(...binds)
      .all<CheckRow>(),
    db
      .prepare(`SELECT address, check_id, result, evidence, checked_at FROM asset_issuer_finding WHERE ${where} ORDER BY address, check_id`)
      .bind(...binds)
      .all<FindingRow>(),
  ]);

  const byAddress = new Map<string, IssuerPowersAsset>();
  for (const r of checks.results ?? []) {
    byAddress.set(r.address, {
      address: r.address,
      kind: r.kind,
      checkedAt: r.checked_at,
      blockNumber: r.block_number,
      checkerVersion: r.checker_version,
      complete: r.complete === 1,
      detail: r.detail,
      checks: [],
    });
  }
  for (const f of findings.results ?? []) {
    const asset = byAddress.get(f.address);
    // The writer replaces an asset's findings in the same batch as its row,
    // so a finding from another run (or one with no asset row) is not
    // presented as part of this run.
    if (!asset || f.checked_at !== asset.checkedAt) continue;
    asset.checks.push({ check: f.check_id, result: f.result, evidence: f.evidence, known: isKnownIssuerCheck(f.check_id) });
  }

  const notChecked = address !== undefined && !byAddress.has(address) ? [address] : [];
  return { chainId, currentCheckerVersion: ISSUER_CHECKER_VERSION, assets: [...byAddress.values()], notChecked };
}

/** The route. `db` is the shared D1 binding. */
export async function handleAssetIssuerPowers(req: Request, db: D1Like): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const chainId = parseTokenChainId(params.get('chainId'));
  if (chainId === null) {
    return new Response(JSON.stringify({ error: 'chainId is required: the token chain id, a positive integer' }), {
      status: 400,
      headers: HEADERS,
    });
  }
  const address = parseAssetAddress(params.get('address'));
  if (address === null) {
    return new Response(JSON.stringify({ error: 'address must be a 0x-prefixed 20-byte hex address' }), { status: 400, headers: HEADERS });
  }
  try {
    return new Response(JSON.stringify(await readIssuerPowers(db, chainId, address)), { headers: HEADERS });
  } catch (err) {
    // Before migration 0117 the tables are missing; any other read failure
    // is the same answer: the results cannot be stated now.
    console.error('[indexer] /assets/issuer-powers read failed', redactedError(err));
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { ...HEADERS, 'Cache-Control': 'no-store' },
    });
  }
}
