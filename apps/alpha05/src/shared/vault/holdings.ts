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
 * protocol's other per-wallet records name the assets a position put there:
 * every loan the wallet was ever a party to, every offer it ever created
 * (an offer's escrow stays in its creator's vault whoever holds its
 * position), and every standing offer it owns. Each is an append-only list
 * kept by the wallet that made the record, never one that follows a
 * position token. An asset that reached the vault by neither route (a plain transfer) cannot
 * be found from the chain alone; the page says so instead of implying the
 * list is everything. The deposit record names an NFT collection but not its
 * token ids, so a collection is named without figures unless a loan names
 * the token.
 */
import type { Abi, PublicClient } from 'viem';
import { erc20Abi } from 'viem';
import { LenderIntentFacetABI, LoanFacetABI, MetricsFacetABI, OfferCancelFacetABI, VaultDepositoryFacetABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import { answerOrNull } from '../reads/answer';
import { NFT_ABI, readStandard, type Standard } from '../nft/nft';

type Hex = `0x${string}`;

const DEPOSITORY = VaultDepositoryFacetABI as Abi;
const FACTORY = VaultFactoryFacetABI as Abi;
const INTENT = LenderIntentFacetABI as Abi;
const LOAN = LoanFacetABI as Abi;
const METRICS = MetricsFacetABI as Abi;
const OFFER = OfferCancelFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

/** The protocol's `AssetType` positions. */
const KIND: Record<Standard, number> = { erc20: 0, erc721: 1, erc1155: 2 };

/** One page of the deposit record's asset list. */
export const DEPOSITORY_PAGE = 50;
/** Pages read before the list is said to be incomplete. */
export const DEPOSITORY_MAX_PAGES = 20;

/** Why the page reads an asset. */
export type HoldingSource = 'deposit' | 'loan' | 'offer' | 'intent';

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
  collections: { asset: Hex; standard: Standard }[];
  /** Whether the deposit record's list was read to its end. */
  listComplete: boolean;
  /** Whether the position sources the page was given were complete. */
  positionsComplete: boolean;
  block: bigint;
}

/** What the caller already read of the wallet's positions: the assets its
 *  open offers name, and the loans it holds a position in now (the position
 *  book). Each loan's legs are read from the loan's own record at the
 *  holdings block, together with every loan the wallet was ever a party to. */
export interface PositionAssets {
  erc20: { asset: Hex; source: HoldingSource }[];
  nfts: { standard: 'erc721' | 'erc1155'; asset: Hex; tokenId: bigint; source: HoldingSource }[];
  loanIds: bigint[];
  complete: boolean;
}

/** One loan's record, as far as its legs go. */
export interface LoanLegs {
  principalAsset: Hex;
  assetType: number;
  tokenId: bigint;
  collateralAsset: Hex;
  collateralAssetType: number;
  collateralTokenId: bigint;
  prepayAsset: Hex;
}

/** A list the protocol pages (`(offset, limit) -> (page, total)`), read to its
 *  stated length. An empty page before the end, or more pages than the cap,
 *  ends the walk incomplete. */
