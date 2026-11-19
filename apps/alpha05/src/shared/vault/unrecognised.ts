/**
 * #3435 — "Unrecognised items": what reached the wallet's vault outside the
 * protocol, read so that it can never pass for the wallet's own assets.
 *
 * Two sources, two jobs:
 * - The index lists ARRIVALS (`GET /vaults/<chainId>/<owner>/unrecognised`):
 *   every token transfer into the vault since it was made, each kept as the
 *   token contract, its kind and its token id. Its scan is lazy, so a
 *   first answer for an old vault can say it is still checking; the page
 *   says so with the block it reached. The index is a finder, never the
 *   authority: an arrival may since have left, or been adopted.
 * - The chain decides what is shown: at one block, the vault the protocol
 *   names for this wallet must be the vault the index scanned, and each
 *   arrival is kept only while the protocol's `untrackedHolding` for it is
 *   above zero (what sits in the vault that the protocol does not count as
 *   the wallet's).
 *
 * What a token says about itself (name, symbol) is read from its contract
 * and reduced to plain text: control and direction-changing characters
 * removed, whitespace collapsed, length capped. It is shown beside the
 * contract address as text, never as a link, an image or rich text, because
 * scam airdrops put lures in exactly those fields.
 */
import type { Abi, PublicClient } from 'viem';
import { erc20Abi } from 'viem';
import { VaultDepositoryFacetABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import { answerOrNull } from '../reads/answer';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';

type Hex = `0x${string}`;

const DEPOSITORY = VaultDepositoryFacetABI as Abi;
const FACTORY = VaultFactoryFacetABI as Abi;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/i;

export type ArrivalKind = 'erc20' | 'erc721' | 'erc1155';
/** The protocol's `AssetType` positions. */
const KIND: Record<ArrivalKind, number> = { erc20: 0, erc721: 1, erc1155: 2 };

/** Pages of arrivals read before the list is said to be cut short. */
export const ARRIVAL_MAX_PAGES = 5;
/** Arrivals checked against the chain at once. */
const CHECK_BATCH = 25;
/** Characters of a token's own name or symbol shown. */
export const LABEL_MAX = 40;

/** One arrival as the index lists it. */
export interface Arrival {
  asset: Hex;
  kind: ArrivalKind;
  /** null for an ERC-20. */
  tokenId: bigint | null;
  firstBlock: number;
  lastBlock: number;
}

/** What the index says it has scanned, and what it found. */
export interface ArrivalScan {
  vault: Hex;
  scannedFromBlock: number;
  scannedToBlock: number;
  headBlock: number;
  /** The scan has reached the index's settled head. */
  complete: boolean;
  arrivals: Arrival[];
  /** Older arrivals were dropped from the index's store. */
  pruned: boolean;
  /** More pages remained than this read follows. */
  pagesCut: boolean;
}

export type ArrivalsRead = { kind: 'scan'; scan: ArrivalScan } | { kind: 'noVault' } | { kind: 'busy' };

interface WireCandidate {
  asset: unknown;
  kind: unknown;
  tokenId: unknown;
  firstBlock: unknown;
  lastBlock: unknown;
}

interface WireAnswer {
  vault: unknown;
  scannedFromBlock: unknown;
  scannedToBlock: unknown;
  headBlock: unknown;
  complete: unknown;
  candidates: unknown;
  pruned: unknown;
  nextCursor: unknown;
}

const isBlock = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= -1;
const shape = (path: string) => new IndexerUnavailable('shape', `The indexer's answer for ${path} was not in the expected shape.`);

function parseArrival(c: WireCandidate, path: string): Arrival {
  if (typeof c.asset !== 'string' || !ADDRESS.test(c.asset)) throw shape(path);
  if (c.kind !== 'erc20' && c.kind !== 'erc721' && c.kind !== 'erc1155') throw shape(path);
  if (!isBlock(c.firstBlock) || !isBlock(c.lastBlock)) throw shape(path);
  let tokenId: bigint | null = null;
  if (c.kind === 'erc20') {
    if (c.tokenId !== null) throw shape(path);
  } else {
    if (typeof c.tokenId !== 'string' || !/^[0-9]{1,78}$/.test(c.tokenId)) throw shape(path);
    tokenId = BigInt(c.tokenId);
  }
  return { asset: c.asset.toLowerCase() as Hex, kind: c.kind, tokenId, firstBlock: c.firstBlock, lastBlock: c.lastBlock };
}

/** A refusal the route answers by status: no vault (404), too many asks
 *  (429). Anything else the client could not read stays a failure. */
function refusal(e: unknown): 'noVault' | 'busy' | null {
  if (!(e instanceof IndexerUnavailable) || e.why !== 'status') return null;
  if (e.status === 404) return 'noVault';
  if (e.status === 429) return 'busy';
  return null;
}

/**
 * The index's arrivals for `owner`'s vault, following its pages up to
 * {@link ARRIVAL_MAX_PAGES}. Throws {@link IndexerUnavailable} when the index
 * cannot answer or answers out of shape (a 503 is "unavailable").
 */
export async function readArrivals(indexer: IndexerClient, chainId: number, owner: Hex, maxPages = ARRIVAL_MAX_PAGES): Promise<ArrivalsRead> {
  const base = `/vaults/${chainId}/${owner.toLowerCase()}/unrecognised`;
  let cursor: string | null = null;
  let first: WireAnswer | null = null;
  const arrivals: Arrival[] = [];
  const seen = new Set<string>();
  let pagesCut = false;
  for (let page = 0; ; page++) {
    if (page === maxPages) {
      pagesCut = true;
      break;
    }
    const path = cursor === null ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
    let a: WireAnswer;
    try {
      a = await indexer.getJson<WireAnswer>(path);
    } catch (e) {
      const r = refusal(e);
      if (r !== null && page === 0) return { kind: r };
      throw e;
    }
    if (a === null || typeof a !== 'object' || !Array.isArray(a.candidates)) throw shape(base);
    if (first === null) first = a;
    for (const c of a.candidates as WireCandidate[]) {
      const arrival = parseArrival(c, base);
      const k = arrivalKey(arrival);
      if (!seen.has(k)) {
        seen.add(k);
        arrivals.push(arrival);
      }
    }
    if (a.nextCursor === null || a.nextCursor === undefined) break;
    if (typeof a.nextCursor !== 'string' || a.nextCursor === cursor) throw shape(base);
    cursor = a.nextCursor;
  }
  const f = first!;
  if (typeof f.vault !== 'string' || !ADDRESS.test(f.vault)) throw shape(base);
  if (!isBlock(f.scannedFromBlock) || !isBlock(f.scannedToBlock) || !isBlock(f.headBlock)) throw shape(base);
  if (typeof f.complete !== 'boolean' || typeof f.pruned !== 'boolean') throw shape(base);
  return {
    kind: 'scan',
    scan: {
      vault: f.vault.toLowerCase() as Hex,
      scannedFromBlock: f.scannedFromBlock,
      scannedToBlock: f.scannedToBlock,
      headBlock: f.headBlock,
      complete: f.complete,
      arrivals,
      pruned: f.pruned,
      pagesCut,
    },
  };
}

/** One arrival's identity: its contract, kind and token. */
export function arrivalKey(a: Pick<Arrival, 'asset' | 'kind' | 'tokenId'>): string {
  return `${a.kind}:${a.asset.toLowerCase()}:${a.tokenId === null ? '' : a.tokenId.toString()}`;
}

/** Characters that change how text around them reads: C0/C1 controls,
 *  zero-width and direction marks, embeddings, overrides and isolates. */
const UNSAFE = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]`, 'gu');

/** A token's own text reduced to plain text: unsafe characters removed,
 *  whitespace collapsed, at most {@link LABEL_MAX} characters (cut with an
 *  ellipsis). null when nothing readable is left. */
export function plainLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const flat = raw.replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  const chars = Array.from(flat);
  return chars.length <= LABEL_MAX ? flat : `${chars.slice(0, LABEL_MAX - 1).join('')}…`;
}

/** An arrival the chain confirms is in the vault uncounted. */
export interface UnrecognisedItem extends Arrival {
  /** The protocol's `untrackedHolding` at the block: always above zero. */
  untracked: bigint;
  /** The token's own name and symbol, as plain text (null when unread). */
  name: string | null;
  symbol: string | null;
  /** An ERC-20's decimals (null when unread or not an ERC-20). */
  decimals: number | null;
}

export interface UnrecognisedCheck {
  block: bigint;
  /** The vault the protocol names for this wallet at the block. */
  vault: Hex | null;
  /** The index scanned a different vault than the protocol names: nothing
   *  it listed is shown. */
  vaultMismatch: boolean;
  items: UnrecognisedItem[];
  /** Arrivals whose figure could not be read at the block. */
  unread: Arrival[];
}

/**
 * The arrivals that sit in `account`'s vault uncounted, read at one block.
 * An arrival whose figure is zero (it left, or was adopted) is dropped; one
 * the chain could not answer for is listed as unread, never as clear.
 */
export async function checkUnrecognised(c: PublicClient, diamond: Hex, account: Hex, scan: ArrivalScan): Promise<UnrecognisedCheck> {
  const block = await c.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber: block };
  const raw = (await c.readContract({ address: diamond, abi: FACTORY, functionName: 'getUserVaultAddress', args: [account], ...at })) as Hex;
  const vault = ZERO.test(raw) ? null : (raw.toLowerCase() as Hex);
  if (vault === null || vault !== scan.vault.toLowerCase()) return { block, vault, vaultMismatch: vault !== null, items: [], unread: [] };
  const items: UnrecognisedItem[] = [];
  const unread: Arrival[] = [];
  for (let i = 0; i < scan.arrivals.length; i += CHECK_BATCH) {
    const batch = scan.arrivals.slice(i, i + CHECK_BATCH);
    const figures = await Promise.all(
      batch.map(
        (a) =>
          answerOrNull(
            c.readContract({ address: diamond, abi: DEPOSITORY, functionName: 'untrackedHolding', args: [account, KIND[a.kind], a.asset, a.tokenId ?? 0n], ...at }) as Promise<bigint>,
          ) as Promise<bigint | null>,
      ),
    );
    const held = batch.flatMap((a, j) => {
      const f = figures[j];
      if (f === null) {
        unread.push(a);
        return [];
      }
      return f > 0n ? [{ a, untracked: f }] : [];
    });
    items.push(...(await Promise.all(held.map(({ a, untracked }) => describe(c, a, untracked, at)))));
  }
  return { block, vault, vaultMismatch: false, items, unread };
}

const TEXT_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const;

/** A read of what an unknown contract says about itself: any failure (a
 *  revert, an answer that does not decode) is "not read", never an error
 *  for the whole list, since the contract may be built to fail. */
async function quiet<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

async function describe(c: PublicClient, a: Arrival, untracked: bigint, at: { blockNumber: bigint }): Promise<UnrecognisedItem> {
  const read = (functionName: 'name' | 'symbol') => quiet(c.readContract({ address: a.asset, abi: TEXT_ABI, functionName, ...at }) as Promise<string>);
  const [name, symbol, decimals] = await Promise.all([
    read('name'),
    read('symbol'),
    a.kind === 'erc20' ? quiet(c.readContract({ address: a.asset, abi: erc20Abi, functionName: 'decimals', ...at }) as Promise<number>) : Promise.resolve(null),
  ]);
  const dec = typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 77 ? decimals : null;
  return { ...a, untracked, name: plainLabel(name), symbol: plainLabel(symbol), decimals: dec };
}
