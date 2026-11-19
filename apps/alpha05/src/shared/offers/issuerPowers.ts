/**
 * #3433 — what the keeper's issuer-power checker last found about a token or
 * collection, read from the index (`GET /assets/issuer-powers`). The checks
 * live in one place, the keeper's pass; the app only states its results.
 *
 * A result is a fact with a date: 'found', 'not_found' (looked, did not find
 * it) or 'unknown' (could not tell). 'not_found' never means the asset is
 * safe, and nothing here says so. A check id this build does not know is
 * kept and shown as such, never dropped. An asset with no stored run reads
 * as not checked, and the app then says nothing about issuer powers.
 */
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';

type Hex = `0x${string}`;

/** The checks whose finding means the issuer can move or freeze a holder's
 *  tokens (a code upgrade can add either). Ids as the checker stores them. */
export const MOVE_OR_FREEZE = ['upgradeable_proxy', 'admin_transfer', 'freeze'] as const;

/** The check ids this build has words for. */
export const KNOWN_CHECKS = ['upgradeable_proxy', 'admin_transfer', 'freeze', 'pause', 'transfer_validator', 'soulbound', 'conduit_transfer'] as const;
export type KnownCheck = (typeof KNOWN_CHECKS)[number];

export type FindingResult = 'found' | 'not_found' | 'unknown';

export interface Finding {
  check: string;
  result: FindingResult;
  evidence: string | null;
}

export interface IssuerRun {
  kind: string;
  /** Unix seconds the checker looked. */
  checkedAt: number;
  blockNumber: number;
  /** Whether every check in the run produced found or not_found. */
  complete: boolean;
  detail: string | null;
  checks: Finding[];
}

export type IssuerRead = { kind: 'checked'; run: IssuerRun } | { kind: 'notChecked' };

function shape(message: string): never {
  throw new IndexerUnavailable('shape', message);
}

const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const RESULTS: readonly unknown[] = ['found', 'not_found', 'unknown'];

/** One asset's last run. Throws the index's own failure, or a shape failure
 *  when the answer is not for the asset asked about. */
export async function readIssuerPowers(indexer: IndexerClient, chainId: number, asset: Hex): Promise<IssuerRead> {
  const address = asset.toLowerCase();
  const body = await indexer.getJson<{ chainId?: unknown; assets?: unknown; notChecked?: unknown }>(`/assets/issuer-powers?chainId=${chainId}&address=${address}`);
  if (body.chainId !== chainId) shape('The index answered for another network.');
  if (!Array.isArray(body.assets) || !Array.isArray(body.notChecked)) shape('The issuer checks were not readable.');
  const row = (body.assets as Record<string, unknown>[]).find((a) => typeof a?.address === 'string' && a.address.toLowerCase() === address);
  if (!row) {
    if ((body.notChecked as unknown[]).some((a) => typeof a === 'string' && a.toLowerCase() === address)) return { kind: 'notChecked' };
    shape('The index did not answer for this asset.');
  }
  if (!isWhole(row.checkedAt) || !isWhole(row.blockNumber) || typeof row.complete !== 'boolean' || typeof row.kind !== 'string') {
    shape('An issuer check carried no readable date, block or state.');
  }
  if (!Array.isArray(row.checks)) shape('An issuer check carried no findings.');
  const checks = (row.checks as Record<string, unknown>[]).map((f): Finding => {
    if (typeof f?.check !== 'string' || !RESULTS.includes(f.result)) shape('An issuer finding was not readable.');
    return { check: f.check, result: f.result as FindingResult, evidence: typeof f.evidence === 'string' ? f.evidence : null };
  });
  return {
    kind: 'checked',
    run: {
      kind: row.kind as string,
      checkedAt: row.checkedAt as number,
      blockNumber: row.blockNumber as number,
      complete: row.complete as boolean,
      detail: typeof row.detail === 'string' ? row.detail : null,
      checks,
    },
  };
}

export function isKnownCheck(id: string): id is KnownCheck {
  return (KNOWN_CHECKS as readonly string[]).includes(id);
}

/** What a run says, grouped for the reader. */
export interface IssuerSummary {
  /** A move-or-freeze power was found. */
  canMoveOrFreeze: boolean;
  found: string[];
  unknown: string[];
  notFound: string[];
}

export function summarise(run: IssuerRun): IssuerSummary {
  const ids = (r: FindingResult) => run.checks.filter((c) => c.result === r).map((c) => c.check);
  const found = ids('found');
  return {
    canMoveOrFreeze: found.some((c) => (MOVE_OR_FREEZE as readonly string[]).includes(c)),
    found,
    unknown: ids('unknown'),
    notFound: ids('not_found'),
  };
}
