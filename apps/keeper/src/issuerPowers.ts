/**
 * issuerPowers.ts — the issuer powers pass (#3433): what each asset a user can
 * be offered says, in its own code, about its issuer's powers, written to the
 * shared store the apps disclose it from.
 *
 * The contracts stay uncurated (owner decision 2026-11-15). Nothing here
 * refuses an asset, and nothing on-chain reads what it writes. The checks
 * themselves are ONE rule in `@vaipakam/lib/issuerPowerChecks` (pure
 * functions over a read client), so this pass only:
 *   1. finds the assets: every lending and collateral asset of an active
 *      offer, an active loan or an unexpired signed offer (D1), and of an
 *      active auto-lend slot (`getActiveLenderIntents`, read on chain);
 *   2. picks a unit a vault holds, where one is known, for the vault transfer
 *      simulation: a loan's collateral in the borrower's vault (moved to the
 *      lender's vault, the hand-over a default makes), a rental's NFT in the
 *      lender's vault, an open offer's escrow or a funded slot's balance in its
 *      owner's vault (moved to another vault this run found);
 *   3. checks up to {@link ASSETS_PER_CHAIN} assets a chain per run, all at one
 *      block: assets never checked first, then checks made by an older checker
 *      version, then checks older than {@link RECHECK_AFTER_SEC}, oldest first;
 *   4. writes each asset in ONE D1 batch: the check row upserted, the asset's
 *      findings replaced. A reader sees the old run or the new one, never half.
 *
 * Writes the shared tables `asset_issuer_check` and `asset_issuer_finding`
 * (shared migration 0117). Before that migration is applied the pass declines
 * by name. Nothing here signs or sends: the transfer checks are `eth_call`s.
 *
 * Gated by KEEPER_ENABLED + ISSUER_POWERS_ENABLED. Ships disarmed.
 */
