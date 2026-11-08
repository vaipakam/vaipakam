/**
 * ACC-20, ACC-21, ACC-24: what the connected wallet's own vault holds, read
 * from the protocol's own views at one block (RB-RAILS, RB-FUNDS).
 *
 * The protocol keeps four figures per asset, and the page shows them as the
 * protocol states them, never re-deriving one from another:
 * - what sits in the vault on chain (the token's own balance for the vault);
 * - what the protocol counts as the wallet's there (the tracked holding);
 *   an asset that arrived outside the protocol is not counted until its
 *   owner adopts it (`untrackedHolding`, ACC-24);
 * - what the wallet may withdraw now (`withdrawableNow`): the protocol's own
 *   answer after every loan, offer, claim, reserve, intent and queued payout;
 * - the rest of the counted holding, which only those positions release.
 *
 * Which assets to read: the protocol lists every asset contract ever credited
 * to the wallet's deposit record (`getDepositoryAssets`, paged until its
 * stated length; an empty page before the end is never the end), and the
 * wallet's own loans and open offers name the assets a position put there.
 * An asset that reached the vault by neither route (a plain transfer) cannot
 * be found from the chain alone; the page says so instead of implying the
 * list is everything. The deposit record names an NFT collection but not its
 * token ids, so a collection is named without figures unless a loan names
 * the token.
 */