export async function readPagedList<T>(
  read: (offset: bigint, limit: bigint) => Promise<readonly [readonly T[], bigint]>,
  opts: { page: number; maxPages: number } = { page: DEPOSITORY_PAGE, maxPages: DEPOSITORY_MAX_PAGES },
): Promise<{ assets: T[]; complete: boolean }> {
  const assets: T[] = [];
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
export function holdingSubjects(
  deposited: readonly { asset: Hex; standard: Standard }[],
  positions: PositionAssets,
): { subjects: HoldingSubject[]; collections: { asset: Hex; standard: Standard }[] } {
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
  const collections: { asset: Hex; standard: Standard }[] = [];
  for (const d of deposited) {
    if (d.standard === 'erc20') continue;
    if (!collections.some((c) => c.asset.toLowerCase() === d.asset.toLowerCase())) collections.push({ asset: d.asset, standard: d.standard });
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
  const list = await readPagedList<Hex>(
    (offset, limit) =>
      c.readContract({ address: diamond, abi: DEPOSITORY, functionName: 'getDepositoryAssets', args: [account, offset, limit], ...at }) as Promise<
        readonly [readonly Hex[], bigint]
      >,
  );
  const deposited = await Promise.all(list.assets.map(async (asset) => ({ asset, standard: await readStandard(c, asset) })));
  // Every loan the wallet was ever a party to (the protocol's append-only
  // record: a position sold or handed over leaves the assets the loan put in
  // this vault where they are), and every loan it holds a position in now.
  const history = await readPagedList<bigint>(
    (offset, limit) =>
      c.readContract({ address: diamond, abi: METRICS, functionName: 'getUserLoansPaginated', args: [account, offset, limit], ...at }) as Promise<
        readonly [readonly bigint[], bigint]
      >,
  );
  const ids = [...new Set([...history.assets, ...positions.loanIds].map((id) => id.toString()))].map((id) => BigInt(id));
  const records = await readLoanLegs(ids, (id) =>
    answerOrNull(c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [id], ...at }) as Promise<LoanLegs>),
  );
  const legs = loanAssets(records.loans);
  // Every offer the wallet ever created: its escrow was pulled into this
  // vault, and stays here when the offer's position token changes hands.
  const offerIds = await readPagedList<bigint>(
    (offset, limit) =>
      c.readContract({ address: diamond, abi: METRICS, functionName: 'getUserOffersPaginated', args: [account, offset, limit], ...at }) as Promise<
        readonly [readonly bigint[], bigint]
      >,
  );
  const offerRecords = await readLoanLegs(offerIds.assets, async (id) => {
    const o = await answerOrNull(c.readContract({ address: diamond, abi: OFFER, functionName: 'getOffer', args: [id], ...at }) as Promise<OfferRecord>);
    return o === null ? null : offerLegs(o);
  });
  const made = loanAssets(offerRecords.loans, 'offer');
  // Every standing offer the wallet owns, cancelled ones too: funding one
  // puts its lent asset in this vault without adding it to the deposit
  // record, and a cancelled one can still hold capital.
  const intents = await readPagedList<IntentRow>(
    (offset, limit) =>
      c.readContract({ address: diamond, abi: INTENT, functionName: 'getLenderIntentsByOwner', args: [account, offset, limit], ...at }) as Promise<
        readonly [readonly IntentRow[], bigint]
      >,
  );
  const all: PositionAssets = {
    erc20: [...legs.erc20, ...made.erc20, ...intentAssets(intents.assets), ...positions.erc20],
    nfts: [...legs.nfts, ...made.nfts, ...positions.nfts],
    loanIds: ids,
    complete: positions.complete,
  };
  const { subjects, collections } = holdingSubjects(deposited, all);
  const rows = await Promise.all(subjects.map((s) => readHoldingRow(c, diamond, account, vault, s, block)));
  return {
    vault,
    rows,
    collections,
    listComplete: list.complete,
    positionsComplete: positions.complete && history.complete && records.complete && offerIds.complete && offerRecords.complete && intents.complete,
    block,
  };
}

/** Each loan's record; a loan whose read had no answer makes the position
 *  sources incomplete, so the page says an asset may be missing rather than
 *  implying none. */
export async function readLoanLegs(ids: readonly bigint[], read: (id: bigint) => Promise<LoanLegs | null>): Promise<{ loans: LoanLegs[]; complete: boolean }> {
  const answers = await Promise.all(ids.map((id) => read(id)));
  return { loans: answers.filter((a): a is LoanLegs => a !== null), complete: answers.every((a) => a !== null) };
}

/** Every leg the loans name: the lent asset, the collateral, and a rental's
 *  prepaid fee token (accepting a rental puts it in the renter's vault
 *  without adding it to the deposit record). A zero row is hidden as empty,
 *  so a side whose leg is not in this vault costs a read and shows nothing. */