import { BaseError, createPublicClient, decodeErrorResult, http, RawContractError, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { LenderIntentFacetABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import {
  checkAsset,
  ISSUER_CHECKER_VERSION_V2,
  type AssetCheck,
  type CallOutcome,
  type CheckedKind,
  type IssuerReadClient,
  type VaultHolding,
} from '@vaipakam/lib/issuerPowerChecks';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { passIsArmed } from './keeper';
import type { PassTick } from './passSchedule';
import { shortErr } from './callErrors';

/** Every tick, because no staggered minute is free; the pass throttles
 *  itself ({@link scanDue}): a chain is scanned once an hour, and a scan the
 *  run deadline cut short continues on the next tick until it is through. */
export const PASS_CADENCE_SEC = 60;

/** How often a chain's assets are scanned for due checks. */
export const SCAN_INTERVAL_SEC = 60 * 60;

/** Assets checked per chain per run. */
export const ASSETS_PER_CHAIN = 50;

/** A check older than this is due again. */
export const RECHECK_AFTER_SEC = 24 * 60 * 60;

/** Lender intents read per registry page, and the most pages one run reads. */
export const INTENT_PAGE = 100n;
export const MAX_INTENT_PAGES = 20;

const ZERO = '0x0000000000000000000000000000000000000000';

const pick = (abi: unknown, names: readonly string[]): Abi =>
  (abi as Abi).filter((x) => x.type === 'function' && names.includes(x.name)) as Abi;

export const ABI = [...pick(LenderIntentFacetABI, ['getActiveLenderIntents']), ...pick(VaultFactoryFacetABI, ['getUserVaultAddress'])] as Abi;

const kindOfType = (t: number): CheckedKind => (t === 0 ? 'erc20' : t === 1 ? 'erc721' : t === 2 ? 'erc1155' : 'unknown');

const isAddress = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s) && s.toLowerCase() !== ZERO;

/** A unit a USER's vault holds; the pass resolves the user to a vault. */
export interface HeldBy {
  holder: string;
  /** The user whose vault receives it, or null for "another vault". */
  to: string | null;
  tokenId: bigint;
}

/** One asset to check, with what the platform records about it. */
export interface Candidate {
  address: string;
  kind: CheckedKind;
  held: HeldBy | null;
}

/** The stored state of one asset's last check. */
export interface StoredCheck {
  address: string;
  checkedAt: number;
  checkerVersion: string;
}

/** A store table that does not exist yet (the migration is not applied). */
export class StoreMissing extends Error {
  constructor() {
    super('the issuer powers tables do not exist yet (shared migration 0117 is not applied)');
    this.name = 'StoreMissing';
  }
}

const isNoTable = (err: unknown): boolean => /no such table/i.test(String((err as { message?: unknown } | null)?.message ?? ''));

/** Merge one more sighting of an asset: the first known kind wins, and a held
 *  unit with a named receiver beats one without. */
export function addCandidate(into: Map<string, Candidate>, address: unknown, type: number | null, held: HeldBy | null): void {
  if (!isAddress(address)) return;
  const a = address.toLowerCase();
  const kind = type === null ? 'unknown' : kindOfType(type);
  const was = into.get(a);
  if (was === undefined) {
    into.set(a, { address: a, kind, held });
    return;
  }
  if (was.kind === 'unknown' && kind !== 'unknown') was.kind = kind;
  if (held !== null && (was.held === null || (was.held.to === null && held.to !== null))) was.held = held;
}

const tokenId = (raw: unknown): bigint => {
  try {
    return BigInt(String(raw ?? '0'));
  } catch {
    return 0n;
  }
};

/** The chain's assets from D1: active offers, active loans and unexpired
 *  signed offers. */
export async function readD1Candidates(db: D1Database, chainId: number, nowSec: number, into: Map<string, Candidate>): Promise<void> {
  const offers = await db
    .prepare(
      `SELECT offer_type, creator, lending_asset, collateral_asset, asset_type, collateral_asset_type, token_id, collateral_token_id
         FROM offers WHERE chain_id = ? AND status = 'active'`,
    )
    .bind(chainId)
    .all<Record<string, unknown>>();
  for (const r of offers.results ?? []) {
    const creator = String(r['creator'] ?? '').toLowerCase();
    // A lender offer escrows what it lends; a borrower offer, its collateral.
    const lends = Number(r['offer_type']) === 0;
    const lendHeld = lends && isAddress(creator) ? { holder: creator, to: null, tokenId: tokenId(r['token_id']) } : null;
    const collHeld = !lends && isAddress(creator) ? { holder: creator, to: null, tokenId: tokenId(r['collateral_token_id']) } : null;
    addCandidate(into, r['lending_asset'], Number(r['asset_type']), lendHeld);
    addCandidate(into, r['collateral_asset'], Number(r['collateral_asset_type']), collHeld);
  }
  const loans = await db
    .prepare(
      `SELECT lender, borrower, lending_asset, collateral_asset, asset_type, collateral_asset_type, token_id, collateral_token_id
         FROM loans WHERE chain_id = ? AND status = 'active'`,
    )
    .bind(chainId)
    .all<Record<string, unknown>>();
  for (const r of loans.results ?? []) {
    const lender = String(r['lender'] ?? '').toLowerCase();
    const borrower = String(r['borrower'] ?? '').toLowerCase();
    const both = isAddress(lender) && isAddress(borrower) && lender !== borrower;
    // The collateral sits in the borrower's vault; a default hands it to the
    // lender's. A rental's NFT sits in the lender's vault.
    const assetType = Number(r['asset_type']);
    const lendHeld = both && assetType !== 0 ? { holder: lender, to: borrower, tokenId: tokenId(r['token_id']) } : null;
    const collHeld = both ? { holder: borrower, to: lender, tokenId: tokenId(r['collateral_token_id']) } : null;
    addCandidate(into, r['lending_asset'], assetType, lendHeld);
    addCandidate(into, r['collateral_asset'], Number(r['collateral_asset_type']), collHeld);
  }
  const signed = await db
    .prepare(
      `SELECT lending_asset, collateral_asset, asset_type, collateral_asset_type
         FROM signed_offers WHERE chain_id = ? AND status = 'active' AND (expires_at = 0 OR expires_at > ?) AND (deadline = 0 OR deadline > ?)`,
    )
    .bind(chainId, nowSec, nowSec)
    .all<Record<string, unknown>>();
  for (const r of signed.results ?? []) {
    addCandidate(into, r['lending_asset'], Number(r['asset_type']), null);
    addCandidate(into, r['collateral_asset'], Number(r['collateral_asset_type']), null);
  }
}

/** The stored check states for a chain; throws {@link StoreMissing} before
 *  the migration. */
export async function readStoredChecks(db: D1Database, chainId: number): Promise<Map<string, StoredCheck>> {
  try {
    const rows = await db
      .prepare('SELECT address, checked_at, checker_version FROM asset_issuer_check WHERE chain_id = ?')
      .bind(chainId)
      .all<{ address: string; checked_at: number; checker_version: string }>();
    return new Map((rows.results ?? []).map((r) => [r.address, { address: r.address, checkedAt: Number(r.checked_at), checkerVersion: r.checker_version }]));
  } catch (err) {
    if (isNoTable(err)) throw new StoreMissing();
    throw err;
  }
}

/** Which candidates this run checks, in order: never checked, then an older
 *  checker version, then due by age (oldest first). */
export function dueOrder(candidates: Iterable<Candidate>, stored: ReadonlyMap<string, StoredCheck>, nowSec: number, limit: number): Candidate[] {
  const rank = (c: Candidate): [number, number] => {
    const s = stored.get(c.address);
    if (s === undefined) return [0, 0];
    if (s.checkerVersion !== ISSUER_CHECKER_VERSION_V2) return [1, s.checkedAt];
    if (nowSec - s.checkedAt >= RECHECK_AFTER_SEC) return [2, s.checkedAt];
    return [3, s.checkedAt];
  };
  return [...candidates]
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r[0] < 3)
    .sort((x, y) => x.r[0] - y.r[0] || x.r[1] - y.r[1] || (x.c.address < y.c.address ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.c);
}

/** The D1 statements that store one asset's check: the row upserted and the
 *  findings replaced, for ONE batch. */
export function checkStatements(db: D1Database, chainId: number, address: string, blockNumber: bigint, checkedAt: number, r: AssetCheck): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO asset_issuer_check (chain_id, address, kind, checked_at, block_number, checker_version, complete, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, address) DO UPDATE SET kind = excluded.kind, checked_at = excluded.checked_at,
           block_number = excluded.block_number, checker_version = excluded.checker_version,
           complete = excluded.complete, detail = excluded.detail`,
      )
      .bind(chainId, address, r.kind, checkedAt, Number(blockNumber), ISSUER_CHECKER_VERSION_V2, r.complete ? 1 : 0, r.detail),
    db.prepare('DELETE FROM asset_issuer_finding WHERE chain_id = ? AND address = ?').bind(chainId, address),
  ];
  if (r.findings.length > 0) {
    const values = r.findings.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const binds = r.findings.flatMap((f) => [chainId, address, f.check, f.result, f.evidence, checkedAt]);
    out.push(db.prepare(`INSERT INTO asset_issuer_finding (chain_id, address, check_id, result, evidence, checked_at) VALUES ${values}`).bind(...binds));
  }
  return out;
}

// ─── The chain reads ──────────────────────────────────────────────────

/** A revert's short reason: an `Error(string)`'s text, else the error's
 *  selector; null when it carried no data. */
export function revertReason(data: Hex | undefined): string | null {
  if (data === undefined || data === '0x' || data.length < 10) return null;
  try {
    const d = decodeErrorResult({ abi: [], data });
    if (d.errorName === 'Error' && typeof d.args?.[0] === 'string') return (d.args[0] as string).slice(0, 80);
    return d.errorName;
  } catch {
    return data.slice(0, 10);
  }
}

/** The read client the checks use, bound to one block. A revert is an
 *  answer; any other failure throws. */
export function viemReadClient(client: PublicClient, blockNumber: bigint): IssuerReadClient {
  return {
    getCode: async (address) => (await client.getCode({ address, blockNumber })) ?? '0x',
    getStorageAt: async (address, slot) => (await client.getStorageAt({ address, slot, blockNumber })) ?? '0x',
    call: async ({ to, data, from }): Promise<CallOutcome> => {
      try {
        const r = await client.call({ to, data, account: from, blockNumber });
        return { kind: 'returned', data: r.data ?? '0x' };
      } catch (err) {
        const raw = err instanceof BaseError ? err.walk((e) => e instanceof RawContractError) : null;
        if (raw instanceof RawContractError) {
          const d = typeof raw.data === 'string' ? (raw.data as Hex) : (raw.data as { data?: Hex } | undefined)?.data;
          return { kind: 'reverted', reason: revertReason(d) };
        }
        throw err;
      }
    },
  };
}

/** The chain's dependencies, injected for tests. */
export interface ChainDeps {
  chainId: number;
  db: D1Database;
  /** Reads at the run's block. */
  reader: IssuerReadClient;
  blockNumber: bigint;
  /** Active auto-lend slots, with a note when the registry was cut short. */
  slots: () => Promise<{ rows: { owner: string; lendingAsset: string; collateralAsset: string }[]; note: string | null }>;
  /** The vault of a user; null when the user has none. */
  vaultOf: (user: string) => Promise<string | null>;
  nowSec: number;
  deadlineMs: number;
  check?: typeof checkAsset;
}

export interface ChainReport {
  chainId: number;
  assets: number;
  due: number;
  written: number;
  complete: number;
  failed: number;
  notes: string[];
}

/** One chain's run. */
export async function runChain(d: ChainDeps): Promise<ChainReport> {
  const report: ChainReport = { chainId: d.chainId, assets: 0, due: 0, written: 0, complete: 0, failed: 0, notes: [] };
  const stored = await readStoredChecks(d.db, d.chainId);
  const candidates = new Map<string, Candidate>();
  await readD1Candidates(d.db, d.chainId, d.nowSec, candidates);
  try {
    const s = await d.slots();
    if (s.note !== null) report.notes.push(s.note);
    for (const r of s.rows) {
      const owner = r.owner.toLowerCase();
      addCandidate(candidates, r.lendingAsset, 0, isAddress(owner) ? { holder: owner, to: null, tokenId: 0n } : null);
      addCandidate(candidates, r.collateralAsset, null, null);
    }
  } catch (err) {
    report.notes.push(`the auto-lend slots were not read (${shortErr(err)})`);
  }
  report.assets = candidates.size;
  const due = dueOrder(candidates.values(), stored, d.nowSec, ASSETS_PER_CHAIN);
  report.due = due.length;

  // Vaults: each user resolved once; "another vault" is the first vault of a
  // different user this run resolves.
  const vaults = new Map<string, string | null>();
  const vault = async (user: string): Promise<string | null> => {
    if (!vaults.has(user)) {
      let v: string | null = null;
      try {
        v = await d.vaultOf(user);
      } catch {
        v = null;
      }
      vaults.set(user, v !== null && isAddress(v) ? v.toLowerCase() : null);
    }
    return vaults.get(user) ?? null;
  };
  const users = [...new Set(due.flatMap((c) => (c.held === null ? [] : [c.held.holder, ...(c.held.to === null ? [] : [c.held.to])])))];
  const holdingOf = async (held: HeldBy | null): Promise<VaultHolding | null> => {
    if (held === null) return null;
    const from = await vault(held.holder);
    if (from === null) return null;
    let to: string | null = held.to === null ? null : await vault(held.to);
    if (to === null || to === from) {
      to = null;
      for (const u of users) {
        if (u === held.holder) continue;
        const v = await vault(u);
        if (v !== null && v !== from) {
          to = v;
          break;
        }
      }
    }
    return to === null ? null : { holder: from as Address, to: to as Address, tokenId: held.tokenId };
  };

  const check = d.check ?? checkAsset;
  for (const c of due) {
    if (Date.now() >= d.deadlineMs) {
      report.notes.push(`the run deadline passed with ${due.length - report.written - report.failed} assets left for the next run`);
      break;
    }
    try {
      const r = await check(d.reader, c.address as Address, c.kind, await holdingOf(c.held));
      await d.db.batch(checkStatements(d.db, d.chainId, c.address, d.blockNumber, d.nowSec, r));
      report.written += 1;
      if (r.complete) report.complete += 1;
    } catch (err) {
      report.failed += 1;
      if (report.failed <= 3) report.notes.push(`${c.address} was not stored (${shortErr(err)})`);
    }
  }
  return report;
}

/** Per chain: when its last scan finished, and whether it left due assets.
 *  Process memory: a restart only brings the next scan forward. */
const scans = new Map<number, { finishedMs: number; left: boolean }>();

/** Whether a chain is scanned on this tick: never scanned in this process,
 *  the last scan left due assets, or an hour has passed since it finished. */
export function scanDue(chainId: number, nowMs: number, state: ReadonlyMap<number, { finishedMs: number; left: boolean }> = scans): boolean {
  const s = state.get(chainId);
  return s === undefined || s.left || nowMs - s.finishedMs >= SCAN_INTERVAL_SEC * 1000;
}

/** Record a chain's scan. It left due assets when the deadline cut it short
 *  or it took a full share (more may be due); a scan that wrote nothing waits
 *  the interval, so a store that refuses every write is not retried each tick. */
export function noteScan(chainId: number, nowMs: number, r: ChainReport, state: Map<number, { finishedMs: number; left: boolean }> = scans): void {
  const left = r.written > 0 && (r.written + r.failed < r.due || r.due === ASSETS_PER_CHAIN);
  state.set(chainId, { finishedMs: nowMs, left });
}

export function describeChainReport(r: ChainReport): string {
  const notes = r.notes.length > 0 ? `; ${r.notes.join('; ')}` : '';
  return `[keeper] issuerPowers chain=${r.chainId} assets=${r.assets} due=${r.due} written=${r.written} complete=${r.complete} failed=${r.failed}${notes}`;
}

async function readSlots(client: PublicClient, diamond: Address, blockNumber: bigint) {
  const read = async <T>(args: readonly unknown[]): Promise<T> =>
    (await client.readContract({ address: diamond, abi: ABI, functionName: 'getActiveLenderIntents', args, blockNumber })) as T;
  const [, total] = await read<readonly [readonly unknown[], bigint]>([0n, 0n]);
  const pages = Number((total + INTENT_PAGE - 1n) / INTENT_PAGE);
  const take = Math.min(pages, MAX_INTENT_PAGES);
  const rows: { owner: string; lendingAsset: string; collateralAsset: string }[] = [];
  for (let i = 0; i < take; i++) {
    const [page] = await read<readonly [readonly Record<string, unknown>[], bigint]>([BigInt(i) * INTENT_PAGE, INTENT_PAGE]);
    for (const r of page) rows.push({ owner: String(r['owner']), lendingAsset: String(r['lendingAsset']), collateralAsset: String(r['collateralAsset']) });
  }
  return { rows, note: take < pages ? `the slot registry has ${pages} pages; ${take} were read` : null };
}

export async function runIssuerPowers(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'issuerPowers', 'ISSUER_POWERS_ENABLED')) return;
  const chains = getChainConfigs(env).filter((c) => c.diamond && scanDue(c.id, Date.now()));
  if (chains.length === 0) return;
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const client = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const diamond = chain.diamond as Address;
        const blockNumber = await client.getBlockNumber();
        const report = await runChain({
          chainId: chain.id,
          db: env.DB,
          reader: viemReadClient(client, blockNumber),
          blockNumber,
          slots: () => readSlots(client, diamond, blockNumber),
          vaultOf: async (user) => {
            const v = (await client.readContract({ address: diamond, abi: ABI, functionName: 'getUserVaultAddress', args: [user as Address], blockNumber })) as string;
            return v.toLowerCase() === ZERO ? null : v;
          },
          nowSec: Math.floor(Date.now() / 1000),
          deadlineMs: tick.deadlineMs,
        });
        noteScan(chain.id, Date.now(), report);
        console.log(describeChainReport(report));
      } catch (err) {
        if (err instanceof StoreMissing) console.log(`[keeper] issuerPowers chain=${chain.id} declined: ${err.message}`);
        else console.error(`[keeper] issuerPowers chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}