import type { Abi, PublicClient } from 'viem';
import { erc20Abi } from 'viem';
import { LoanFacetABI, VaultDepositoryFacetABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import { answerOrNull } from '../reads/answer';
import { NFT_ABI, readStandard, type Standard } from '../nft/nft';

type Hex = `0x${string}`;

const DEPOSITORY = VaultDepositoryFacetABI as Abi;
const FACTORY = VaultFactoryFacetABI as Abi;
const LOAN = LoanFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

/** The protocol's `AssetType` positions. */
const KIND: Record<Standard, number> = { erc20: 0, erc721: 1, erc1155: 2 };

/** One page of the deposit record's asset list. */
export const DEPOSITORY_PAGE = 50;
/** Pages read before the list is said to be incomplete. */
export const DEPOSITORY_MAX_PAGES = 20;

/** Why the page reads an asset. */
export type HoldingSource = 'deposit' | 'loan' | 'offer';

/** An asset the page reads: an ERC-20, or one NFT token a loan names. */
export interface HoldingSubject {
  standard: Standard;
  asset: Hex;
  /** 0 for an ERC-20. */
  tokenId: bigint;
  sources: HoldingSource[];
}

/** The protocol's figures for one subject; each null when its read had no
 *  answer (the contract reverted). */
export interface HoldingRow extends HoldingSubject {
  /** What the vault holds on chain (an ERC-721: 1 or 0). */
  inVault: bigint | null;
  /** What the protocol counts as the wallet's (the tracked holding). */
  tracked: bigint | null;
  /** What the wallet may withdraw now, after every position. */
  withdrawable: bigint | null;
  /** What sits in the vault outside the protocol's count. */
  untracked: bigint | null;
}

export interface VaultHoldings {
  /** The wallet's vault; null when it has none yet. */
  vault: Hex | null;
  rows: HoldingRow[];
  /** Every NFT collection the deposit record names: it keeps no token ids,
   *  so only tokens a position names are read, and the page says so. */
  collections: Hex[];
  /** Whether the deposit record's list was read to its end. */
  listComplete: boolean;
  /** Whether the position sources the page was given were complete. */
  positionsComplete: boolean;
  block: bigint;
}

/** The assets the wallet's positions name, by kind (from the position book
 *  and the open offers the caller already read). */
export interface PositionAssets {
  erc20: { asset: Hex; source: HoldingSource }[];
  nfts: { standard: 'erc721' | 'erc1155'; asset: Hex; tokenId: bigint; source: HoldingSource }[];
  /** Loans whose lent asset is an NFT (rentals): their prepaid fee token
   *  sits in the renter's vault without being in the deposit record, and the
   *  loan list does not carry it, so it is read from each loan. */
  rentals: bigint[];
  complete: boolean;
}

/** The deposit record's asset list, paged to its stated length. An empty page
 *  before the end, or more pages than the cap, ends the walk incomplete. */
export async function readDepositoryAssets(
  read: (offset: bigint, limit: bigint) => Promise<readonly [readonly Hex[], bigint]>,
  opts: { page: number; maxPages: number } = { page: DEPOSITORY_PAGE, maxPages: DEPOSITORY_MAX_PAGES },
): Promise<{ assets: Hex[]; complete: boolean }> {
  const assets: Hex[] = [];
  let offset = 0n;
  for (let i = 0; i < opts.maxPages; i++) {
    const [page, total] = await read(offset, BigInt(opts.page));
    assets.push(...page);
    offset += BigInt(page.length);
    if (offset >= total) return { assets, complete: true };
    if (page.length === 0) return { assets, complete: false };
  }
  return { assets, complete: false };
}

/** Every subject to read, once each: deposit-record ERC-20s, position
 *  ERC-20s and position NFT tokens, with every reason it is read. Every
 *  deposit-record NFT collection is also returned apart, to be named. */
export function holdingSubjects(deposited: readonly { asset: Hex; standard: Standard }[], positions: PositionAssets): { subjects: HoldingSubject[]; collections: Hex[] } {
  const byKey = new Map<string, HoldingSubject>();
  const add = (standard: Standard, asset: Hex, tokenId: bigint, source: HoldingSource) => {
    if (asset.toLowerCase() === ZERO) return;
    const key = `${standard}:${asset.toLowerCase()}:${tokenId.toString()}`;
    const have = byKey.get(key);
    if (have) {
      if (!have.sources.includes(source)) have.sources.push(source);
      return;
    }
    byKey.set(key, { standard, asset, tokenId, sources: [source] });
  };
  for (const d of deposited) if (d.standard === 'erc20') add('erc20', d.asset, 0n, 'deposit');
  for (const p of positions.erc20) add('erc20', p.asset, 0n, p.source);
  for (const n of positions.nfts) add(n.standard, n.asset, n.tokenId, n.source);
  // Every deposited collection is named, also one a position names a token
  // of: the record keeps no token ids, so knowing one token never shows that
  // every deposited token was found.
  const collections: Hex[] = [];
  for (const d of deposited) {
    if (d.standard === 'erc20') continue;
    if (!collections.some((c) => c.toLowerCase() === d.asset.toLowerCase())) collections.push(d.asset);
  }
  // Deposit-record NFT tokens a position names are read for their figures;
  // mark the deposit reason on them too.
  for (const s of byKey.values()) {
    if (s.standard !== 'erc20' && deposited.some((d) => d.asset.toLowerCase() === s.asset.toLowerCase()) && !s.sources.includes('deposit')) s.sources.push('deposit');
  }
  return { subjects: [...byKey.values()], collections };
}

/** The wallet's vault and every subject's figures, at one block. */
export async function readVaultHoldings(c: PublicClient, diamond: Hex, account: Hex, positions: PositionAssets): Promise<VaultHoldings> {
  const block = await c.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber: block };
  const vaultRaw = (await c.readContract({ address: diamond, abi: FACTORY, functionName: 'getUserVaultAddress', args: [account], ...at })) as Hex;
  const vault = vaultRaw.toLowerCase() === ZERO ? null : vaultRaw;
  if (vault === null) return { vault: null, rows: [], collections: [], listComplete: true, positionsComplete: positions.complete, block };
  const list = await readDepositoryAssets(
    (offset, limit) =>
      c.readContract({ address: diamond, abi: DEPOSITORY, functionName: 'getDepositoryAssets', args: [account, offset, limit], ...at }) as Promise<
        readonly [readonly Hex[], bigint]
      >,
  );
  const deposited = await Promise.all(list.assets.map(async (asset) => ({ asset, standard: await readStandard(c, asset) })));
  const prepaid = await readRentalPrepay(positions.rentals, (id) =>
    answerOrNull(c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [id], ...at }) as Promise<{ prepayAsset: Hex }>).then(
      (l) => l?.prepayAsset ?? null,
    ),
  );
  const withPrepay: PositionAssets = { ...positions, erc20: [...positions.erc20, ...prepaid.assets.map((asset) => ({ asset, source: 'loan' as const }))] };
  const { subjects, collections } = holdingSubjects(deposited, withPrepay);
  const rows = await Promise.all(subjects.map((s) => readHoldingRow(c, diamond, account, vault, s, block)));
  return { vault, rows, collections, listComplete: list.complete, positionsComplete: positions.complete && prepaid.complete, block };
}