export function loanAssets(loans: readonly LoanLegs[], source: HoldingSource = 'loan'): Pick<PositionAssets, 'erc20' | 'nfts'> {
  const erc20: PositionAssets['erc20'] = [];
  const nfts: PositionAssets['nfts'] = [];
  for (const l of loans) {
    leg(erc20, nfts, l.principalAsset, l.assetType, l.tokenId, source);
    leg(erc20, nfts, l.collateralAsset, l.collateralAssetType, l.collateralTokenId, source);
    if (l.prepayAsset.toLowerCase() !== ZERO) leg(erc20, nfts, l.prepayAsset, KIND.erc20, 0n, source);
  }
  return { erc20, nfts };
}

/** An offer's record, as far as its legs go. */
export interface OfferRecord {
  lendingAsset: Hex;
  assetType: number;
  tokenId: bigint;
  collateralAsset: Hex;
  collateralAssetType: number;
  collateralTokenId: bigint;
  prepayAsset: Hex;
}

/** An offer's legs in a loan record's shape, so one rule reads both. */
export function offerLegs(o: OfferRecord): LoanLegs {
  return {
    principalAsset: o.lendingAsset,
    assetType: o.assetType,
    tokenId: o.tokenId,
    collateralAsset: o.collateralAsset,
    collateralAssetType: o.collateralAssetType,
    collateralTokenId: o.collateralTokenId,
    prepayAsset: o.prepayAsset,
  };
}

/** A standing offer as the owner's list returns it, as far as discovery
 *  goes. */
export interface IntentRow {
  intent: { lendingAsset: Hex };
  active: boolean;
}

/** The lent asset of every standing offer the wallet owns, active or not:
 *  its capital sits in this vault under the offer's lien. */
export function intentAssets(rows: readonly IntentRow[]): PositionAssets['erc20'] {
  return rows.map((r) => ({ asset: r.intent.lendingAsset, source: 'intent' as const }));
}

function leg(erc20: PositionAssets['erc20'], nfts: PositionAssets['nfts'], asset: Hex, type: number, tokenId: bigint, source: HoldingSource): void {
  if (type === KIND.erc20) erc20.push({ asset, source });
  else if (type === KIND.erc721) nfts.push({ standard: 'erc721', asset, tokenId, source });
  else if (type === KIND.erc1155) nfts.push({ standard: 'erc1155', asset, tokenId, source });
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
 *  token (ERC-20 with known decimals only). A row with an uncounted part, a
 *  vault holding less than the protocol counts, or any figure unread is never
 *  dust: what it states (or cannot state) is not small even when the counted
 *  figure is. */
export function isDust(r: HoldingRow, decimals: number | null): boolean {
  if (r.standard !== 'erc20' || decimals === null || decimals < 11) return false;
  const f = holdingFigures(r);
  if (f.counted === null || f.counted === 0n) return false;
  if (f.unread || (f.untracked ?? 0n) > 0n || f.short) return false;
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

/** What the caller read of the wallet's positions: the legs of its open
 *  offers (the lent asset, the collateral, a rental's prepaid fee token), and
 *  the ids of the loans it holds a position in, whose legs are read from the
 *  loans' own records. */
export function positionAssets(
  heldLoans: readonly { id: bigint }[],
  offers: readonly { lendingAsset: Hex; assetType: number; tokenId: bigint; prepayAsset: Hex; collateralAsset: Hex; collateralAssetType: number; collateralTokenId: bigint }[],
  complete: boolean,
): PositionAssets {
  const erc20: PositionAssets['erc20'] = [];
  const nfts: PositionAssets['nfts'] = [];
  for (const o of offers) {
    leg(erc20, nfts, o.lendingAsset, o.assetType, o.tokenId, 'offer');
    leg(erc20, nfts, o.collateralAsset, o.collateralAssetType, o.collateralTokenId, 'offer');
    if (o.prepayAsset.toLowerCase() !== ZERO) leg(erc20, nfts, o.prepayAsset, KIND.erc20, 0n, 'offer');
  }
  return { erc20, nfts, loanIds: heldLoans.map((l) => l.id), complete };
}