/** The prepaid fee tokens of the wallet's rentals, read from each loan. A
 *  loan whose read had no answer makes the position sources incomplete, so
 *  the page says an asset may be missing rather than implying none. */
export async function readRentalPrepay(ids: readonly bigint[], read: (id: bigint) => Promise<Hex | null>): Promise<{ assets: Hex[]; complete: boolean }> {
  const answers = await Promise.all(ids.map((id) => read(id)));
  const assets: Hex[] = [];
  for (const a of answers) if (a !== null && a.toLowerCase() !== ZERO && !assets.some((x) => x.toLowerCase() === a.toLowerCase())) assets.push(a);
  return { assets, complete: answers.every((a) => a !== null) };
}

async function readHoldingRow(c: PublicClient, diamond: Hex, account: Hex, vault: Hex, s: HoldingSubject, block: bigint): Promise<HoldingRow> {
  const at = { blockNumber: block };
  const kind = KIND[s.standard];
  const view = (address: Hex, abi: Abi, functionName: string, args: readonly unknown[]) =>
    answerOrNull(c.readContract({ address, abi, functionName, args, ...at }) as Promise<unknown>);
  const inVault = async (): Promise<bigint | null> => {
    if (s.standard === 'erc20') return (await view(s.asset, erc20Abi as Abi, 'balanceOf', [vault])) as bigint | null;
    if (s.standard === 'erc1155') return (await view(s.asset, NFT_ABI as Abi, 'balanceOf', [vault, s.tokenId])) as bigint | null;
    const owner = (await view(s.asset, NFT_ABI as Abi, 'ownerOf', [s.tokenId])) as Hex | null;
    return owner === null ? 0n : owner.toLowerCase() === vault.toLowerCase() ? 1n : 0n;
  };
  const [held, tracked, withdrawable, untracked] = await Promise.all([
    inVault(),
    view(diamond, FACTORY, 'getTrackedHolding', [account, s.asset, s.tokenId]) as Promise<bigint | null>,
    view(diamond, DEPOSITORY, 'withdrawableNow', [account, kind, s.asset, s.tokenId]) as Promise<bigint | null>,
    view(diamond, DEPOSITORY, 'untrackedHolding', [account, kind, s.asset, s.tokenId]) as Promise<bigint | null>,
  ]);
  return { ...s, inVault: held, tracked, withdrawable, untracked };
}

/** What the page states for one row, from the protocol's figures alone. */
export interface HoldingFigures {
  /** What the protocol counts and the vault holds: the smaller of the two
   *  (an unsolicited transfer never raises it); null when either is unread. */
  counted: bigint | null;
  /** The protocol's own answer; null when unread. */
  withdrawable: bigint | null;
  /** The counted holding positions keep (counted minus withdrawable); null
   *  when either is unread. */
  held: bigint | null;
  /** In the vault outside the protocol's count; null when unread. */
  untracked: bigint | null;
  /** The vault holds LESS than the protocol counts (a token that moved the
   *  balance itself); the page shows both. */
  short: boolean;
  /** Every counted unit is kept by a position. */
  allHeld: boolean;
  /** Any figure could not be read. */
  unread: boolean;
}

export function holdingFigures(r: HoldingRow): HoldingFigures {
  const counted = r.inVault !== null && r.tracked !== null ? (r.inVault < r.tracked ? r.inVault : r.tracked) : null;
  const unread = r.inVault === null || r.tracked === null || r.withdrawable === null || r.untracked === null;
  // A row with any figure unread shows none as free or held (RB-VAULT): the
  // free and held figures are withheld, not shown beside a warning.
  const withdrawable = unread ? null : r.withdrawable;
  const held = counted !== null && withdrawable !== null && counted >= withdrawable ? counted - withdrawable : null;
  return {
    counted,
    withdrawable,
    held,
    untracked: r.untracked,
    short: r.inVault !== null && r.tracked !== null && r.inVault < r.tracked,
    allHeld: !unread && counted !== null && counted > 0n && withdrawable === 0n,
    unread,
  };
}

/** A row is dust when what it counts is above zero and below 1e-11 of a whole
 *  token (ERC-20 with known decimals only). A row with an uncounted part, or
 *  whose vault holds less than the protocol counts, is never dust: what it
 *  states is not small even when the counted figure is. */
export function isDust(r: HoldingRow, decimals: number | null): boolean {
  if (r.standard !== 'erc20' || decimals === null || decimals < 11) return false;
  const f = holdingFigures(r);
  if (f.counted === null || f.counted === 0n) return false;
  if ((f.untracked ?? 0n) > 0n || f.short) return false;
  return f.counted * 10n ** 11n < 10n ** BigInt(decimals);
}

/** Nothing of the asset is in the vault, counted or not (the deposit record
 *  keeps an asset listed after it is all withdrawn). An unread row is never
 *  empty. */
export function isEmpty(r: HoldingRow): boolean {
  const f = holdingFigures(r);
  if (f.unread) return false;
  return r.inVault === 0n && r.tracked === 0n && r.untracked === 0n;
}

/** The rows shown by default, and how many the "show small and empty"
 *  switch hides. */
export function shownRows(rows: readonly HoldingRow[], decimals: (asset: Hex) => number | null, showAll: boolean): { rows: HoldingRow[]; hidden: number } {
  const keep = rows.filter((r) => showAll || !(isEmpty(r) || isDust(r, decimals(r.asset))));
  return { rows: keep, hidden: rows.length - rows.filter((r) => !(isEmpty(r) || isDust(r, decimals(r.asset)))).length };
}

/** The assets the wallet's loans and open offers name. Loans pass every
 *  leg (a zero row is hidden as empty), so a side whose leg is not in this
 *  vault costs a read and shows nothing. A rental's prepaid fee token is a
 *  leg too (accepting a rental puts it in the renter's vault without adding
 *  it to the deposit record); the loan list does not carry it, so a loan
 *  lending an NFT is returned in `rentals` to be read. */
export function positionAssets(
  loans: readonly { id: bigint; principalAsset: Hex; assetType: number; tokenId: bigint; collateralAsset: Hex; collateralAssetType: number; collateralTokenId: bigint }[],
  offers: readonly { lendingAsset: Hex; assetType: number; tokenId: bigint; prepayAsset: Hex; collateralAsset: Hex; collateralAssetType: number; collateralTokenId: bigint }[],
  complete: boolean,
): PositionAssets {
  const erc20: PositionAssets['erc20'] = [];
  const nfts: PositionAssets['nfts'] = [];
  const rentals: bigint[] = [];
  const leg = (asset: Hex, type: number, tokenId: bigint, source: HoldingSource) => {
    if (type === KIND.erc20) erc20.push({ asset, source });
    else if (type === KIND.erc721) nfts.push({ standard: 'erc721', asset, tokenId, source });
    else if (type === KIND.erc1155) nfts.push({ standard: 'erc1155', asset, tokenId, source });
  };
  for (const l of loans) {
    leg(l.principalAsset, l.assetType, l.tokenId, 'loan');
    leg(l.collateralAsset, l.collateralAssetType, l.collateralTokenId, 'loan');
    if (l.assetType !== KIND.erc20 && !rentals.includes(l.id)) rentals.push(l.id);
  }
  for (const o of offers) {
    leg(o.lendingAsset, o.assetType, o.tokenId, 'offer');
    leg(o.collateralAsset, o.collateralAssetType, o.collateralTokenId, 'offer');
    if (o.prepayAsset.toLowerCase() !== ZERO) leg(o.prepayAsset, KIND.erc20, 0n, 'offer');
  }
  return { erc20, nfts, rentals, complete };
}
